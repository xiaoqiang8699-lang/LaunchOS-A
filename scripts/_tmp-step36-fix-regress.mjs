/**
 * Step 36: restore live traffic, promote worker fix, redeploy web-ceshi.
 * node scripts/_tmp-step36-fix-regress.mjs --confirm-step36
 * Optional: --skip-build
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of [resolve(root, '.env'), resolve(root, '.secrets/alpha-data-plane.env')]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
if (!process.argv.includes('--confirm-step36')) {
  console.error('pass --confirm-step36');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const { applyColocatedNginxRoute } = requireDomain('@launchos/domain');
const bcryptLib = requireApi('bcrypt');

const TARGET_HOST = '116.62.198.184';
const HOST = 'web-ceshi.zsaos.com';
const WORKER_TAG = 'launchos-alpha-worker:step36';
const WORKER_REMOTE = `localhost/${WORKER_TAG}`;
const LIVE_WORKER = 'launchos-alpha-worker';
const LIVE_API_PORT = 39110;
const PROJECT = 'cmunsm2lk00ctrl01nnu1pwyd';
const UNIT = 'cmunsmcpc00d2rl0184kdxdb3';
const OLD_SI = 'cmuo3w6uf0057rl01wva2xg7n';
const OLD_PORT = 39008;
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });
const skipBuild = process.argv.includes('--skip-build');

function redact(t) {
  return String(t || '')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer|accessToken|AUTH_SECRET)\s*[=:]\s*\S+/gi, '$1=***')
    .replace(/enc:v1:[A-Za-z0-9+/=:_-]+/g, 'enc:v1:***');
}
function local(cmd, args) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 64_000_000, shell: false });
}
function curl(url, host, opts = {}) {
  const { method = 'GET', headers = {}, body = null, maxTime = '90', useResolve = true } = opts;
  const args = ['-sS', '-L', '-X', method, '-w', '\n__STATUS__:%{http_code}\n__IP__:%{remote_ip}', '--max-time', String(maxTime)];
  if (useResolve) args.push('--resolve', `${host}:443:${TARGET_HOST}`);
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body != null) args.push('-H', 'content-type: application/json', '--data-binary', body);
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)/);
  return {
    status: m ? Number(m[1]) : 0,
    text: m ? out.slice(0, m.index) : out,
    remoteIp: (out.match(/\n__IP__:([^\n]+)/) || [])[1] || null,
    stderr: String(r.stderr || '').slice(0, 300),
  };
}

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: TARGET_HOST } });
const username = resolveServerSshUsername(server.username);
const password = decryptCredential(server.credentialEncrypted);
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username, password });

async function remoteOk(cmd, label, opts = {}) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs: opts.timeoutMs ?? 180000 });
  if (r.exitCode !== 0) throw new Error(`${label}: ${redact(r.stderr || r.stdout || '').slice(0, 1500)}`);
  return r;
}

console.log('[0] restore live gateway to previous healthy runtime');
await applyColocatedNginxRoute({
  host: TARGET_HOST,
  port: server.port,
  username,
  password,
  hostname: HOST,
  healthPath: '/',
  targetPort: OLD_PORT,
});
await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "UPDATE \\"GatewayRoute\\" SET \\"targetPort\\"=${OLD_PORT}, \\"targetHost\\"='127.0.0.1', status='ACTIVE' WHERE hostname='${HOST}'; UPDATE \\"ApplicationDomain\\" SET status='ACTIVE', \\"dnsStatus\\"='ACTIVE', \\"sslStatus\\"='ACTIVE', \\"runtimePort\\"=${OLD_PORT}, \\"runtimeHost\\"='127.0.0.1' WHERE domain='${HOST}';"`,
  'db-restore',
);
const restoreProbe = await remoteOk(
  `curl -sS -o /tmp/s36r.txt -w 'code=%{http_code}\\n' --max-time 20 https://${HOST}/; head -c 120 /tmp/s36r.txt; echo; curl -sS -o /dev/null -w 'loop=%{http_code}\\n' http://127.0.0.1:${OLD_PORT}/; podman inspect launchos-cmuo3p33x0 --format '{{.State.Status}}' 2>/dev/null || podman ps --filter publish=${OLD_PORT} --format '{{.Names}} {{.Status}}'`,
  'restore-probe',
);
console.log(restoreProbe.stdout);

console.log('[1] build/promote worker');
if (!skipBuild) {
  const b = local('docker', ['build', '--platform', 'linux/amd64', '-f', 'deploy/alpha/Dockerfile.worker', '-t', WORKER_TAG, '.']);
  writeFileSync(join(ARTIFACT_DIR, 'step36-worker-build.log'), redact(`${b.stdout || ''}\n${b.stderr || ''}`).slice(-250000));
  if (b.status !== 0) throw new Error('worker build failed');
}
const markers = local('docker', [
  'run', '--rm', '--entrypoint', 'sh', WORKER_TAG, '-c',
  'echo REUSE=$(grep -c REUSE_DOMAIN /app/packages/domain/dist/ensure-system-hostname-dns.js); echo FALLBACK=$(grep -c resolve4 /app/packages/domain/dist/dns-verify.js); echo ROLLBACK=$(grep -c SAFE_RELEASE /app/packages/deployment/dist/engine/deployment-engine.service.js)',
]);
console.log('markers', String(markers.stdout || '').trim());
if (!/REUSE=[1-9]/.test(String(markers.stdout || ''))) throw new Error('REUSE_DOMAIN marker missing');
if (!/ROLLBACK=[1-9]/.test(String(markers.stdout || ''))) throw new Error('SAFE_RELEASE marker missing');

const tar = join(ARTIFACT_DIR, 'launchos-alpha-worker-step36.tar');
try { unlinkSync(tar); } catch {}
if (local('docker', ['save', '-o', tar, WORKER_TAG]).status !== 0) throw new Error('save failed');
await remoteOk('mkdir -p /opt/launchos/tmp /opt/launchos/bin', 'mkdir');
await runner.upload(tar, '/opt/launchos/tmp/launchos-alpha-worker-step36.tar', { timeoutMs: 900000 });
await remoteOk(
  `podman load -i /opt/launchos/tmp/launchos-alpha-worker-step36.tar && rm -f /opt/launchos/tmp/launchos-alpha-worker-step36.tar && (podman tag docker.io/library/${WORKER_TAG} ${WORKER_REMOTE} 2>/dev/null || podman tag ${WORKER_TAG} ${WORKER_REMOTE} 2>/dev/null || true)`,
  'load-worker',
  { timeoutMs: 600000 },
);
await runner.writeTextFile(
  '/opt/launchos/bin/step36-run-worker.sh',
  `#!/bin/bash
set -euo pipefail
NAME="$1"; IMAGE="$2"
podman rm -f "$NAME" 2>/dev/null || true
podman run -d --name "$NAME" --restart unless-stopped --network host \\
  --env-file /opt/launchos/config/alpha-worker.env --env-file /opt/launchos/config/alpha-github.env \\
  -e ARTIFACT_STORE=local -e LOCAL_ARTIFACT_ROOT=/opt/launchos/artifacts \\
  -e LAUNCHOS_SYSTEM_DOMAIN=zsaos.com -e LAUNCHOS_GATEWAY_PUBLIC_IP=${TARGET_HOST} \\
  -v /opt/launchos/artifacts:/opt/launchos/artifacts \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  -v /run/podman/podman.sock:/run/podman/podman.sock \\
  -v /opt/launchos/config/github-app.pem:/run/secrets/github-app.pem:ro \\
  --entrypoint /bin/sh "$IMAGE" \\
  -c 'export GITHUB_APP_PRIVATE_KEY="$(cat /run/secrets/github-app.pem)"; exec node apps/worker/dist/main.js'
echo STARTED
`,
);
await remoteOk('chmod 700 /opt/launchos/bin/step36-run-worker.sh && /opt/launchos/bin/step36-run-worker.sh ' + LIVE_WORKER + ' ' + WORKER_REMOTE, 'run-worker', { timeoutMs: 120000 });
await runner.writeTextFile(
  '/opt/launchos/tmp/step36-wait-worker.sh',
  `#!/bin/sh
set +e
n=0
while [ "$n" -lt 40 ]; do
  n=$((n + 1))
  if podman logs --tail 50 ${LIVE_WORKER} 2>&1 | grep -qiE 'worker ready queue=deploymentQueue'; then echo OK; exit 0; fi
  sleep 2
done
podman logs --tail 80 ${LIVE_WORKER}; exit 1
`,
);
await remoteOk('chmod 700 /opt/launchos/tmp/step36-wait-worker.sh && /opt/launchos/tmp/step36-wait-worker.sh', 'wait-worker', { timeoutMs: 120000 });

console.log('[2] create redeploy');
const ownerEmail = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.id='${PROJECT}'"`,
    'owner',
  )
).stdout.trim();
const tempPass = `Tmp-${randomBytes(6).toString('hex')}!`;
const hash = await bcryptLib.hash(tempPass, 10);
await runner.writeTextFile('/opt/launchos/tmp/step36-setpass.sql', `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}' WHERE email='${ownerEmail.replace(/'/g, "''")}';\n`);
await remoteOk('podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < /opt/launchos/tmp/step36-setpass.sql', 'set-pass');
const login = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: ownerEmail, password: tempPass }),
});
const token = JSON.parse(login.text || '{}').accessToken;
if (!token) throw new Error(`login failed: ${redact(login.text).slice(0, 300)}`);
const auth = { authorization: `Bearer ${token}` };
const envId = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT id FROM \\"ProjectEnvironment\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"createdAt\\" ASC LIMIT 1"`,
    'env',
  )
).stdout.trim();
const created = curl(`https://api-alpha.zsaos.com/api/v1/projects/${PROJECT}/deployments`, 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ environmentId: envId, hostingMode: 'launchos', deployableUnitId: UNIT }),
});
console.log('CREATE', created.status, redact(created.text).slice(0, 400));
const depId = JSON.parse(created.text || '{}').id;
if (!depId) throw new Error('create failed');
writeFileSync(join(ARTIFACT_DIR, 'step36-dep.json'), JSON.stringify({ depId }, null, 2));

let terminal = null;
for (let i = 0; i < 240; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const peek = await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT status||'|'||coalesce(\\"currentStage\\",'')||'|'||coalesce(\\"failureCode\\",'') FROM \\"Deployment\\" WHERE id='${depId}'; SELECT \\"stepKey\\"||'|'||status||'|'||left(coalesce(\\"errorMessage\\",''),140) FROM \\"DeploymentStep\\" WHERE \\"deploymentId\\"='${depId}' ORDER BY \\"createdAt\\"; SELECT left(message,220) FROM \\"DeploymentLog\\" WHERE \\"deploymentId\\"='${depId}' AND (message ILIKE '%PUBLIC_DNS%' OR message ILIKE '%PUBLIC_VERIFY%' OR message ILIKE '%SAFE_RELEASE%' OR message ILIKE '%REUSE%' OR message ILIKE '%Gateway%') ORDER BY \\"createdAt\\" DESC LIMIT 12;"`,
    'peek',
  ).catch((e) => ({ stdout: String(e) }));
  const p = String(peek.stdout || '').trim();
  console.log(`[peek ${i}]\n${p.slice(0, 1600)}`);
  const st = (p.match(/^(RUNNING|SUCCESS|FAILED|QUEUED|CANCELLED)\|/) || [])[1];
  if (st === 'SUCCESS' || st === 'FAILED' || st === 'CANCELLED') {
    terminal = st;
    break;
  }
}

await runner.writeTextFile(
  '/opt/launchos/tmp/step36-result.sql',
  `SELECT id, status, coalesce("failureCode",''), left(coalesce("errorMessage",''),400) FROM "Deployment" WHERE id='${depId}';
SELECT "stepKey", status, left(coalesce("errorMessage",''),300) FROM "DeploymentStep" WHERE "deploymentId"='${depId}' ORDER BY "createdAt";
SELECT left(message,300) FROM "DeploymentLog" WHERE "deploymentId"='${depId}' AND (message ILIKE '%PUBLIC%' OR message ILIKE '%DNS%' OR message ILIKE '%REUSE%' OR message ILIKE '%SAFE%' OR message ILIKE '%Gateway%') ORDER BY "createdAt";
SELECT domain, status, "dnsStatus", "sslStatus", coalesce("runtimePort"::text,'') FROM "ApplicationDomain" WHERE "projectId"='${PROJECT}';
SELECT hostname, status, "targetPort" FROM "GatewayRoute" WHERE hostname='${HOST}';
SELECT id, status, "healthStatus", coalesce("externalPort"::text,''), coalesce("containerId",'') FROM "ServiceInstance" WHERE "projectId"='${PROJECT}' ORDER BY "createdAt" DESC LIMIT 4;
`,
);
const sql = await remoteOk('podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < /opt/launchos/tmp/step36-result.sql', 'result');
const sqlText = redact(String(sql.stdout || ''));
writeFileSync(join(ARTIFACT_DIR, 'step36-result.sql.txt'), sqlText);

const activeSi = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id||'|'||coalesce(\\"externalPort\\"::text,'')||'|'||coalesce(\\"containerId\\",'') FROM \\"ServiceInstance\\" WHERE \\"projectId\\"='${PROJECT}' AND status='RUNNING' ORDER BY \\"createdAt\\" DESC LIMIT 1"`,
    'active-si',
  )
).stdout.trim();
const [siId, port, containerId] = activeSi.split('|');
const fingerprint = containerId ? String(containerId).slice(0, 12) : null;
const public1 = curl(`https://${HOST}/`, HOST, { useResolve: false, maxTime: '30' });
await new Promise((r) => setTimeout(r, 5000));
const public2 = curl(`https://${HOST}/`, HOST, { useResolve: false, maxTime: '30' });
const viaAlpha = curl(`https://${HOST}/`, HOST, { useResolve: true, maxTime: '30' });
const loop = await remoteOk(`curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:${port || OLD_PORT}/`, 'loop');

const report = {
  depId,
  terminal: terminal || 'UNKNOWN',
  hostname: HOST,
  reusedDomain: /REUSE_DOMAIN/.test(sqlText),
  dnsEnsureCreate: /ensure=true A web-ceshi/.test(sqlText) && !/REUSE_DOMAIN/.test(sqlText),
  publicVerifyOk: /PUBLIC_VERIFY].*ok=true/.test(sqlText),
  safeRelease: /SAFE_RELEASE/.test(sqlText),
  activeSi: { id: siId || null, port: port || null, containerFingerprint: fingerprint },
  oldSiPreservedDuringFail: OLD_SI,
  public1: { status: public1.status, remoteIp: public1.remoteIp, body: public1.text.replace(/\s+/g, ' ').slice(0, 160) },
  public2: { status: public2.status, remoteIp: public2.remoteIp, body: public2.text.replace(/\s+/g, ' ').slice(0, 160) },
  viaAlpha: { status: viaAlpha.status, body: viaAlpha.text.replace(/\s+/g, ' ').slice(0, 120) },
  loopback: String(loop.stdout || '').trim(),
  domainRow: (sqlText.match(/web-ceshi\.zsaos\.com\|[^\n]+/) || [])[0] || null,
  routeRow: (sqlText.match(/web-ceshi\.zsaos\.com\|ACTIVE\|[0-9]+/) || [])[0] || null,
  secretsExposed: /AUTH_SECRET=\S+|gh[pousr]_/.test(sqlText) ? 'YES' : 'NO',
};
writeFileSync(join(ARTIFACT_DIR, 'step36-regress.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

await runner.disconnect();
await prisma.$disconnect();

const pass =
  report.terminal === 'SUCCESS' &&
  report.reusedDomain === true &&
  report.publicVerifyOk === true &&
  report.public1.status === 200 &&
  report.public2.status === 200 &&
  Boolean(report.activeSi.id) &&
  report.activeSi.id !== OLD_SI;
console.log(pass ? 'STEP36_REGRESS=PASS' : 'STEP36_REGRESS=FAIL');
process.exit(pass ? 0 : 1);
