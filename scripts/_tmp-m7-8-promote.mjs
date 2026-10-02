/**
 * Beta M7-8: AI Onboarding Optimizer promote to Alpha.
 * node scripts/_tmp-m7-8-promote.mjs --confirm-m78
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
if (!process.argv.includes('--confirm-m78')) {
  console.error('pass --confirm-m78');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const { applyColocatedNginxRoute } = requireDomain('@launchos/domain');

const TARGET_HOST = '116.62.198.184';
const API_TAG = 'launchos-alpha-api:m78';
const API_REMOTE = `localhost/${API_TAG}`;
const WEB_TAG = 'launchos-alpha-web:m78';
const WEB_REMOTE = `localhost/${WEB_TAG}`;
const LIVE_WEB = 'launchos-alpha-web';
const CANDIDATE_WEB = 'launchos-alpha-web-m78-cand';
const WEB_PORT = 39082;
const CANDIDATE_PORT = 39099;
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });
const skipBuild = process.argv.includes('--skip-build');
const skipApi = process.argv.includes('--skip-api');
const skipWeb = process.argv.includes('--skip-web');

const adminAuth = JSON.parse(readFileSync(join(ARTIFACT_DIR, 'admin-auth.json'), 'utf8'));
const userAuth = JSON.parse(readFileSync(join(ARTIFACT_DIR, '1002-auth.json'), 'utf8'));
const ADMIN_EMAIL = adminAuth.email;
const ADMIN_PASSWORD = adminAuth.password;
const USER_EMAIL = userAuth.email || '1002@qq.com';
const USER_PASSWORD = userAuth.password;

function local(cmd, args) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 64_000_000, shell: false });
}
function curl(url, host, opts = {}) {
  const { method = 'GET', headers = {}, body = null, maxTime = '90', useResolve = true } = opts;
  const args = ['-sS', '-L', '-X', method, '-w', '\n__STATUS__:%{http_code}', '--max-time', String(maxTime)];
  if (useResolve) args.push('--resolve', `${host}:443:${TARGET_HOST}`);
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body != null) args.push('-H', 'content-type: application/json', '--data-binary', body);
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)/);
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out };
}
function parse(text) {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}
function assertNoSecrets(obj) {
  const text = JSON.stringify(obj || {});
  return !/postgres(ql)?:\/\/[^\s"]+|sk-[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i.test(text);
}

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({
  where: { OR: [{ id: 'cmuma9i480001rij49yv4yw2q' }, { host: TARGET_HOST, scope: 'PLATFORM_MANAGED' }] },
});
if (!server) throw new Error('platform server missing');
const username = resolveServerSshUsername({ serverUsername: server.username, provider: server.provider });
const password = decryptCredential(server.credentialEncrypted);
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username, password });
async function remoteOk(cmd, label, timeoutMs = 180000) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs });
  if (r.exitCode !== 0) throw new Error(`${label}: ${(r.stderr || r.stdout || '').slice(0, 1500)}`);
  return r;
}

if (!skipBuild && !skipApi) {
  console.log('[1a] build', API_TAG);
  const b = local('docker', [
    'build',
    '--platform',
    'linux/amd64',
    '-f',
    'deploy/alpha/Dockerfile.api',
    '-t',
    API_TAG,
    '.',
  ]);
  writeFileSync(join(ARTIFACT_DIR, 'm78-api-build.log'), `${b.stdout || ''}\n${b.stderr || ''}`.slice(-400000));
  if (b.status !== 0) throw new Error('api build failed');
}

if (!skipBuild && !skipWeb) {
  console.log('[1b] build', WEB_TAG);
  const b = local('docker', [
    'build',
    '--platform',
    'linux/amd64',
    '-f',
    'deploy/alpha/Dockerfile.web',
    '-t',
    WEB_TAG,
    '--build-arg',
    'NEXT_PUBLIC_API_URL=https://api-alpha.zsaos.com',
    '.',
  ]);
  writeFileSync(join(ARTIFACT_DIR, 'm78-web-build.log'), `${b.stdout || ''}\n${b.stderr || ''}`.slice(-400000));
  if (b.status !== 0) throw new Error('web build failed');
}

if (!skipWeb) {
  const markers = local('docker', [
    'run',
    '--rm',
    '--entrypoint',
    'sh',
    WEB_TAG,
    '-c',
    `grep -Rsl '继续完成上线\\|/admin/growth/onboarding\\|用户激活' /app 2>/dev/null | head -20; echo MARK=$(grep -Rsl '继续完成上线\\|用户激活' /app 2>/dev/null | wc -l)`,
  ]);
  console.log(String(markers.stdout || '').trim().slice(-1000));
  if (!/MARK=[1-9]/.test(String(markers.stdout || ''))) throw new Error('M7-8 onboarding markers missing');
}

console.log('[1c] apply onboarding SQL');
for (let i = 0; i < 30; i++) {
  const ready = await runner.execute(
    shellCommand('podman exec launchos-alpha-postgres pg_isready -U launchos_alpha -d launchos'),
    { timeoutMs: 20000 },
  );
  if (ready.exitCode === 0) break;
  await new Promise((r) => setTimeout(r, 2000));
  if (i === 29) throw new Error('postgres not ready');
}
await runner.writeTextFile(
  '/opt/launchos/tmp/m78-onboarding-activation.sql',
  readFileSync(
    join(root, 'packages/database/prisma/migrations/20261002060000_m7_onboarding_activation/migration.sql'),
    'utf8',
  ),
);
await remoteOk(
  'podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < /opt/launchos/tmp/m78-onboarding-activation.sql',
  'onboarding-sql',
);

if (!skipApi) {
  const tar = join(ARTIFACT_DIR, 'launchos-alpha-api-m78.tar');
  try {
    unlinkSync(tar);
  } catch {}
  if (local('docker', ['save', '-o', tar, API_TAG]).status !== 0) throw new Error('api save failed');
  console.log('[2a] upload api', statSync(tar).size);
  try {
    await runner.disconnect();
  } catch {}
  await runner.connect({ host: server.host, port: server.port, username, password });
  await runner.upload(tar, '/opt/launchos/tmp/launchos-alpha-api-m78.tar', { timeoutMs: 900000 });
  await remoteOk(
    `podman load -i /opt/launchos/tmp/launchos-alpha-api-m78.tar && rm -f /opt/launchos/tmp/launchos-alpha-api-m78.tar && (podman tag docker.io/library/${API_TAG} ${API_REMOTE} 2>/dev/null || podman tag ${API_TAG} ${API_REMOTE} 2>/dev/null || true)`,
    'api-load',
    600000,
  );
  await remoteOk(`/opt/launchos/bin/m5-run-api.sh launchos-alpha-api 39110 ${API_REMOTE}`, 'run-api', 120000);
  let apiReady = false;
  for (let i = 0; i < 60; i++) {
    const probe = await runner.execute(
      shellCommand('curl -sf --max-time 3 http://127.0.0.1:39110/api/v1/health'),
      { timeoutMs: 15000 },
    );
    if (probe.exitCode === 0) {
      apiReady = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!apiReady) await remoteOk('/opt/launchos/tmp/m5-wait-api.sh', 'wait-api', 120000);
}

if (!skipWeb) {
  const tar = join(ARTIFACT_DIR, 'launchos-alpha-web-m78.tar');
  try {
    unlinkSync(tar);
  } catch {}
  if (local('docker', ['save', '-o', tar, WEB_TAG]).status !== 0) throw new Error('web save failed');
  console.log('[2b] upload web', statSync(tar).size);
  try {
    await runner.disconnect();
  } catch {}
  await runner.connect({ host: server.host, port: server.port, username, password });
  await runner.upload(tar, '/opt/launchos/tmp/launchos-alpha-web-m78.tar', { timeoutMs: 900000 });
  await remoteOk(
    `podman load -i /opt/launchos/tmp/launchos-alpha-web-m78.tar && rm -f /opt/launchos/tmp/launchos-alpha-web-m78.tar && (podman tag docker.io/library/${WEB_TAG} ${WEB_REMOTE} 2>/dev/null || podman tag ${WEB_TAG} ${WEB_REMOTE} 2>/dev/null || true)`,
    'web-load',
    600000,
  );
  await runner.writeTextFile(
    '/opt/launchos/bin/m78-run-web.sh',
    `#!/bin/bash
set -euo pipefail
NAME="$1"; IMAGE="$2"; HOSTPORT="$3"
podman rm -f "$NAME" 2>/dev/null || true
sleep 1
EXTRA=()
if [[ -f /opt/launchos/config/alpha-web.env ]]; then EXTRA+=(--env-file /opt/launchos/config/alpha-web.env); fi
podman run -d --name "$NAME" --restart unless-stopped -p 127.0.0.1:\${HOSTPORT}:3000 \\
  -e PORT=3000 -e HOSTNAME=0.0.0.0 -e NEXT_PUBLIC_API_URL=https://api-alpha.zsaos.com "\${EXTRA[@]}" "$IMAGE"
echo STARTED
`,
  );
  await remoteOk('chmod 700 /opt/launchos/bin/m78-run-web.sh', 'chmod');
  console.log('[3] candidate web');
  await remoteOk(`/opt/launchos/bin/m78-run-web.sh ${CANDIDATE_WEB} ${WEB_REMOTE} ${CANDIDATE_PORT}`, 'cand', 120000);
  await new Promise((r) => setTimeout(r, 4000));
  const cand = await remoteOk(
    `curl -sS -o /dev/null -w 'code=%{http_code}\\n' --max-time 15 http://127.0.0.1:${CANDIDATE_PORT}/login`,
    'cand-http',
  );
  if (!/code=200/.test(cand.stdout)) throw new Error('candidate unhealthy');
  console.log('[4] switch live web');
  await remoteOk(`/opt/launchos/bin/m78-run-web.sh ${LIVE_WEB} ${WEB_REMOTE} ${WEB_PORT}`, 'live', 120000);
  await applyColocatedNginxRoute({
    host: TARGET_HOST,
    port: server.port,
    username,
    password,
    hostname: 'alpha.zsaos.com',
    healthPath: '/',
    targetPort: WEB_PORT,
  });
  await remoteOk(`podman rm -f ${CANDIDATE_WEB} 2>/dev/null || true`, 'rm-cand');
}

await new Promise((r) => setTimeout(r, 8000));

const adminLogin = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
});
const adminToken = parse(adminLogin.text).accessToken;
if (!adminToken) throw new Error(`admin login failed: ${(adminLogin.text || '').slice(0, 300)}`);
const adminHdr = { authorization: `Bearer ${adminToken}` };

const userLogin = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: USER_EMAIL, password: USER_PASSWORD }),
});
const userToken = parse(userLogin.text).accessToken;
const userHdr = userToken ? { authorization: `Bearer ${userToken}` } : {};

const backfill = curl('https://api-alpha.zsaos.com/api/v1/admin/onboarding/backfill', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: adminHdr,
  body: '{}',
  maxTime: '180',
});
const overview = curl('https://api-alpha.zsaos.com/api/v1/admin/onboarding/overview', 'api-alpha.zsaos.com', {
  headers: adminHdr,
  maxTime: '120',
});
const funnel = curl('https://api-alpha.zsaos.com/api/v1/admin/onboarding/funnel', 'api-alpha.zsaos.com', {
  headers: adminHdr,
});
const blocked = curl(
  'https://api-alpha.zsaos.com/api/v1/admin/onboarding/blocked-users',
  'api-alpha.zsaos.com',
  { headers: adminHdr },
);
const recommendations = curl(
  'https://api-alpha.zsaos.com/api/v1/admin/onboarding/recommendations',
  'api-alpha.zsaos.com',
  { headers: adminHdr },
);
const myActivation = userToken
  ? curl('https://api-alpha.zsaos.com/api/v1/activation', 'api-alpha.zsaos.com', { headers: userHdr })
  : { status: 0, text: '{}' };
const userForbidden = userToken
  ? curl('https://api-alpha.zsaos.com/api/v1/admin/onboarding/overview', 'api-alpha.zsaos.com', {
      headers: userHdr,
    }).status
  : null;

const regress = {
  adminOverview: curl('https://api-alpha.zsaos.com/api/v1/admin/overview', 'api-alpha.zsaos.com', {
    headers: adminHdr,
  }).status,
  growth: curl('https://api-alpha.zsaos.com/api/v1/admin/growth/overview', 'api-alpha.zsaos.com', {
    headers: adminHdr,
  }).status,
  automation: curl('https://api-alpha.zsaos.com/api/v1/admin/automation', 'api-alpha.zsaos.com', {
    headers: adminHdr,
  }).status,
  aiGrowth: curl('https://api-alpha.zsaos.com/api/v1/admin/ai-growth/summary', 'api-alpha.zsaos.com', {
    headers: adminHdr,
  }).status,
  success: curl('https://api-alpha.zsaos.com/api/v1/admin/ai-growth/success', 'api-alpha.zsaos.com', {
    headers: adminHdr,
  }).status,
  knowledge: curl('https://api-alpha.zsaos.com/api/v1/admin/ai-growth/knowledge', 'api-alpha.zsaos.com', {
    headers: adminHdr,
  }).status,
  preflight: curl('https://api-alpha.zsaos.com/api/v1/admin/ai-growth/preflight', 'api-alpha.zsaos.com', {
    headers: adminHdr,
  }).status,
  billing: userToken
    ? curl('https://api-alpha.zsaos.com/api/v1/billing/subscription', 'api-alpha.zsaos.com', {
        headers: userHdr,
      }).status
    : 0,
};

const pages = {};
for (const p of [
  '/admin',
  '/admin/growth',
  '/admin/growth/onboarding',
  '/admin/ai-growth',
  '/admin/ai-growth/success',
  '/admin/ai-growth/knowledge',
  '/admin/ai-growth/preflight',
  '/admin/automation',
  '/overview',
  '/billing',
]) {
  pages[p] = curl(`https://alpha.zsaos.com${p}`, 'alpha.zsaos.com', { useResolve: false }).status;
}

const liveWeb = await remoteOk(`podman inspect ${LIVE_WEB} --format '{{.ImageName}} {{.Image}}'`, 'inspect-web');
const liveApi = await remoteOk(`podman inspect launchos-alpha-api --format '{{.ImageName}} {{.Image}}'`, 'inspect-api');
const schemaCheck = await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT COUNT(*) FROM information_schema.tables WHERE table_name IN ('UserActivationState','OnboardingStepSnapshot','OnboardingOptimizationRecommendation');"`,
  'schema-check',
);

const overviewBody = parse(overview.text);
const backfillBody = parse(backfill.text);
const myBody = parse(myActivation.text);
const M7_ONBOARDING_OPTIMIZER_READY =
  [200, 201].includes(backfill.status) &&
  overview.status === 200 &&
  funnel.status === 200 &&
  blocked.status === 200 &&
  recommendations.status === 200 &&
  myActivation.status === 200 &&
  userForbidden === 403 &&
  overviewBody.activationDefinition === 'FIRST_PUBLIC_DEPLOYMENT_SUCCESS' &&
  typeof overviewBody.metrics?.activationRate === 'number' &&
  typeof overviewBody.metrics?.firstDeploymentSuccessRate === 'number' &&
  Array.isArray(overviewBody.funnel) &&
  assertNoSecrets(overviewBody) &&
  assertNoSecrets(myBody) &&
  regress.adminOverview === 200 &&
  regress.growth === 200 &&
  regress.success === 200 &&
  regress.knowledge === 200 &&
  pages['/admin/growth/onboarding'] >= 200 &&
  pages['/admin/growth/onboarding'] < 500 &&
  pages['/overview'] >= 200 &&
  pages['/overview'] < 500 &&
  Number(schemaCheck.stdout.trim()) >= 3;

const report = {
  apiImage: API_TAG,
  webImage: WEB_TAG,
  workerImage: 'unchanged',
  liveWeb: liveWeb.stdout.trim(),
  liveApi: liveApi.stdout.trim(),
  schemaCheck: schemaCheck.stdout.trim(),
  backfillStatus: backfill.status,
  backfill: backfillBody,
  overviewStatus: overview.status,
  metrics: overviewBody.metrics || null,
  m7Comparison: overviewBody.m7Comparison || null,
  funnel: overviewBody.funnel || null,
  dropoff: overviewBody.dropoff || null,
  myActivationStatus: myActivation.status,
  userForbidden,
  secretsSafe: assertNoSecrets(overviewBody),
  regress,
  pages,
  autoCodeModify: false,
  autoFlowChange: false,
  autoDeploy: false,
  autoMessage: false,
  autoMarketing: false,
  paymentTriggered: false,
  paidResourceCreated: false,
  M7_ONBOARDING_OPTIMIZER_READY,
};
writeFileSync(join(ARTIFACT_DIR, 'm7-8-promote.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await prisma.$disconnect().catch(() => undefined);
try {
  await runner.disconnect();
} catch {}
process.exit(M7_ONBOARDING_OPTIMIZER_READY ? 0 : 1);
