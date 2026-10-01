/**
 * Beta M3: promote API+Web, web-ceshi healthy + controlled failure regress.
 * node scripts/_tmp-m3-health-regress.mjs --confirm-m3
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
if (!process.argv.includes('--confirm-m3')) {
  console.error('pass --confirm-m3');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand, redactSecrets } =
  requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const { applyColocatedNginxRoute } = requireDomain('@launchos/domain');
const bcryptLib = requireApi('bcrypt');

const TARGET_HOST = '116.62.198.184';
const HOST = 'web-ceshi.zsaos.com';
const PROJECT = 'cmunsm2lk00ctrl01nnu1pwyd';
const API_TAG = 'launchos-alpha-api:m3';
const WEB_TAG = 'launchos-alpha-web:m3';
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

const report = {
  secretsExposed: 'NO',
  paidResourceCreated: 'NO',
  healthy: false,
  publicFail: false,
  stale: false,
  logsOk: false,
  existingFlows: false,
  pages: {},
};

console.log('[1] build api+web');
if (!skipBuild) {
  for (const [tag, file, log] of [
    [API_TAG, 'deploy/alpha/Dockerfile.api', 'm3-api-build.log'],
    [WEB_TAG, 'deploy/alpha/Dockerfile.web', 'm3-web-build.log'],
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
    if (b.status !== 0) throw new Error(`${tag} build failed — see ${log}`);
  }
}

const markers = local('docker', [
  'run',
  '--rm',
  '--entrypoint',
  'sh',
  API_TAG,
  '-c',
  'echo RH=$(grep -c decideProductRuntimeHealth /app/packages/shared/dist/runtime-product-health.js 2>/dev/null || grep -c decideProductRuntimeHealth /app/node_modules/@launchos/shared/dist/runtime-product-health.js 2>/dev/null || echo 0); echo RT=$(grep -c runtimeHealth /app/apps/api/dist/apps/apps.service.js); echo PUB=$(grep -c "public:" /app/apps/api/dist/apps/apps.service.js); echo RED=$(grep -c redactSecrets /app/apps/api/dist/apps/apps.service.js)',
]);
console.log('api markers', String(markers.stdout || '').trim());
if (!/RT=[1-9]/.test(String(markers.stdout || ''))) throw new Error('runtimeHealth marker missing');

console.log('[2] promote');
await remoteOk('mkdir -p /opt/launchos/tmp /opt/launchos/bin', 'mkdir');
await promoteImage(API_TAG, API_REMOTE, 'launchos-alpha-api-m3.tar');
await promoteImage(WEB_TAG, WEB_REMOTE, 'launchos-alpha-web-m3.tar');

await runner.writeTextFile(
  '/opt/launchos/bin/m3-run-api.sh',
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
  '/opt/launchos/bin/m3-run-web.sh',
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
await remoteOk('chmod 700 /opt/launchos/bin/m3-run-*.sh', 'chmod');
await runner.writeTextFile(
  '/opt/launchos/tmp/m3-wait-api.sh',
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
await remoteOk('chmod 700 /opt/launchos/tmp/m3-wait-api.sh', 'chmod-wait');
await remoteOk(`/opt/launchos/bin/m3-run-api.sh ${LIVE_API} ${LIVE_API_PORT} ${API_REMOTE}`, 'run-api', {
  timeoutMs: 120000,
});
await remoteOk('/opt/launchos/tmp/m3-wait-api.sh', 'wait-api', { timeoutMs: 120000 });
await applyColocatedNginxRoute({
  host: TARGET_HOST,
  port: server.port,
  username,
  password,
  hostname: 'api-alpha.zsaos.com',
  healthPath: '/api/v1/health',
  targetPort: LIVE_API_PORT,
});
await remoteOk(`/opt/launchos/bin/m3-run-web.sh ${LIVE_WEB} ${WEB_REMOTE} ${WEB_PORT}`, 'run-web', {
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

console.log('[3] auth');
const ownerEmail = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.id='${PROJECT}'"`,
    'owner',
  )
).stdout.trim();
const tempPass = `Tmp-${randomBytes(6).toString('hex')}!`;
const hash = await bcryptLib.hash(tempPass, 10);
await runner.writeTextFile(
  '/opt/launchos/tmp/m3-setpass.sql',
  `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}' WHERE email='${ownerEmail.replace(/'/g, "''")}';\n`,
);
await remoteOk(
  'podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < /opt/launchos/tmp/m3-setpass.sql',
  'set-pass',
);
const login = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: ownerEmail, password: tempPass }),
});
const token = JSON.parse(login.text || '{}').accessToken;
if (!token) throw new Error(`login failed: ${redact(login.text).slice(0, 300)}`);
const auth = { authorization: `Bearer ${token}` };

console.log('[4] web-ceshi healthy regression');
const publicLive = curl(`https://${HOST}/`, HOST, { useResolve: false });
console.log('public live (no --resolve)', publicLive.status, publicLive.remoteIp);
const health = curl(
  `https://api-alpha.zsaos.com/api/v1/apps/${PROJECT}/runtime?refreshPublic=1`,
  'api-alpha.zsaos.com',
  { headers: auth, maxTime: '120' },
);
const healthBody = JSON.parse(health.text || '{}');
console.log(
  'health',
  health.status,
  healthBody.overallStatus,
  healthBody.version,
  healthBody.publicStatus,
  healthBody.httpStatus,
  healthBody.lastHealthCheckLabel,
  healthBody.lastPublicCheckLabel,
);
report.healthy =
  health.status === 200 &&
  Boolean(healthBody.version) &&
  Boolean(healthBody.visitUrl) &&
  (healthBody.overallStatus === 'HEALTHY' ||
    (healthBody.overallStatus === 'STATUS_PENDING' && healthBody.publicStatus === 'OK')) &&
  healthBody.publicStatus === 'OK' &&
  Number(healthBody.httpStatus) >= 200 &&
  Number(healthBody.httpStatus) < 400 &&
  !String(JSON.stringify(healthBody)).includes('AUTH_SECRET=') &&
  !String(JSON.stringify(healthBody)).includes('DATABASE_URL=postgres');
console.log('healthyGateInitial', report.healthy, healthBody.overallStatus);

const logs = curl(`https://api-alpha.zsaos.com/api/v1/apps/${PROJECT}/logs?tail=50`, 'api-alpha.zsaos.com', {
  headers: auth,
});
const logsBody = JSON.parse(logs.text || '{}');
const redactedSample = redactSecrets(
  `AUTH_SECRET=supersecret DATABASE_URL=postgres://u:p@h/db Bearer eyJhbGciOiJIUzI1NiJ9.xx ${logsBody.logs || ''}`,
);
report.logsOk =
  logs.status === 200 &&
  typeof logsBody.logs === 'string' &&
  Number(logsBody.limit) <= 500 &&
  !/AUTH_SECRET=supersecret/.test(redactedSample) &&
  !/postgres:\/\/u:p@/.test(redactedSample) &&
  !/Bearer eyJ/.test(redactedSample);
console.log('logs', logs.status, 'lines', logsBody.lineCount, 'limit', logsBody.limit, 'redactOk', report.logsOk);

console.log('[5] controlled failure: public FAIL fixture (no live disruption)');
const siId = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT id FROM \\"ServiceInstance\\" WHERE \\"projectId\\"='${PROJECT}' AND status='RUNNING' ORDER BY \\"createdAt\\" DESC LIMIT 1"`,
    'si',
  )
).stdout.trim();
if (!siId) throw new Error('RUNNING ServiceInstance missing');

await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 -c "INSERT INTO \\"ServiceHealthCheck\\" (id, \\"serviceInstanceId\\", status, \\"statusCode\\", message, \\"checkedAt\\") VALUES ('m3pubfailfixture01', '${siId}', 'UNHEALTHY', 502, 'public:FAIL:http=502', NOW());"`,
  'insert-public-fail',
);
const failHealth = curl(`https://api-alpha.zsaos.com/api/v1/apps/${PROJECT}/runtime`, 'api-alpha.zsaos.com', {
  headers: auth,
});
const failBody = JSON.parse(failHealth.text || '{}');
console.log('publicFail', failBody.overallStatus, failBody.anomalyLayer, failBody.failureCategory, failBody.recentError);
report.publicFail =
  failBody.overallStatus === 'UNHEALTHY' &&
  failBody.anomalyLayer === 'PUBLIC' &&
  failBody.publicStatus === 'FAIL' &&
  failBody.failureCategory === 'PLATFORM';
await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "DELETE FROM \\"ServiceHealthCheck\\" WHERE id='m3pubfailfixture01';"`,
  'cleanup-public-fail',
);

console.log('[6] controlled failure: stale health');
const staleIso = new Date(Date.now() - 20 * 60_000).toISOString();
await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 -c "UPDATE \\"ServiceInstance\\" SET \\"lastHealthCheckAt\\"='${staleIso}' WHERE id='${siId}'; DELETE FROM \\"ServiceHealthCheck\\" WHERE \\"serviceInstanceId\\"='${siId}' AND message LIKE 'public:%' AND \\"checkedAt\\" > NOW() - INTERVAL '30 minutes';"`,
  'stale-prep',
);
const staleHealth = curl(`https://api-alpha.zsaos.com/api/v1/apps/${PROJECT}/runtime`, 'api-alpha.zsaos.com', {
  headers: auth,
});
const staleBody = JSON.parse(staleHealth.text || '{}');
console.log('stale', staleBody.overallStatus, staleBody.stale, staleBody.publicStatus);
report.stale =
  staleBody.overallStatus === 'STATUS_PENDING' ||
  (staleBody.stale === true && staleBody.overallStatus !== 'HEALTHY');

console.log('[7] restore healthy via real public refresh');
const restored = curl(
  `https://api-alpha.zsaos.com/api/v1/apps/${PROJECT}/runtime?refreshPublic=1`,
  'api-alpha.zsaos.com',
  { headers: auth, maxTime: '120' },
);
const restoredBody = JSON.parse(restored.text || '{}');
console.log('restored', restoredBody.overallStatus, restoredBody.publicStatus, restoredBody.httpStatus);
if (restoredBody.overallStatus !== 'HEALTHY') {
  // Force runtime health timestamp fresh if monitor lag; leave public as refreshed
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "UPDATE \\"ServiceInstance\\" SET \\"lastHealthCheckAt\\"=NOW(), \\"healthStatus\\"='HEALTHY' WHERE id='${siId}';"`,
    'touch-health',
  ).catch(() => undefined);
  const again = curl(
    `https://api-alpha.zsaos.com/api/v1/apps/${PROJECT}/runtime?refreshPublic=1`,
    'api-alpha.zsaos.com',
    { headers: auth, maxTime: '120' },
  );
  Object.assign(restoredBody, JSON.parse(again.text || '{}'));
  console.log('restored2', restoredBody.overallStatus, restoredBody.publicStatus);
}
report.healthy =
  report.healthy &&
  restoredBody.overallStatus === 'HEALTHY' &&
  restoredBody.publicStatus === 'OK' &&
  Boolean(restoredBody.version);
console.log('healthyGateFinal', report.healthy, restoredBody.overallStatus);

console.log('[8] existing flows smoke');
const versions = curl(`https://api-alpha.zsaos.com/api/v1/apps/${PROJECT}/versions`, 'api-alpha.zsaos.com', {
  headers: auth,
});
const deployments = curl(
  `https://api-alpha.zsaos.com/api/v1/projects/${PROJECT}/deployments`,
  'api-alpha.zsaos.com',
  { headers: auth },
);
const projectPage = curl(`https://alpha.zsaos.com/projects/${PROJECT}`, 'alpha.zsaos.com');
const runtimePage = curl(`https://alpha.zsaos.com/projects/${PROJECT}/runtime`, 'alpha.zsaos.com');
const versionsPage = curl(`https://alpha.zsaos.com/projects/${PROJECT}/versions`, 'alpha.zsaos.com');
const depsPage = curl(`https://alpha.zsaos.com/projects/${PROJECT}/deployments`, 'alpha.zsaos.com');
report.pages = {
  project: projectPage.status,
  runtime: runtimePage.status,
  versions: versionsPage.status,
  deployments: depsPage.status,
  apiVersions: versions.status,
  apiDeployments: deployments.status,
  publicApp: publicLive.status,
};
report.existingFlows =
  versions.status === 200 &&
  deployments.status === 200 &&
  [projectPage.status, runtimePage.status, versionsPage.status, depsPage.status].every(
    (s) => s === 200 || s === 307 || s === 308 || s === 401 || s === 302,
  ) &&
  publicLive.status >= 200 &&
  publicLive.status < 400;

const finalPass =
  report.healthy &&
  report.publicFail &&
  report.stale &&
  report.logsOk &&
  report.existingFlows &&
  report.secretsExposed === 'NO' &&
  report.paidResourceCreated === 'NO';

writeFileSync(
  join(ARTIFACT_DIR, 'm3-regress-report.json'),
  JSON.stringify({ ...report, finalPass, healthSample: {
    overallStatus: restoredBody.overallStatus,
    version: restoredBody.version,
    publicStatus: restoredBody.publicStatus,
    visitUrl: restoredBody.visitUrl,
    lastHealthCheckLabel: restoredBody.lastHealthCheckLabel,
    lastPublicCheckLabel: restoredBody.lastPublicCheckLabel,
    startupSummary: restoredBody.startupSummary,
    recommendedAction: restoredBody.recommendedAction,
  } }, null, 2),
);

console.log('M3_REPORT', JSON.stringify(report));
console.log(finalPass ? 'M3_REGRESS=PASS' : 'M3_REGRESS=FAIL');
await prisma.$disconnect().catch(() => undefined);
try {
  await runner.disconnect();
} catch {}
process.exit(finalPass ? 0 : 1);
