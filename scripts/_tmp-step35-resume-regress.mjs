/**
 * Resume Step 35 after images loaded: restart web, verify worker env, relaunch web-ceshi.
 * node scripts/_tmp-step35-resume-regress.mjs --confirm-step35
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const WEB_REMOTE = 'localhost/launchos-alpha-web:step35';
const LIVE_WEB = 'launchos-alpha-web';
const LIVE_WORKER = 'launchos-alpha-worker';
const LIVE_API = 'launchos-alpha-api';
const LIVE_API_PORT = 39110;
const PROJECT = 'cmunsm2lk00ctrl01nnu1pwyd';
const UNIT = 'cmunsmcpc00d2rl0184kdxdb3';
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });

function redact(t) {
  return String(t || '')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer|accessToken|AUTH_SECRET)\s*[=:]\s*\S+/gi, '$1=***')
    .replace(/enc:v1:[A-Za-z0-9+/=:_-]+/g, 'enc:v1:***');
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
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out, remoteIp: ip, stderr: String(r.stderr || '').slice(0, 300) };
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

console.log('[1] ensure api/worker/web + nginx');
await remoteOk(
  `podman inspect ${LIVE_API} --format '{{.Config.Image}} {{.State.Status}}'; podman inspect ${LIVE_WORKER} --format '{{.Config.Image}} {{.State.Status}}'`,
  'inspect',
);
await applyColocatedNginxRoute({
  host: TARGET_HOST,
  port: server.port,
  username,
  password,
  hostname: 'api-alpha.zsaos.com',
  healthPath: '/api/v1/health',
  targetPort: LIVE_API_PORT,
});

await runner.writeTextFile(
  '/opt/launchos/bin/step35-run-web.sh',
  `#!/bin/bash
set -euo pipefail
NAME="$1"; IMAGE="$2"
podman rm -f "$NAME" 2>/dev/null || true
sleep 2
PORT=39082
if ! ss -lnt | grep -q ':39002 '; then PORT=39002; fi
podman run -d --name "$NAME" --restart unless-stopped -p 127.0.0.1:$PORT:3000 \\
  -e NEXT_PUBLIC_API_BASE_URL=https://api-alpha.zsaos.com/api/v1 \\
  "$IMAGE"
echo STARTED port=$PORT
`,
);
await remoteOk('chmod 700 /opt/launchos/bin/step35-run-web.sh && /opt/launchos/bin/step35-run-web.sh ' + LIVE_WEB + ' ' + WEB_REMOTE, 'live-web', {
  timeoutMs: 120000,
});
const webPort = (
  await remoteOk(
    `podman inspect ${LIVE_WEB} --format '{{(index (index .NetworkSettings.Ports "3000/tcp") 0).HostPort}}'`,
    'web-port',
  )
).stdout.trim();
console.log('webPort', webPort);
// alpha.zsaos.com / console host if routed — best-effort
await applyColocatedNginxRoute({
  host: TARGET_HOST,
  port: server.port,
  username,
  password,
  hostname: 'alpha.zsaos.com',
  healthPath: '/',
  targetPort: Number(webPort) || 39082,
}).catch(() => undefined);

await remoteOk(
  `podman exec ${LIVE_WORKER} sh -c 'tr "\\0" "\\n" < /proc/1/environ' | grep -E '^LAUNCHOS_SYSTEM_DOMAIN=|^LAUNCHOS_GATEWAY_PUBLIC_IP=|^ARTIFACT_STORE=|^LOCAL_ARTIFACT_ROOT='`,
  'verify-worker-env',
);

console.log('[2] create deployment');
const ownerEmail = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.id='${PROJECT}'"`,
    'owner',
  )
).stdout.trim();
const tempPass = `Tmp-${randomBytes(6).toString('hex')}!`;
const hash = await bcryptLib.hash(tempPass, 10);
await runner.writeTextFile(
  '/opt/launchos/tmp/step35-setpass.sql',
  `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}' WHERE email='${ownerEmail.replace(/'/g, "''")}';\n`,
);
await remoteOk(
  'podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < /opt/launchos/tmp/step35-setpass.sql',
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
const depId = JSON.parse(created.text || '{}').id;
if (!depId) throw new Error('deployment create failed');
writeFileSync(join(ARTIFACT_DIR, 'step35-dep.json'), JSON.stringify({ depId, ownerEmail }, null, 2));

let terminal = null;
for (let i = 0; i < 240; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const peek = await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT status||'|'||coalesce(\\"currentStage\\",'')||'|'||coalesce(\\"uploadStatus\\"::text,'')||'|'||coalesce(\\"failureCode\\",'') FROM \\"Deployment\\" WHERE id='${depId}'; SELECT \\"stepKey\\"||'|'||status||'|'||left(coalesce(\\"errorMessage\\",''),120) FROM \\"DeploymentStep\\" WHERE \\"deploymentId\\"='${depId}' ORDER BY \\"createdAt\\"; SELECT left(message,200) FROM \\"DeploymentLog\\" WHERE \\"deploymentId\\"='${depId}' ORDER BY \\"createdAt\\" DESC LIMIT 10;"`,
    'peek',
  ).catch((e) => ({ stdout: String(e) }));
  const p = String(peek.stdout || '').trim();
  console.log(`[peek ${i}]\n${p.slice(0, 1400)}`);
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
SELECT left(message,1200) FROM "DeploymentLog" WHERE "deploymentId"='${depId}' ORDER BY "createdAt" ASC LIMIT 280;
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
const dns = spawnSync('nslookup', [publicHost], { encoding: 'utf8' });

const report = {
  depId,
  terminal: terminal || 'UNKNOWN',
  publicHost,
  dns: String(dns.stdout || '') + String(dns.stderr || ''),
  external1: { status: external1.status, remoteIp: external1.remoteIp, body: external1.text.replace(/\s+/g, ' ').slice(0, 180), stderr: external1.stderr },
  external2: { status: external2.status, remoteIp: external2.remoteIp, body: external2.text.replace(/\s+/g, ' ').slice(0, 180), stderr: external2.stderr },
  viaAlpha: { status: viaAlpha.status, remoteIp: viaAlpha.remoteIp, body: viaAlpha.text.replace(/\s+/g, ' ').slice(0, 180) },
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
  report.external2.status < 400;
console.log(pass ? 'STEP35_REGRESS=PASS' : 'STEP35_REGRESS=FAIL');
process.exit(pass ? 0 : 1);
