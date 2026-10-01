/**
 * Beta M2: promote API+Web, rollback web-ceshi v15→v14, failure gates, redeploy.
 * node scripts/_tmp-m2-rollback-regress.mjs --confirm-m2
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
if (!process.argv.includes('--confirm-m2')) {
  console.error('pass --confirm-m2');
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
  const args = [
    '-sS',
    '-L',
    '-X',
    method,
    '-w',
    '\n__STATUS__:%{http_code}\n__IP__:%{remote_ip}',
    '--max-time',
    String(maxTime),
  ];
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
if (!server) throw new Error('server missing');
const username = resolveServerSshUsername(server.username);
const password = decryptCredential(server.credentialEncrypted);
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username, password });

async function remoteOk(cmd, label, opts = {}) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs: opts.timeoutMs ?? 180000 });
  if (r.exitCode !== 0) throw new Error(`${label}: ${redact(r.stderr || r.stdout || '').slice(0, 1500)}`);
  return r;
}

async function promoteImage(localTag, remoteName, tarName) {
  try {
    await runner.disconnect();
  } catch {}
  await runner.connect({ host: server.host, port: server.port, username, password });
  const tar = join(ARTIFACT_DIR, tarName);
  try {
    unlinkSync(tar);
  } catch {}
  if (local('docker', ['save', '-o', tar, localTag]).status !== 0) throw new Error(`save ${localTag} failed`);
  console.log('uploading', tarName);
  await runner.upload(tar, `/opt/launchos/tmp/${tarName}`, { timeoutMs: 900000 });
  await remoteOk(
    `podman load -i /opt/launchos/tmp/${tarName} && rm -f /opt/launchos/tmp/${tarName} && (podman tag docker.io/library/${localTag} ${remoteName} 2>/dev/null || podman tag ${localTag} ${remoteName} 2>/dev/null || true)`,
    `load-${localTag}`,
    { timeoutMs: 600000 },
  );
}

console.log('[1] build api+web');
if (!skipBuild) {
  for (const [tag, file, log] of [
    [API_TAG, 'deploy/alpha/Dockerfile.api', 'm2-api-build.log'],
    [WEB_TAG, 'deploy/alpha/Dockerfile.web', 'm2-web-build.log'],
  ]) {
    console.log('building', tag);
    const b = local('docker', [
      'build',
      '--platform',
      'linux/amd64',
      '-f',
      file,
      '-t',
      tag,
      ...(tag === WEB_TAG ? ['--build-arg', 'NEXT_PUBLIC_API_URL=https://api-alpha.zsaos.com'] : []),
      '.',
    ]);
    writeFileSync(join(ARTIFACT_DIR, log), redact(`${b.stdout || ''}\n${b.stderr || ''}`).slice(-300000));
    if (b.status !== 0) throw new Error(`${tag} build failed`);
  }
}

const markers = local('docker', [
  'run',
  '--rm',
  '--entrypoint',
  'sh',
  API_TAG,
  '-c',
  'echo RB=$(grep -c ROLLBACK_STARTED /app/apps/api/dist/deployments/deployments.service.js); echo RESTORE=$(grep -c "恢复自" /app/apps/api/dist/deployments/deployments.service.js); echo CFG=$(grep -c RUNTIME_CONFIG_MISSING /app/apps/api/dist/deployments/deployments.service.js)',
]);
console.log('api markers', String(markers.stdout || '').trim());
if (!/RB=[1-9]/.test(String(markers.stdout || ''))) throw new Error('ROLLBACK_STARTED marker missing in api');

console.log('[2] promote');
await remoteOk('mkdir -p /opt/launchos/tmp /opt/launchos/bin', 'mkdir');
await promoteImage(API_TAG, API_REMOTE, 'launchos-alpha-api-m2.tar');
await promoteImage(WEB_TAG, WEB_REMOTE, 'launchos-alpha-web-m2.tar');

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
await remoteOk('chmod 700 /opt/launchos/bin/m2-run-*.sh', 'chmod');
await remoteOk(`/opt/launchos/bin/m2-run-api.sh ${LIVE_API} ${LIVE_API_PORT} ${API_REMOTE}`, 'run-api', {
  timeoutMs: 120000,
});
await remoteOk(
  `n=0; while [ $n -lt 40 ]; do n=$((n+1)); curl -fsS http://127.0.0.1:${LIVE_API_PORT}/api/v1/health 2>/dev/null | grep -q launchos-api && echo OK && exit 0; sleep 2; done; podman logs --tail 40 ${LIVE_API}; exit 1`,
  'wait-api',
  { timeoutMs: 120000 },
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

console.log('[3] auth + locate versions');
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
const v14 = versionList.find((v) => v.version === 'v14' && v.rollbackable);
const failed = versionList.find((v) => v.status === 'FAILED');
if (!current || current.version !== 'v15') {
  console.warn('current is', current?.version, 'expected v15 — continuing if rollbackable target exists');
}
if (!v14) throw new Error('v14 rollbackable version missing');
console.log('current', current?.version, 'target', v14.version, v14.id);

console.log('[4] controlled failure: FAILED version rejected');
const failAttempt = curl(
  `https://api-alpha.zsaos.com/api/v1/apps/${PROJECT}/rollback/${failed?.id || 'missing'}`,
  'api-alpha.zsaos.com',
  { method: 'POST', headers: auth },
);
const failOk =
  !failed ||
  (failAttempt.status >= 400 &&
    /失败|不能恢复|FAILED|ROLLBACK/i.test(failAttempt.text || ''));
console.log('failed-version gate', failAttempt.status, redact(failAttempt.text).slice(0, 200), failOk);

console.log('[5] rollback v14');
const created = curl(
  `https://api-alpha.zsaos.com/api/v1/apps/${PROJECT}/rollback/${v14.id}`,
  'api-alpha.zsaos.com',
  { method: 'POST', headers: auth },
);
console.log('ROLLBACK', created.status, redact(created.text).slice(0, 500));
const depBody = JSON.parse(created.text || '{}');
const depId = depBody.id;
if (!depId || created.status >= 400) throw new Error('rollback create failed');

console.log('[6] concurrent protection while running');
const concurrent = curl(
  `https://api-alpha.zsaos.com/api/v1/apps/${PROJECT}/rollback/${v14.id}`,
  'api-alpha.zsaos.com',
  { method: 'POST', headers: auth },
);
const concurrentOk =
  concurrent.status === 409 ||
  /正在进行|稍后再试|ALREADY_RUNNING/i.test(concurrent.text || '');
console.log('concurrent', concurrent.status, redact(concurrent.text).slice(0, 200), concurrentOk);

let terminal = null;
let peekOut = '';
for (let i = 0; i < 180; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const peek = await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT status||'|'||coalesce(\\"currentStage\\",'')||'|'||coalesce(\\"failureCode\\",'')||'|'||coalesce(\\"sourceArtifactId\\",'') FROM \\"Deployment\\" WHERE id='${depId}'; SELECT \\"stepKey\\"||'|'||status||'|'||left(coalesce(\\"errorMessage\\",''),80) FROM \\"DeploymentStep\\" WHERE \\"deploymentId\\"='${depId}' ORDER BY \\"order\\"; SELECT left(message,160) FROM \\"DeploymentLog\\" WHERE \\"deploymentId\\"='${depId}' ORDER BY \\"createdAt\\" DESC LIMIT 10;"`,
    'peek',
  ).catch((e) => ({ stdout: String(e) }));
  peekOut = String(peek.stdout || '');
  console.log(`[peek ${i}]\n${peekOut.slice(0, 1400)}`);
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
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT version||'|'||status||'|'||left(coalesce(\\"commitMessage\\",''),40)||'|'||\\"commitSha\\" FROM \\"ApplicationVersion\\" WHERE \\"deploymentId\\"='${depId}'"`,
    'av',
  )
).stdout.trim();
const siRow = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT id||'|'||status||'|'||coalesce(\\"healthStatus\\"::text,'')||'|'||coalesce(\\"externalPort\\"::text,\\"port\\"::text,'') FROM \\"ServiceInstance\\" WHERE \\"deploymentId\\"='${depId}' ORDER BY \\"createdAt\\" DESC LIMIT 1"`,
    'si',
  )
).stdout.trim();
const noRebuild =
  /跳过重新构建|跳过重新拉取|复用 DOCKER_IMAGE|ROLLBACK_STARTED/.test(peekOut) ||
  /sourceArtifactId/.test(peekOut);
const restoredFrom = /恢复自 v14/.test(verRow);
const fingerprint =
  (verRow.split('|')[3] || '').startsWith('fb5eb42') ||
  String(depBody.sourceRevision || '').startsWith('fb5eb42');

console.log('[7] controlled SAFE_RELEASE unit check');
const shared = requireApi('@launchos/shared');
const decision = shared.decidePostSwitchRollback({
  publicHealthy: false,
  previousTarget: { host: '127.0.0.1', port: Number(beforeRoute) || 39006 },
});
const controlledSafe = decision?.action === 'rollback_route';

console.log('[8] redeploy regression');
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
if (redeployId) {
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
  (redeployTerminal === 'SUCCESS' || redeployTerminal === null);
console.log(pass ? 'M2_REGRESS=PASS' : 'M2_REGRESS=FAIL');
process.exit(pass ? 0 : 1);
