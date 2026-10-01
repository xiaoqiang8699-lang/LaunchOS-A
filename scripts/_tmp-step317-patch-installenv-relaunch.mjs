/**
 * Hot-patch worker BUILD installEnv (include devDeps), seed WEB config, relaunch.
 * node scripts/_tmp-step317-patch-installenv-relaunch.mjs --confirm-patch-install
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
if (!process.argv.includes('--confirm-patch-install')) {
  console.error('pass --confirm-patch-install');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const bcryptLib = requireApi('bcrypt');

const TARGET_HOST = '116.62.198.184';
const LIVE = 'launchos-alpha-worker';
const PROJECT = 'cmunhwais0003rl01wqj1qy11';
const LAUNCH_RUN = 'cmunhwddb0019rl01fzipihgn';
const WEB_UNIT = 'cmunhwc9k000drl01gxu1qwq2';
const API_UNIT = 'cmunhwc9g000brl01bgid72o7';
const ENGINE_LOCAL = resolve(root, 'packages/deployment/dist/engine/deployment-engine.service.js');
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });

function redact(t) {
  return String(t || '').replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***');
}
function curl(url, host, opts = {}) {
  const { method = 'GET', headers = {}, body = null, maxTime = '90' } = opts;
  const args = [
    '-k', '-sS', '-X', method,
    '--resolve', `${host}:443:${TARGET_HOST}`,
    '-w', '\n__STATUS__:%{http_code}',
    '--max-time', String(maxTime),
  ];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body != null) args.push('-H', 'content-type: application/json', '--data-binary', body);
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)\s*$/);
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out };
}

if (!existsSync(ENGINE_LOCAL)) throw new Error('missing local engine dist');
const engineSrc = readFileSync(ENGINE_LOCAL, 'utf8');
if (!engineSrc.includes("NPM_CONFIG_PRODUCTION: 'false'")) {
  throw new Error('local engine missing installEnv fix — rebuild @launchos/deployment first');
}

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: TARGET_HOST } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});
async function remoteOk(command, label, opts = {}) {
  const r = await runner.execute(shellCommand(command), { timeoutMs: opts.timeoutMs ?? 180000 });
  if (r.exitCode !== 0) throw new Error(`${label}: ${redact(r.stderr || r.stdout || '').slice(0, 1500)}`);
  return r;
}

console.log('[1] patch worker deployment-engine');
await remoteOk('mkdir -p /opt/launchos/tmp /opt/launchos/bin', 'mkdir');
const remoteEngine = '/opt/launchos/tmp/deployment-engine.service.js';
await runner.upload(ENGINE_LOCAL, remoteEngine, { timeoutMs: 120000 });
await remoteOk(
  `podman cp ${remoteEngine} ${LIVE}:/app/packages/deployment/dist/engine/deployment-engine.service.js && podman exec ${LIVE} grep -c NPM_CONFIG_PRODUCTION /app/packages/deployment/dist/engine/deployment-engine.service.js`,
  'cp-engine',
);

console.log('[2] restart worker preserving inspect config');
await runner.writeTextFile(
  '/opt/launchos/bin/step317-restart-worker.sh',
  `#!/bin/bash
set -euo pipefail
LIVE=${LIVE}
IMAGE=$(podman inspect -f '{{.ImageName}}' "$LIVE" 2>/dev/null || podman inspect -f '{{.Config.Image}}' "$LIVE")
echo IMAGE="$IMAGE"
podman rm -f "$LIVE" 2>/dev/null || true
podman run -d --name "$LIVE" --restart unless-stopped --network host \\
  --env-file /opt/launchos/config/alpha-api.env --env-file /opt/launchos/config/alpha-github.env \\
  -e DOCKER_HOST=unix:///var/run/docker.sock \\
  -e ARTIFACT_STORE=local \\
  -e LOCAL_ARTIFACT_ROOT=/opt/launchos/artifacts \\
  -v /opt/launchos/config/github-app.pem:/run/secrets/github-app.pem:ro \\
  -v /opt/launchos/artifacts:/opt/launchos/artifacts \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  -v /run/podman/podman.sock:/run/podman/podman.sock \\
  --entrypoint /bin/sh "$IMAGE" \\
  -c 'export GITHUB_APP_PRIVATE_KEY="$(cat /run/secrets/github-app.pem)"; exec node apps/worker/dist/main.js'
# Re-apply hot patch onto the recreated container (image still pre-fix).
podman cp ${remoteEngine} "$LIVE":/app/packages/deployment/dist/engine/deployment-engine.service.js
podman restart "$LIVE"
sleep 5
podman exec "$LIVE" grep -c NPM_CONFIG_PRODUCTION /app/packages/deployment/dist/engine/deployment-engine.service.js
for i in 1 2 3 4 5 6 7 8 9 10; do
  if podman logs --tail 40 "$LIVE" 2>&1 | grep -q 'worker ready queue=deploymentQueue'; then
    echo WORKER_READY
    break
  fi
  sleep 2
done
podman logs --tail 40 "$LIVE" 2>&1 | tail -40
`,
);
await remoteOk('chmod 700 /opt/launchos/bin/step317-restart-worker.sh && /opt/launchos/bin/step317-restart-worker.sh', 'restart-worker', {
  timeoutMs: 180000,
});

console.log('[3] seed WEB runtime config');
const routes = await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT hostname, status, coalesce(\\"unitId\\",'') FROM \\"GatewayRoute\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"updatedAt\\" DESC LIMIT 10;"`,
  'routes',
);
console.log('ROUTES\n' + routes.stdout);
const apiHost =
  String(routes.stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith('api-') && l.includes('|ACTIVE|'))
    ?.split('|')[0] || 'api-launchos-multi-demo-5.launchos.app';
const apiUrl = `https://${apiHost}`;
console.log('API_URL', apiUrl);

await runner.writeTextFile(
  '/opt/launchos/tmp/step317-seed-web-config.mjs',
  `import { createRequire } from 'node:module';
const require = createRequire('/app/apps/api/package.json');
const { PrismaClient } = require('@launchos/database');
const { encryptCredential } = require('@launchos/shared');
const prisma = new PrismaClient();
const projectId = '${PROJECT}';
const webUnitId = '${WEB_UNIT}';
const apiUnitId = '${API_UNIT}';
const apiUrl = ${JSON.stringify(apiUrl)};
const sentry = 'https://public@sentry.invalid/0';
const defaultsByKey = {
  SENTRY_DSN: sentry,
  NEXT_PUBLIC_SENTRY_DSN: sentry,
  VITE_SENTRY_DSN: sentry,
  NEXT_PUBLIC_API_URL: apiUrl,
  VITE_API_URL: apiUrl,
  EXPO_PUBLIC_API_URL: apiUrl,
  API_URL: apiUrl,
  PUBLIC_API_URL: apiUrl,
  JWT_SECRET: 'alpha_' + require('crypto').randomBytes(24).toString('hex'),
};
for (const unitId of [webUnitId, apiUnitId]) {
  const reqs = await prisma.runtimeConfigRequirement.findMany({ where: { deployableUnitId: unitId } });
  for (const req of reqs) {
    const value = defaultsByKey[req.key];
    if (!value) { console.log('SKIP_NO_DEFAULT', unitId, req.key); continue; }
    await prisma.runtimeConfigValue.upsert({
      where: { scopeType_scopeId_key: { scopeType: 'UNIT', scopeId: unitId, key: req.key } },
      create: {
        projectId, scopeType: 'UNIT', scopeId: unitId, deployableUnitId: unitId,
        requirementId: req.id, key: req.key, valueEncrypted: encryptCredential(value),
        isSensitive: Boolean(req.sensitive), source: 'MANUAL',
        provider: 'MANUAL', providerRef: 'alpha-step317',
      },
      update: {
        valueEncrypted: encryptCredential(value), requirementId: req.id,
        isSensitive: Boolean(req.sensitive), source: 'MANUAL',
        provider: 'MANUAL', providerRef: 'alpha-step317',
      },
    });
    console.log('SEEDED', unitId, req.key);
  }
}
await prisma.$disconnect();
`,
);
const seed = await remoteOk(
  'podman cp /opt/launchos/tmp/step317-seed-web-config.mjs launchos-alpha-api:/tmp/step317-seed-web-config.mjs && podman exec -w /app launchos-alpha-api node /tmp/step317-seed-web-config.mjs',
  'seed',
);
console.log(seed.stdout || '');

console.log('[4] reset+launch');
await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "UPDATE \\"GitProviderConnection\\" SET status='ACTIVE' WHERE id='cmump0lbq0018rl01n2beawv6'; UPDATE \\"SourceRepository\\" SET \\"authStatus\\"='OK' WHERE \\"connectionId\\"='cmump0lbq0018rl01n2beawv6'; UPDATE \\"LaunchRun\\" SET status='WAITING_CONFIRMATION', \\"failureCode\\"=NULL, \\"failureMessage\\"=NULL, \\"finishedAt\\"=NULL, \\"startedAt\\"=NULL, \\"confirmationId\\"=NULL, \\"confirmedAt\\"=NULL, \\"confirmedByUserId\\"=NULL, \\"confirmedPlanHash\\"=NULL, \\"confirmationSnapshot\\"=NULL WHERE id='${LAUNCH_RUN}';"`,
  'reset',
);

const ownerEmail = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.id='${PROJECT}';"`,
    'owner',
  )
).stdout.trim();
const tempPass = `Alpha${randomBytes(6).toString('hex')}!aA1`;
const hash = await bcryptLib.hash(tempPass, 10);
await runner.writeTextFile(
  '/opt/launchos/tmp/step317-pass24.sql',
  `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}' WHERE email='${ownerEmail.replace(/'/g, "''")}';\n`,
);
await remoteOk(
  'podman cp /opt/launchos/tmp/step317-pass24.sql launchos-alpha-postgres:/tmp/step317-pass24.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/step317-pass24.sql',
  'pass',
);

const login = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: { origin: 'https://alpha.zsaos.com' },
  body: JSON.stringify({ email: ownerEmail, password: tempPass }),
});
const token = JSON.parse(login.text || '{}').accessToken;
if (!token) throw new Error('login failed ' + login.status);
const auth = { authorization: `Bearer ${token}`, origin: 'https://alpha.zsaos.com' };

console.log('PLAN', curl('https://api-alpha.zsaos.com/api/v1/onboarding/plan', 'api-alpha.zsaos.com', { method: 'POST', headers: auth, maxTime: '180' }).status);
console.log('CONFIRM', curl('https://api-alpha.zsaos.com/api/v1/onboarding/confirm', 'api-alpha.zsaos.com', { method: 'POST', headers: auth }).status);
const start = curl('https://api-alpha.zsaos.com/api/v1/onboarding/launch', 'api-alpha.zsaos.com', { method: 'POST', headers: auth });
console.log('START', start.status, redact(start.text).slice(0, 400));
if (start.status < 200 || start.status >= 300) throw new Error('start failed');

let final = null;
for (let i = 0; i < 240; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const st = curl('https://api-alpha.zsaos.com/api/v1/onboarding/launch', 'api-alpha.zsaos.com', { headers: auth, maxTime: '30' });
  try {
    final = JSON.parse(st.text || '{}');
  } catch {
    final = { status: 'PARSE_ERROR' };
  }
  console.log(`[poll ${i}] ${final.status} ${final.currentStage || ''} ${final.currentStep || ''} ${final.publicUrl || ''}`);
  if (['SUCCESS', 'FAILED', 'CANCELLED'].includes(final.status)) break;
}

await runner.writeTextFile(
  '/opt/launchos/bin/step317-result8.sh',
  `#!/bin/bash
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, \\"currentStage\\", \\"currentStep\\", coalesce(\\"failureCode\\",''), left(coalesce(\\"failureMessage\\",''),200) FROM \\"LaunchRun\\" WHERE id='${LAUNCH_RUN}';"
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"failureCode\\",''), left(coalesce(\\"errorMessage\\",''),180), coalesce(\\"deployableUnitId\\",''), \\"createdAt\\"::text FROM \\"Deployment\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"createdAt\\" DESC LIMIT 8;"
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"externalPort\\"::text,''), coalesce(\\"deployableUnitId\\",'') FROM \\"ServiceInstance\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"updatedAt\\" DESC LIMIT 8;"
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, hostname, status, coalesce(\\"unitId\\",'') FROM \\"GatewayRoute\\" WHERE \\"projectId\\"='${PROJECT}' ORDER BY \\"updatedAt\\" DESC LIMIT 10;"
podman exec ${LIVE} grep -c NPM_CONFIG_PRODUCTION /app/packages/deployment/dist/engine/deployment-engine.service.js
`,
);
const result = await remoteOk('chmod 700 /opt/launchos/bin/step317-result8.sh && /opt/launchos/bin/step317-result8.sh', 'result');
console.log('RESULT\n' + result.stdout);

const hosts = [
  ...new Set(
    String(result.stdout || '')
      .split(/\r?\n/)
      .flatMap((l) => [...l.matchAll(/([a-z0-9.-]+\.(?:zsaos\.com|launchos\.app))/g)].map((m) => m[1])),
  ),
];
for (const host of hosts) {
  const rootResp = curl(`https://${host}/`, host, { maxTime: '45' });
  const health = curl(`https://${host}/health`, host, { maxTime: '45' });
  console.log(
    'VERIFY',
    host,
    'root',
    rootResp.status,
    'health',
    health.status,
    redact(rootResp.text).slice(0, 140).replace(/\s+/g, ' '),
  );
}

writeFileSync(
  join(ARTIFACT_DIR, 'step317-patch-installenv-relaunch.txt'),
  redact(JSON.stringify({ final, result: result.stdout, hosts, apiUrl }, null, 2)),
);
await runner.disconnect();
await prisma.$disconnect();
process.exit(final?.status === 'SUCCESS' ? 0 : 1);
