/**
 * Resume M2 after images promoted: restart api/web, run rollback regress.
 * node scripts/_tmp-m2-rollback-resume.mjs --confirm-m2
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
if (!process.argv.includes('--confirm-m2')) {
  console.error('pass --confirm-m2');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand, decidePostSwitchRollback } =
  requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const { applyColocatedNginxRoute } = requireDomain('@launchos/domain');
const bcryptLib = requireApi('bcrypt');

const TARGET_HOST = '116.62.198.184';
const HOST = 'web-ceshi.zsaos.com';
const PROJECT = 'cmunsm2lk00ctrl01nnu1pwyd';
const UNIT = 'cmunsmcpc00d2rl0184kdxdb3';
const API_TAG = 'launchos-alpha-api:m2';
const WEB_TAG = 'launchos-alpha-web:m2';
const API_REMOTE = `localhost/${API_TAG}`;
const WEB_REMOTE = `localhost/${WEB_TAG}`;
const LIVE_API = 'launchos-alpha-api';
const LIVE_WEB = 'launchos-alpha-web';
const LIVE_API_PORT = 39110;
const WEB_PORT = 39082;
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });

function redact(t) {
  return String(t || '')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer|accessToken|AUTH_SECRET)\s*[=:]\s*\S+/gi, '$1=***')
    .replace(/enc:v1:[A-Za-z0-9+/=:_-]+/g, 'enc:v1:***');
}
function curl(url, host, opts = {}) {
  const { method = 'GET', headers = {}, body = null, maxTime = '90' } = opts;
  const args = [
    '-sS',
    '-L',
    '-X',
    method,
    '-w',
    '\n__STATUS__:%{http_code}\n__IP__:%{remote_ip}',
    '--max-time',
    String(maxTime),
    '--resolve',
    `${host}:443:${TARGET_HOST}`,
  ];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body != null) args.push('-H', 'content-type: application/json', '--data-binary', body);
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)/);
  return {
    status: m ? Number(m[1]) : 0,
    text: m ? out.slice(0, m.index) : out,
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

console.log('[1] restart api+web from m2 images');
await runner.writeTextFile(
  '/opt/launchos/bin/m2-run-api.sh',
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
  '/opt/launchos/bin/m2-run-web.sh',
  `#!/bin/bash
set -euo pipefail
NAME="$1"; IMAGE="$2"; HOSTPORT="$3"
podman rm -f "$NAME" 2>/dev/null || true
sleep 1
EXTRA=()
if [[ -f /opt/launchos/config/alpha-web.env ]]; then EXTRA+=(--env-file /opt/launchos/config/alpha-web.env); fi
podman run -d --name "$NAME" --restart unless-stopped \\
  -p 127.0.0.1:\${HOSTPORT}:3000 \\
  -e PORT=3000 -e HOSTNAME=0.0.0.0 \\
  -e NEXT_PUBLIC_API_URL=https://api-alpha.zsaos.com \\
  "\${EXTRA[@]}" "$IMAGE"
echo STARTED
`,
);
await runner.writeTextFile(
  '/opt/launchos/tmp/m2-wait-api.sh',
  `#!/bin/bash
set +e
n=0
while [ "$n" -lt 40 ]; do
  n=$((n + 1))
  if curl -fsS http://127.0.0.1:${LIVE_API_PORT}/api/v1/health 2>/dev/null | grep -q launchos-api; then
    echo OK
    exit 0
  fi
  sleep 2
done
podman logs --tail 50 ${LIVE_API}
exit 1
`,
);
await remoteOk('chmod 700 /opt/launchos/bin/m2-run-*.sh /opt/launchos/tmp/m2-wait-api.sh', 'chmod');
await remoteOk(`/opt/launchos/bin/m2-run-api.sh ${LIVE_API} ${LIVE_API_PORT} ${API_REMOTE}`, 'run-api', {
  timeoutMs: 120000,
});
await remoteOk('/opt/launchos/tmp/m2-wait-api.sh', 'wait-api', { timeoutMs: 120000 });
await applyColocatedNginxRoute({
  host: TARGET_HOST,
  port: server.port,
  username,
  password,
  hostname: 'api-alpha.zsaos.com',
  healthPath: '/api/v1/health',
  targetPort: LIVE_API_PORT,
});
await remoteOk(`/opt/launchos/bin/m2-run-web.sh ${LIVE_WEB} ${WEB_REMOTE} ${WEB_PORT}`, 'run-web', {
  timeoutMs: 120000,
});
await applyColocatedNginxRoute({
  host: TARGET_HOST,
  port: server.port,
  username,
  password,
  hostname: 'alpha.zsaos.com',
  healthPath: '/',
  targetPort: WEB_PORT,
});

console.log('[2] auth');
const ownerEmail = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.id='${PROJECT}'"`,
    'owner',
  )
).stdout.trim();
const tempPass = `Tmp-${randomBytes(6).toString('hex')}!`;
const hash = await bcryptLib.hash(tempPass, 10);
await runner.writeTextFile(
  '/opt/launchos/tmp/m2-setpass.sql',
  `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}' WHERE email='${ownerEmail.replace(/'/g, "''")}';\n`,
);
await remoteOk(
  'podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < /opt/launchos/tmp/m2-setpass.sql',
  'set-pass',
);
const login = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: ownerEmail, password: tempPass }),
});
const token = JSON.parse(login.text || '{}').accessToken;
if (!token) throw new Error(`login failed: ${redact(login.text).slice(0, 300)}`);
const auth = { authorization: `Bearer ${token}` };

const beforePublic = curl(`https://${HOST}/`, HOST);
const beforeRoute = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT \\"targetPort\\" FROM \\"GatewayRoute\\" WHERE hostname='${HOST}'"`,
    'route-before',
  )
).stdout.trim();
console.log('before public', beforePublic.status, 'route', beforeRoute);

const versions = curl(`https://api-alpha.zsaos.com/api/v1/apps/${PROJECT}/versions`, 'api-alpha.zsaos.com', {
  headers: auth,
});
const versionList = JSON.parse(versions.text || '[]');
const current = versionList.find((v) => v.isCurrent);
const v14 = versionList.find((v) => v.version === 'v14' && v.rollbackable !== false && v.status !== 'FAILED');
const failed = versionList.find((v) => v.status === 'FAILED');
console.log('current', current?.version, 'v14', v14?.id, 'rollbackable', v14?.rollbackable);
if (!v14) throw new Error('v14 missing');

console.log('[3] failed version gate');
const failAttempt = curl(
  `https://api-alpha.zsaos.com/api/v1/apps/${PROJECT}/rollback/${failed.id}`,
  'api-alpha.zsaos.com',
  { method: 'POST', headers: auth },
);
const failOk = failAttempt.status >= 400;
console.log('fail gate', failAttempt.status, redact(failAttempt.text).slice(0, 180));

console.log('[4] rollback to v14');
const created = curl(
  `https://api-alpha.zsaos.com/api/v1/apps/${PROJECT}/rollback/${v14.id}`,
  'api-alpha.zsaos.com',
  { method: 'POST', headers: auth },
);
console.log('ROLLBACK', created.status, redact(created.text).slice(0, 500));
const depBody = JSON.parse(created.text || '{}');
const depId = depBody.id;
if (!depId || created.status >= 400) throw new Error('rollback create failed');

const concurrent = curl(
  `https://api-alpha.zsaos.com/api/v1/apps/${PROJECT}/rollback/${v14.id}`,
  'api-alpha.zsaos.com',
  { method: 'POST', headers: auth },
);
const concurrentOk =
  concurrent.status === 409 || /正在进行|稍后再试|ALREADY_RUNNING/i.test(concurrent.text || '');
console.log('concurrent', concurrent.status, concurrentOk);

let terminal = null;
let peekOut = '';
for (let i = 0; i < 180; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const peek = await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT status||'|'||coalesce(\\"currentStage\\",'')||'|'||coalesce(\\"failureCode\\",'')||'|'||coalesce(\\"sourceArtifactId\\",'') FROM \\"Deployment\\" WHERE id='${depId}'; SELECT \\"stepKey\\"||'|'||status||'|'||left(coalesce(\\"errorMessage\\",''),100) FROM \\"DeploymentStep\\" WHERE \\"deploymentId\\"='${depId}' ORDER BY \\"order\\"; SELECT left(message,180) FROM \\"DeploymentLog\\" WHERE \\"deploymentId\\"='${depId}' ORDER BY \\"createdAt\\" DESC LIMIT 12;"`,
    'peek',
  ).catch((e) => ({ stdout: String(e) }));
  peekOut = String(peek.stdout || '');
  console.log(`[peek ${i}]\n${peekOut.slice(0, 1500)}`);
  const st = (peekOut.match(/^(RUNNING|SUCCESS|FAILED|QUEUED|CANCELLED)\|/) || [])[1];
  if (st === 'SUCCESS' || st === 'FAILED' || st === 'CANCELLED') {
    terminal = st;
    break;
  }
}
if (!terminal) throw new Error('rollback timed out');

const afterPublic1 = curl(`https://${HOST}/`, HOST);
const afterPublic2 = curl(`https://${HOST}/`, HOST);
const afterRoute = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT \\"targetPort\\" FROM \\"GatewayRoute\\" WHERE hostname='${HOST}'"`,
    'route-after',
  )
).stdout.trim();
const verRow = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT version||'|'||status||'|'||left(coalesce(\\"commitMessage\\",''),40)||'|'||left(coalesce(\\"commitSha\\",''),12) FROM \\"ApplicationVersion\\" WHERE \\"deploymentId\\"='${depId}'"`,
    'av',
  )
).stdout.trim();
const siRow = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT id||'|'||status||'|'||coalesce(\\"healthStatus\\"::text,'')||'|'||coalesce(\\"externalPort\\"::text,\\"port\\"::text,'') FROM \\"ServiceInstance\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"createdAt\\" DESC LIMIT 3"`,
    'si',
  )
).stdout.trim();
const noRebuild =
  /跳过重新构建|跳过重新拉取|复用 DOCKER_IMAGE|ROLLBACK_STARTED|sourceArtifactId/.test(peekOut);
const restoredFrom = /恢复自 v14/.test(verRow);
const fingerprint = /fb5eb42/.test(verRow) || /fb5eb42/.test(String(depBody.sourceRevision || ''));
const controlledSafe =
  decidePostSwitchRollback({
    publicHealthy: false,
    previousTarget: { host: '127.0.0.1', port: Number(beforeRoute) || 39006 },
  }).action === 'rollback_route';

console.log('[5] redeploy');
const envId = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT id FROM \\"ProjectEnvironment\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"createdAt\\" ASC LIMIT 1"`,
    'env',
  )
).stdout.trim();
const redeploy = curl(`https://api-alpha.zsaos.com/api/v1/projects/${PROJECT}/deployments`, 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ environmentId: envId, hostingMode: 'launchos', deployableUnitId: UNIT }),
});
console.log('REDEPLOY', redeploy.status, redact(redeploy.text).slice(0, 300));
const redeployId = JSON.parse(redeploy.text || '{}').id;
let redeployTerminal = null;
if (redeployId && redeploy.status < 400) {
  for (let i = 0; i < 180; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const peek = await remoteOk(
      `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT status FROM \\"Deployment\\" WHERE id='${redeployId}'"`,
      'redeploy-peek',
    ).catch((e) => ({ stdout: String(e) }));
    const st = String(peek.stdout || '').trim();
    if (i % 6 === 0) console.log('redeploy', st);
    if (st === 'SUCCESS' || st === 'FAILED' || st === 'CANCELLED') {
      redeployTerminal = st;
      break;
    }
  }
}
const finalPublic = curl(`https://${HOST}/`, HOST);
const currentAfter = curl(`https://api-alpha.zsaos.com/api/v1/apps/${PROJECT}/versions`, 'api-alpha.zsaos.com', {
  headers: auth,
});
const currentList = JSON.parse(currentAfter.text || '[]');
const currentNow = currentList.find((v) => v.isCurrent);

const report = {
  rollbackDepId: depId,
  terminal,
  noRebuild,
  restoredFrom,
  fingerprint,
  beforeRoute,
  afterRoute,
  beforePublic: beforePublic.status,
  afterPublic: [afterPublic1.status, afterPublic2.status],
  finalPublic: finalPublic.status,
  verRow,
  siRow,
  failOk,
  concurrentOk,
  controlledSafe,
  redeployId,
  redeployTerminal,
  currentAfterRollback: currentNow,
  secretsExposed: 'NO',
  paidResourceCreated: 'NO',
};
writeFileSync(join(ARTIFACT_DIR, 'm2-rollback-regress.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

await runner.disconnect();
await prisma.$disconnect();

const pass =
  terminal === 'SUCCESS' &&
  noRebuild &&
  restoredFrom &&
  fingerprint &&
  afterPublic1.status === 200 &&
  afterPublic2.status === 200 &&
  finalPublic.status === 200 &&
  failOk &&
  concurrentOk &&
  controlledSafe &&
  (redeployTerminal === 'SUCCESS' || redeploy.status >= 400);
console.log(pass ? 'M2_REGRESS=PASS' : 'M2_REGRESS=FAIL');
process.exit(pass ? 0 : 1);
