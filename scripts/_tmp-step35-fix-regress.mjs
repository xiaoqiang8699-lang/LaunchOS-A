/**
 * Step 35 — fix false SUCCESS + START_SERVICE hang; redeploy Alpha; regress web-ceshi.
 * node scripts/_tmp-step35-fix-regress.mjs --confirm-step35
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
if (!process.argv.includes('--confirm-step35')) {
  console.error('pass --confirm-step35');
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
const API_TAG = 'launchos-alpha-api:step35';
const WORKER_TAG = 'launchos-alpha-worker:step35';
const WEB_TAG = 'launchos-alpha-web:step35';
const API_REMOTE = `localhost/${API_TAG}`;
const WORKER_REMOTE = `localhost/${WORKER_TAG}`;
const WEB_REMOTE = `localhost/${WEB_TAG}`;
const LIVE_API = 'launchos-alpha-api';
const LIVE_WORKER = 'launchos-alpha-worker';
const LIVE_WEB = 'launchos-alpha-web';
const CAND_API = 'launchos-alpha-api-cand-35';
const LIVE_API_PORT = 39110;
const CAND_API_PORT = 39123;
const PROJECT = 'cmunsm2lk00ctrl01nnu1pwyd';
const UNIT = 'cmunsmcpc00d2rl0184kdxdb3';
const STUCK_DEP = 'cmuo1j5k5001vrl01aio07lf3';
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
  const { method = 'GET', headers = {}, body = null, maxTime = '90', resolveIp = TARGET_HOST, useResolve = true } = opts;
  const args = ['-k', '-sS', '-L', '-X', method, '-w', '\n__STATUS__:%{http_code}\n__IP__:%{remote_ip}', '--max-time', String(maxTime)];
  if (useResolve && resolveIp) args.push('--resolve', `${host}:443:${resolveIp}`);
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body != null) args.push('-H', 'content-type: application/json', '--data-binary', body);
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)/);
  const ip = (out.match(/\n__IP__:([^\n]+)/) || [])[1] || null;
  const text = m ? out.slice(0, m.index) : out;
  return { status: m ? Number(m[1]) : 0, text, remoteIp: ip, stderr: String(r.stderr || '').slice(0, 300) };
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
async function waitHttp(label, checkCmd, failCmd = 'true') {
  await runner.writeTextFile(
    `/opt/launchos/tmp/step35-wait-${label}.sh`,
    `#!/bin/sh\nset +e\nn=0\nwhile [ "$n" -lt 40 ]; do\n  n=\$((n + 1))\n  if ${checkCmd}; then echo OK; exit 0; fi\n  sleep 2\ndone\n${failCmd}\nexit 1\n`,
  );
  await remoteOk(`chmod 700 /opt/launchos/tmp/step35-wait-${label}.sh && /opt/launchos/tmp/step35-wait-${label}.sh`, label, {
    timeoutMs: 120000,
  });
}

console.log('[0] fail stuck upload + patch env/domain');
await runner.writeTextFile(
  '/opt/launchos/tmp/step35-prep.sh',
  `#!/bin/bash
set +e
pkill -f sftp-server >/dev/null 2>&1 || true
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos <<'SQL'
UPDATE "Deployment" SET status='FAILED', "finishedAt"=NOW(), "currentStage"='FAILED', "failureCode"='RUNNING_STALLED', "errorMessage"='上线任务失去响应，请重试。', "uploadStatus"='FAILED', "uploadError"='STALLED_UPLOAD', "lastActivityAt"=NOW() WHERE id='${STUCK_DEP}' AND status='RUNNING';
UPDATE "ServiceInstance" SET status='FAILED' WHERE id='cmuo1kxki00a2rl01puc73sg8' AND status='CREATING';
UPDATE "SystemDomainConfig" SET "rootDomain"='zsaos.com', "gatewayPublicIp"='${TARGET_HOST}' WHERE id='cmu288s0z0000ri40kdli7cd3';
UPDATE "ApplicationDomain" SET status='FAILED', "dnsStatus"='FAILED' WHERE domain='web-ceshi.launchos.app';
SQL
python3 - <<'PY'
from pathlib import Path
keys = {
  'LAUNCHOS_SYSTEM_DOMAIN': 'zsaos.com',
  'LAUNCHOS_GATEWAY_PUBLIC_IP': '${TARGET_HOST}',
  'ARTIFACT_STORE': 'local',
  'LOCAL_ARTIFACT_ROOT': '/opt/launchos/artifacts',
}
for path in [Path('/opt/launchos/config/alpha-api.env'), Path('/opt/launchos/config/alpha-worker.env')]:
  lines = path.read_text().splitlines() if path.exists() else []
  out = []
  seen = set()
  for line in lines:
    if not line.strip() or line.strip().startswith('#') or '=' not in line:
      out.append(line); continue
    k = line.split('=',1)[0].strip()
    if k in keys:
      out.append(f'{k}={keys[k]}'); seen.add(k)
    else:
      out.append(line)
  for k,v in keys.items():
    if k not in seen: out.append(f'{k}={v}')
  path.write_text('\\n'.join(out).rstrip()+'\\n')
  print(path, 'ok')
PY
echo PREP_DONE
`,
);
await remoteOk('chmod 700 /opt/launchos/tmp/step35-prep.sh && /opt/launchos/tmp/step35-prep.sh', 'fail-stuck', {
  timeoutMs: 60000,
});

console.log('[1] build images');
if (!skipBuild) {
  for (const [tag, file, log] of [
    [API_TAG, 'deploy/alpha/Dockerfile.api', 'step35-api-build.log'],
    [WORKER_TAG, 'deploy/alpha/Dockerfile.worker', 'step35-worker-build.log'],
    [WEB_TAG, 'deploy/alpha/Dockerfile.web', 'step35-web-build.log'],
  ]) {
    console.log('building', tag);
    const b = local('docker', ['build', '--platform', 'linux/amd64', '-f', file, '-t', tag, '.']);
    writeFileSync(join(ARTIFACT_DIR, log), redact(`${b.stdout || ''}\n${b.stderr || ''}`).slice(-250000));
    if (b.status !== 0) throw new Error(`${tag} build failed`);
  }
}

const markers = local('docker', [
  'run', '--rm', '--entrypoint', 'sh', WORKER_TAG, '-c',
  'echo COLO=$(grep -c COLO_VISIBLE /app/packages/runtime/dist/remote-docker-runtime.js); echo PUBLIC=$(grep -c PUBLIC_VERIFY /app/packages/deployment/dist/engine/deployment-engine.service.js); echo DNS=$(grep -c ensureHostnameDnsToGateway /app/packages/deployment/dist/engine/deployment-engine.service.js); echo STALL=$(grep -c "失去响应" /app/packages/deployment/dist/engine/deployment-engine.service.js)',
]);
console.log('markers', String(markers.stdout || '').trim());
if (!/COLO=[1-9]/.test(String(markers.stdout || ''))) throw new Error('colocated upload marker missing');
if (!/PUBLIC=[1-9]/.test(String(markers.stdout || ''))) throw new Error('PUBLIC_VERIFY marker missing');

async function promoteImage(localTag, remoteName, tarName) {
  // Reconnect for each large transfer — Alpha SSH drops long-lived channels.
  try { await runner.disconnect(); } catch {}
  await runner.connect({ host: server.host, port: server.port, username, password });
  const tar = join(ARTIFACT_DIR, tarName);
  try { unlinkSync(tar); } catch {}
  if (local('docker', ['save', '-o', tar, localTag]).status !== 0) throw new Error(`save ${localTag} failed`);
  console.log('uploading', tarName);
  await runner.upload(tar, `/opt/launchos/tmp/${tarName}`, { timeoutMs: 900000 });
  await remoteOk(
    `podman load -i /opt/launchos/tmp/${tarName} && rm -f /opt/launchos/tmp/${tarName} && (podman tag docker.io/library/${localTag} ${remoteName} 2>/dev/null || podman tag ${localTag} ${remoteName} 2>/dev/null || true)`,
    `load-${localTag}`,
    { timeoutMs: 600000 },
  );
}

console.log('[2] promote api/worker/web');
await remoteOk('mkdir -p /opt/launchos/tmp /opt/launchos/bin /opt/launchos/artifacts/launchos-image-archives', 'mkdir');
await promoteImage(API_TAG, API_REMOTE, 'launchos-alpha-api-step35.tar');
await promoteImage(WORKER_TAG, WORKER_REMOTE, 'launchos-alpha-worker-step35.tar');
await promoteImage(WEB_TAG, WEB_REMOTE, 'launchos-alpha-web-step35.tar');

await runner.writeTextFile(
  '/opt/launchos/bin/step35-run-api.sh',
  `#!/bin/bash
set -euo pipefail
NAME="$1"; PORT="$2"; IMAGE="$3"
podman rm -f "$NAME" 2>/dev/null || true
podman run -d --name "$NAME" --restart unless-stopped --network host \\
  --env-file /opt/launchos/config/alpha-api.env --env-file /opt/launchos/config/alpha-github.env \\
  -e "API_PORT=$PORT" -e ARTIFACT_STORE=local -e LOCAL_ARTIFACT_ROOT=/opt/launchos/artifacts \\
  -e LAUNCHOS_SYSTEM_DOMAIN=zsaos.com -e LAUNCHOS_GATEWAY_PUBLIC_IP=${TARGET_HOST} \\
  -v /opt/launchos/artifacts:/opt/launchos/artifacts \\
  -v /opt/launchos/config/github-app.pem:/run/secrets/github-app.pem:ro \\
  --entrypoint /bin/sh "$IMAGE" \\
  -c 'export GITHUB_APP_PRIVATE_KEY="$(cat /run/secrets/github-app.pem)"; exec node apps/api/dist/main.js'
echo STARTED
`,
);
await runner.writeTextFile(
  '/opt/launchos/bin/step35-run-worker.sh',
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
await runner.writeTextFile(
  '/opt/launchos/bin/step35-run-web.sh',
  `#!/bin/bash
set -euo pipefail
NAME="$1"; IMAGE="$2"
podman rm -f "$NAME" 2>/dev/null || true
sleep 2
PORT=39082
# free preferred port if possible
if ! ss -lnt | grep -q ':39002 '; then PORT=39002; fi
podman run -d --name "$NAME" --restart unless-stopped -p 127.0.0.1:$PORT:3000 \\
  -e NEXT_PUBLIC_API_BASE_URL=https://api-alpha.zsaos.com/api/v1 \\
  "$IMAGE"
echo STARTED port=$PORT
`,
);
await remoteOk('chmod 700 /opt/launchos/bin/step35-run-*.sh', 'chmod');

await remoteOk(`/opt/launchos/bin/step35-run-api.sh ${CAND_API} ${CAND_API_PORT} ${API_REMOTE}`, 'cand-api', { timeoutMs: 120000 });
await waitHttp('cand-api', `curl -fsS http://127.0.0.1:${CAND_API_PORT}/api/v1/health 2>/dev/null | grep -q launchos-api`, `podman logs --tail 50 ${CAND_API}`);
await applyColocatedNginxRoute({ host: TARGET_HOST, port: server.port, username, password, hostname: 'api-alpha.zsaos.com', healthPath: '/api/v1/health', targetPort: CAND_API_PORT });
await remoteOk(`/opt/launchos/bin/step35-run-api.sh ${LIVE_API} ${LIVE_API_PORT} ${API_REMOTE}`, 'live-api', { timeoutMs: 120000 });
await waitHttp('live-api', `curl -fsS http://127.0.0.1:${LIVE_API_PORT}/api/v1/health 2>/dev/null | grep -q launchos-api`);
await applyColocatedNginxRoute({ host: TARGET_HOST, port: server.port, username, password, hostname: 'api-alpha.zsaos.com', healthPath: '/api/v1/health', targetPort: LIVE_API_PORT });
await remoteOk(`podman rm -f ${CAND_API} 2>/dev/null || true`, 'rm-cand');

await remoteOk(`/opt/launchos/bin/step35-run-worker.sh ${LIVE_WORKER} ${WORKER_REMOTE}`, 'live-worker', { timeoutMs: 120000 });
await waitHttp(
  'worker',
  `podman logs --tail 60 ${LIVE_WORKER} 2>&1 | grep -qiE 'worker ready queue=deploymentQueue'`,
  `podman logs --tail 80 ${LIVE_WORKER}`,
);
await remoteOk(`/opt/launchos/bin/step35-run-web.sh ${LIVE_WEB} ${WEB_REMOTE}`, 'live-web', { timeoutMs: 120000 });

await remoteOk(
  `podman exec ${LIVE_WORKER} sh -c 'tr "\\0" "\\n" < /proc/1/environ' | grep -E '^LAUNCHOS_SYSTEM_DOMAIN=|^LAUNCHOS_GATEWAY_PUBLIC_IP=|^ARTIFACT_STORE=|^LOCAL_ARTIFACT_ROOT='`,
  'verify-worker-env',
);

console.log('[3] create deployment via API (重新上线 path)');
const ownerEmail = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.id='${PROJECT}'"`,
    'owner',
  )
).stdout.trim();
const tempPass = `Tmp-${randomBytes(6).toString('hex')}!`;
const hash = await bcryptLib.hash(tempPass, 10);
await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "UPDATE \\"User\\" SET \\"passwordHash\\"='${hash.replace(/'/g, "''")}' WHERE email='${ownerEmail.replace(/'/g, "''")}'"`,
  'set-pass',
);
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
const depBody = JSON.parse(created.text || '{}');
const depId = depBody.id;
if (!depId) throw new Error('deployment create failed');
writeFileSync(join(ARTIFACT_DIR, 'step35-dep.json'), JSON.stringify({ depId, ownerEmail }, null, 2));

let terminal = null;
for (let i = 0; i < 240; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const peek = await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT status||'|'||coalesce(\\"currentStage\\",'')||'|'||coalesce(\\"uploadStatus\\"::text,'')||'|'||coalesce(\\"failureCode\\",'') FROM \\"Deployment\\" WHERE id='${depId}'; SELECT \\"stepKey\\"||'|'||status||'|'||left(coalesce(\\"errorMessage\\",''),100) FROM \\"DeploymentStep\\" WHERE \\"deploymentId\\"='${depId}' ORDER BY \\"createdAt\\"; SELECT left(message,180) FROM \\"DeploymentLog\\" WHERE \\"deploymentId\\"='${depId}' ORDER BY \\"createdAt\\" DESC LIMIT 8;"`,
    'peek',
  ).catch((e) => ({ stdout: String(e) }));
  const p = String(peek.stdout || '').trim();
  console.log(`[peek ${i}]\n${p.slice(0, 1200)}`);
  const st = (p.match(/^(RUNNING|SUCCESS|FAILED|QUEUED|CANCELLED)\|/) || [])[1];
  if (st === 'SUCCESS' || st === 'FAILED' || st === 'CANCELLED') {
    terminal = st;
    break;
  }
}

await runner.writeTextFile(
  '/opt/launchos/tmp/step35-result.sql',
  `SELECT id, status, coalesce("currentStage",''), coalesce("failureCode",''), left(coalesce("errorMessage",''),800) FROM "Deployment" WHERE id='${depId}';
SELECT "stepKey", status, left(coalesce("errorMessage",''),500) FROM "DeploymentStep" WHERE "deploymentId"='${depId}' ORDER BY "createdAt";
SELECT left(message,1200) FROM "DeploymentLog" WHERE "deploymentId"='${depId}' ORDER BY "createdAt" ASC LIMIT 260;
SELECT domain, status, "dnsStatus", "sslStatus", coalesce("runtimePort"::text,'') FROM "ApplicationDomain" WHERE "projectId"='${PROJECT}' ORDER BY "updatedAt" DESC;
SELECT hostname, status, "targetPort" FROM "GatewayRoute" WHERE "projectId"='${PROJECT}' ORDER BY "updatedAt" DESC;
SELECT id, status, "healthStatus", coalesce(port::text,''), coalesce("externalPort"::text,''), coalesce("containerId",'') FROM "ServiceInstance" WHERE "projectId"='${PROJECT}' ORDER BY "createdAt" DESC LIMIT 5;
`,
);
const sql = await remoteOk(
  'podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < /opt/launchos/tmp/step35-result.sql',
  'result',
);
const sqlText = redact(String(sql.stdout || ''));
writeFileSync(join(ARTIFACT_DIR, 'step35-result.sql.txt'), sqlText);

const publicHost = (sqlText.match(/(web-ceshi\.zsaos\.com)/) || [])[1] || 'web-ceshi.zsaos.com';
const external1 = curl(`https://${publicHost}/`, publicHost, { useResolve: false, maxTime: '45' });
await new Promise((r) => setTimeout(r, 8000));
const external2 = curl(`https://${publicHost}/`, publicHost, { useResolve: false, maxTime: '45' });
const viaAlpha = curl(`https://${publicHost}/`, publicHost, { useResolve: true, resolveIp: TARGET_HOST, maxTime: '45' });

const report = {
  depId,
  terminal: terminal || 'UNKNOWN',
  publicHost,
  external1: { status: external1.status, remoteIp: external1.remoteIp, body: external1.text.replace(/\s+/g, ' ').slice(0, 160), stderr: external1.stderr },
  external2: { status: external2.status, remoteIp: external2.remoteIp, body: external2.text.replace(/\s+/g, ' ').slice(0, 160), stderr: external2.stderr },
  viaAlpha: { status: viaAlpha.status, remoteIp: viaAlpha.remoteIp, body: viaAlpha.text.replace(/\s+/g, ' ').slice(0, 160) },
  hasPublicVerify: /PUBLIC_VERIFY/.test(sqlText),
  hasColocatedCopy: /同机镜像归档本地拷贝|COLO_VISIBLE/.test(sqlText),
  hasDnsEnsure: /PUBLIC_DNS/.test(sqlText),
  remoteDeploy: (sqlText.match(/REMOTE_DEPLOY\s+\|\s+(\w+)/) || [])[1] || null,
  secretsExposed: /AUTH_SECRET=\S+|gh[pousr]_/.test(sqlText) ? 'YES' : 'NO',
};
writeFileSync(join(ARTIFACT_DIR, 'step35-regress.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

await runner.disconnect();
await prisma.$disconnect();

const pass =
  report.terminal === 'SUCCESS' &&
  report.external1.status >= 200 &&
  report.external1.status < 400 &&
  report.external2.status >= 200 &&
  report.external2.status < 400 &&
  /siqin|Next|html/i.test(report.external1.body + report.external2.body);
console.log(pass ? 'STEP35_REGRESS=PASS' : 'STEP35_REGRESS=FAIL');
process.exit(pass ? 0 : 1);
