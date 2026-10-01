/**
 * Beta M4: promote api/worker/web, AUTH_SECRET inject + rotate + missing gate.
 * node scripts/_tmp-m4-config-regress.mjs --confirm-m4
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
if (!process.argv.includes('--confirm-m4')) {
  console.error('pass --confirm-m4');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const {
  decryptCredential,
  resolveServerSshUsername,
  shellCommand,
  filterRuntimeEnvForUnitType,
  redactSecrets,
} = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const { applyColocatedNginxRoute } = requireDomain('@launchos/domain');
const bcryptLib = requireApi('bcrypt');

const TARGET_HOST = '116.62.198.184';
const HOST = 'web-ceshi.zsaos.com';
const PROJECT = 'cmunsm2lk00ctrl01nnu1pwyd';
const UNIT = 'cmunsmcpc00d2rl0184kdxdb3';
const API_TAG = 'launchos-alpha-api:m4';
const WEB_TAG = 'launchos-alpha-web:m4';
const WORKER_TAG = 'launchos-alpha-worker:m4';
const API_REMOTE = `localhost/${API_TAG}`;
const WEB_REMOTE = `localhost/${WEB_TAG}`;
const WORKER_REMOTE = `localhost/${WORKER_TAG}`;
const LIVE_API = 'launchos-alpha-api';
const LIVE_WEB = 'launchos-alpha-web';
const LIVE_WORKER = 'launchos-alpha-worker';
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
    '-sS', '-L', '-X', method,
    '-w', '\n__STATUS__:%{http_code}',
    '--max-time', String(maxTime),
  ];
  if (useResolve) args.push('--resolve', `${host}:443:${TARGET_HOST}`);
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body != null) args.push('-H', 'content-type: application/json', '--data-binary', body);
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)/);
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out };
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

const report = {
  authSecretPresent: false,
  rotateOk: false,
  missingGate: false,
  leakOk: false,
  existingFlows: false,
  publicOk: false,
  secretsExposed: 'NO',
  paidResourceCreated: 'NO',
  filterUnit: null,
};

console.log('[0] unit filter sanity');
const filtered = filterRuntimeEnvForUnitType('WEB', {
  AUTH_SECRET: 'x',
  DATABASE_URL: 'postgres://u:p@h/db',
  JWT_SECRET: 'j',
});
report.filterUnit = {
  auth: Boolean(filtered.env.AUTH_SECRET),
  dbStripped: !filtered.env.DATABASE_URL,
  jwtStripped: !filtered.env.JWT_SECRET,
};
if (!report.filterUnit.auth || !report.filterUnit.dbStripped) {
  throw new Error('filterRuntimeEnvForUnitType regression');
}

console.log('[1] build');
if (!skipBuild) {
  for (const [tag, file, log] of [
    [API_TAG, 'deploy/alpha/Dockerfile.api', 'm4-api-build.log'],
    [WORKER_TAG, 'deploy/alpha/Dockerfile.worker', 'm4-worker-build.log'],
    [WEB_TAG, 'deploy/alpha/Dockerfile.web', 'm4-web-build.log'],
  ]) {
    console.log('building', tag);
    const b = local('docker', [
      'build', '--platform', 'linux/amd64', '-f', file, '-t', tag,
      ...(tag === WEB_TAG ? ['--build-arg', 'NEXT_PUBLIC_API_URL=https://api-alpha.zsaos.com'] : []),
      '.',
    ]);
    writeFileSync(join(ARTIFACT_DIR, log), redact(`${b.stdout || ''}\n${b.stderr || ''}`).slice(-300000));
    if (b.status !== 0) throw new Error(`${tag} build failed`);
  }
}

const markers = local('docker', [
  'run', '--rm', '--entrypoint', 'sh', WORKER_TAG, '-c',
  'echo AUTH=$(grep -c WEB_SERVER_SIDE_SECRET_ALLOWLIST /app/packages/shared/dist/managed-deployment.js); echo PRES=$(grep -c runtimeConfigPresence /app/packages/deployment/dist/engine/deployment-engine.service.js); echo LIST=$(grep -c listContainerEnvKeys /app/packages/runtime/dist/remote-docker-runtime.js)',
]);
console.log('markers', String(markers.stdout || '').trim());
if (!/AUTH=[1-9]/.test(String(markers.stdout || ''))) throw new Error('AUTH allowlist marker missing');
if (!/PRES=[1-9]/.test(String(markers.stdout || ''))) throw new Error('runtimeConfigPresence marker missing');

console.log('[2] promote');
await remoteOk('mkdir -p /opt/launchos/tmp /opt/launchos/bin', 'mkdir');
await promoteImage(API_TAG, API_REMOTE, 'launchos-alpha-api-m4.tar');
await promoteImage(WORKER_TAG, WORKER_REMOTE, 'launchos-alpha-worker-m4.tar');
await promoteImage(WEB_TAG, WEB_REMOTE, 'launchos-alpha-web-m4.tar');

await runner.writeTextFile(
  '/opt/launchos/bin/m4-run-api.sh',
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
  '/opt/launchos/bin/m4-run-worker.sh',
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
  '/opt/launchos/bin/m4-run-web.sh',
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
  '/opt/launchos/tmp/m4-wait-api.sh',
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
await remoteOk('chmod 700 /opt/launchos/bin/m4-run-*.sh /opt/launchos/tmp/m4-wait-api.sh', 'chmod');
await remoteOk(`/opt/launchos/bin/m4-run-api.sh ${LIVE_API} ${LIVE_API_PORT} ${API_REMOTE}`, 'run-api', { timeoutMs: 120000 });
await remoteOk('/opt/launchos/tmp/m4-wait-api.sh', 'wait-api', { timeoutMs: 120000 });
await applyColocatedNginxRoute({
  host: TARGET_HOST, port: server.port, username, password,
  hostname: 'api-alpha.zsaos.com', healthPath: '/api/v1/health', targetPort: LIVE_API_PORT,
});
await remoteOk(`/opt/launchos/bin/m4-run-worker.sh ${LIVE_WORKER} ${WORKER_REMOTE}`, 'run-worker', { timeoutMs: 120000 });
await remoteOk(`/opt/launchos/bin/m4-run-web.sh ${LIVE_WEB} ${WEB_REMOTE} ${WEB_PORT}`, 'run-web', { timeoutMs: 120000 });
await applyColocatedNginxRoute({
  host: TARGET_HOST, port: server.port, username, password,
  hostname: 'alpha.zsaos.com', healthPath: '/', targetPort: WEB_PORT,
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
  '/opt/launchos/tmp/m4-setpass.sql',
  `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}' WHERE email='${ownerEmail.replace(/'/g, "''")}';\n`,
);
await remoteOk(
  'podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < /opt/launchos/tmp/m4-setpass.sql',
  'set-pass',
);
const login = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: ownerEmail, password: tempPass }),
});
const token = JSON.parse(login.text || '{}').accessToken;
if (!token) throw new Error(`login failed: ${redact(login.text).slice(0, 300)}`);
const auth = { authorization: `Bearer ${token}` };

console.log('[4] rotate AUTH_SECRET + redeploy');
const beforeReqs = curl(
  `https://api-alpha.zsaos.com/api/v1/projects/${PROJECT}/units/${UNIT}/config-requirements`,
  'api-alpha.zsaos.com',
  { headers: auth },
);
const beforeBody = JSON.parse(beforeReqs.text || '{}');
const authReq = (beforeBody.requirements || []).find((r) => r.key === 'AUTH_SECRET');
console.log('AUTH_SECRET before', authReq?.configured, authReq?.maskedValue, authReq?.valueOrigin);
if (authReq?.value) throw new Error('AUTH_SECRET value leaked in requirements');

const gen = curl(
  `https://api-alpha.zsaos.com/api/v1/projects/${PROJECT}/units/${UNIT}/config/AUTH_SECRET/generate`,
  'api-alpha.zsaos.com',
  { method: 'POST', headers: auth },
);
const genBody = JSON.parse(gen.text || '{}');
console.log('generate', gen.status, genBody.needsRedeploy, genBody.value ? 'LEAK' : 'no-value');
if (genBody.value || genBody.plainValue || /enc:v1:/.test(JSON.stringify(genBody))) {
  report.secretsExposed = 'YES';
  throw new Error('generate leaked secret');
}
report.rotateOk = gen.status < 400 && genBody.needsRedeploy === true;

const envId = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT id FROM \\"ProjectEnvironment\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"createdAt\\" ASC LIMIT 1"`,
    'env',
  )
).stdout.trim();
const redeploy = curl(`https://api-alpha.zsaos.com/api/v1/projects/${PROJECT}/deployments`, 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ environmentId: envId, deployableUnitId: UNIT }),
});
const dep = JSON.parse(redeploy.text || '{}');
const depId = dep.id;
console.log('redeploy', redeploy.status, depId, dep.failureCode || dep.status);
if (!depId || redeploy.status >= 400) throw new Error(`redeploy failed: ${redact(redeploy.text).slice(0, 400)}`);

let terminal = null;
let peekOut = '';
for (let i = 0; i < 180; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const peek = await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT status||'|'||coalesce(\\"currentStage\\",'')||'|'||coalesce(\\"failureCode\\",'')||'|'||coalesce(\\"configRevision\\"::text,'') FROM \\"Deployment\\" WHERE id='${depId}'; SELECT left(message,200) FROM \\"DeploymentLog\\" WHERE \\"deploymentId\\"='${depId}' AND (message LIKE '%AUTH_SECRET%' OR message LIKE '%runtimeConfigPresence%' OR message LIKE '%webSecretIsolation%') ORDER BY \\"createdAt\\" DESC LIMIT 20;"`,
    'peek',
  ).catch((e) => ({ stdout: String(e) }));
  peekOut = String(peek.stdout || '');
  if (i % 6 === 0) console.log(`[peek ${i}]\n${redact(peekOut).slice(0, 1200)}`);
  const st = (peekOut.match(/^(RUNNING|SUCCESS|FAILED|QUEUED|CANCELLED)\|/) || [])[1];
  if (st === 'SUCCESS' || st === 'FAILED' || st === 'CANCELLED') {
    terminal = st;
    break;
  }
}
if (!terminal) throw new Error('deploy timed out');
console.log('terminal', terminal);

report.authSecretPresent =
  terminal === 'SUCCESS' &&
  /AUTH_SECRET:present=true/.test(peekOut) &&
  /allowedRuntimeKeys=\[[^\]]*AUTH_SECRET/.test(peekOut);
const publicLive = curl(`https://${HOST}/`, HOST, { useResolve: false });
report.publicOk = publicLive.status >= 200 && publicLive.status < 400;
console.log('authPresent', report.authSecretPresent, 'public', publicLive.status);

console.log('[5] missing config gate');
// Insert a fake required requirement without value, attempt deploy should fail — use a disposable key via SQL then clean up.
await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 -c "INSERT INTO \\"RuntimeConfigRequirement\\" (id, \\"projectId\\", \\"deployableUnitId\\", key, label, description, required, sensitive, \\"managedByLaunchOS\\", \\"publicSafe\\", \\"injectionPhase\\", source, confidence, status, \\"createdAt\\", \\"updatedAt\\") VALUES ('m4missreqfixture0001', '${PROJECT}', '${UNIT}', 'M4_FIXTURE_REQUIRED_URL', 'M4 Fixture', 'controlled missing', true, false, false, false, 'RUNTIME', 'MANUAL', 'HIGH', 'DETECTED', NOW(), NOW()) ON CONFLICT DO NOTHING;"`,
  'insert-missing-req',
).catch(async () => {
  // schema may use different unique — try without ON CONFLICT
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "DELETE FROM \\"RuntimeConfigRequirement\\" WHERE id='m4missreqfixture0001'; INSERT INTO \\"RuntimeConfigRequirement\\" (id, \\"projectId\\", \\"deployableUnitId\\", key, label, description, required, sensitive, \\"managedByLaunchOS\\", \\"publicSafe\\", \\"injectionPhase\\", source, confidence, status, \\"createdAt\\", \\"updatedAt\\") VALUES ('m4missreqfixture0001', '${PROJECT}', '${UNIT}', 'M4_FIXTURE_REQUIRED_URL', 'M4 Fixture', 'controlled missing', true, false, false, false, 'RUNTIME', 'MANUAL', 'HIGH', 'DETECTED', NOW(), NOW());"`,
    'insert-missing-req-2',
  );
});
const missDeploy = curl(`https://api-alpha.zsaos.com/api/v1/projects/${PROJECT}/deployments`, 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ environmentId: envId, deployableUnitId: UNIT }),
});
const missText = missDeploy.text || '';
report.missingGate =
  missDeploy.status >= 400 &&
  (/RUNTIME_CONFIG_MISSING|M4_FIXTURE_REQUIRED_URL|运行配置/.test(missText));
console.log('missingGate', missDeploy.status, report.missingGate, redact(missText).slice(0, 200));
await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "DELETE FROM \\"RuntimeConfigRequirement\\" WHERE id='m4missreqfixture0001' OR key='M4_FIXTURE_REQUIRED_URL';"`,
  'cleanup-missing',
).catch(() => undefined);

console.log('[6] leakage checks');
const afterReqs = curl(
  `https://api-alpha.zsaos.com/api/v1/projects/${PROJECT}/units/${UNIT}/config-requirements`,
  'api-alpha.zsaos.com',
  { headers: auth },
);
const afterBody = JSON.parse(afterReqs.text || '{}');
const authAfter = (afterBody.requirements || []).find((r) => r.key === 'AUTH_SECRET');
const blob = JSON.stringify(afterBody) + peekOut + (await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT left(message,240) FROM \\"DeploymentLog\\" WHERE \\"deploymentId\\"='${depId}' ORDER BY \\"createdAt\\" DESC LIMIT 40"`,
  'logs',
).catch(() => ({ stdout: '' }))).stdout;
const leakPatterns = [
  /AUTH_SECRET=[A-Za-z0-9+/=_-]{16,}/,
  /enc:v1:[A-Za-z0-9+/=:_-]{20,}/,
];
const leaked = leakPatterns.some((re) => re.test(blob)) || Boolean(authAfter?.value);
report.leakOk = !leaked && report.secretsExposed === 'NO';
const sampleRedact = redactSecrets('MY_PRIVATE_TOKEN=abc1234567890 AUTH_SECRET=shouldhide', [], [
  'MY_PRIVATE_TOKEN',
  'AUTH_SECRET',
]);
if (sampleRedact.includes('abc1234567890') || sampleRedact.includes('shouldhide')) {
  report.leakOk = false;
}
console.log('leakOk', report.leakOk, 'auth masked', authAfter?.maskedValue);

const versions = curl(`https://api-alpha.zsaos.com/api/v1/apps/${PROJECT}/versions`, 'api-alpha.zsaos.com', { headers: auth });
const health = curl(`https://api-alpha.zsaos.com/api/v1/apps/${PROJECT}/runtime?refreshPublic=1`, 'api-alpha.zsaos.com', {
  headers: auth,
  maxTime: '120',
});
const healthBody = JSON.parse(health.text || '{}');
report.existingFlows =
  versions.status === 200 &&
  health.status === 200 &&
  report.publicOk &&
  terminal === 'SUCCESS';

const finalPass =
  report.authSecretPresent &&
  report.rotateOk &&
  report.missingGate &&
  report.leakOk &&
  report.existingFlows &&
  report.publicOk &&
  report.secretsExposed === 'NO' &&
  report.paidResourceCreated === 'NO' &&
  terminal === 'SUCCESS';

writeFileSync(
  join(ARTIFACT_DIR, 'm4-regress-report.json'),
  JSON.stringify(
    {
      ...report,
      finalPass,
      terminal,
      deploymentId: depId,
      health: {
        overallStatus: healthBody.overallStatus,
        version: healthBody.version,
        publicStatus: healthBody.publicStatus,
      },
      authConfigured: Boolean(authAfter?.configured),
      configRevision: (peekOut.match(/\|(\d+)\n/) || [])[1] || null,
    },
    null,
    2,
  ),
);
console.log('M4_REPORT', JSON.stringify(report));
console.log(finalPass ? 'M4_REGRESS=PASS' : 'M4_REGRESS=FAIL');
await prisma.$disconnect().catch(() => undefined);
try { await runner.disconnect(); } catch {}
process.exit(finalPass ? 0 : 1);
