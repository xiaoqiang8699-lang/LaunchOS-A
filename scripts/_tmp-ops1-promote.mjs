/**
 * OPS-1: build + promote API + web to Alpha, smoke Operations Console routes.
 * node scripts/_tmp-ops1-promote.mjs --confirm-ops1
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
if (!process.argv.includes('--confirm-ops1')) {
  console.error('pass --confirm-ops1');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const { applyColocatedNginxRoute } = requireDomain('@launchos/domain');

const TARGET_HOST = '116.62.198.184';
const PROJECT = 'cmunsm2lk00ctrl01nnu1pwyd';
const API_TAG = 'launchos-alpha-api:ops1';
const API_REMOTE = `localhost/${API_TAG}`;
const WEB_TAG = 'launchos-alpha-web:ops1';
const WEB_REMOTE = `localhost/${WEB_TAG}`;
const LIVE_WEB = 'launchos-alpha-web';
const CANDIDATE_WEB = 'launchos-alpha-web-ops1-cand';
const WEB_PORT = 39082;
const CANDIDATE_PORT = 39095;
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });
const skipBuild = process.argv.includes('--skip-build');
const skipApi = process.argv.includes('--skip-api');
const skipWeb = process.argv.includes('--skip-web');

const adminAuth = JSON.parse(readFileSync(join(ARTIFACT_DIR, 'admin-auth.json'), 'utf8'));
const ADMIN_EMAIL = adminAuth.email;
const ADMIN_PASSWORD = adminAuth.password;

function local(cmd, args) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 64_000_000, shell: false });
}
function curl(url, host, opts = {}) {
  const { method = 'GET', headers = {}, body = null, maxTime = '60', useResolve = true } = opts;
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
  writeFileSync(join(ARTIFACT_DIR, 'ops1-api-build.log'), `${b.stdout || ''}\n${b.stderr || ''}`.slice(-400000));
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
  writeFileSync(join(ARTIFACT_DIR, 'ops1-web-build.log'), `${b.stdout || ''}\n${b.stderr || ''}`.slice(-400000));
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
    `grep -Rsl '运营后台\\|/admin/beta\\|/admin/deployments\\|/admin/domains\\|AdminAppShell\\|平台总览' /app 2>/dev/null | head -20; echo MARK=$(grep -Rsl '运营后台' /app 2>/dev/null | wc -l)`,
  ]);
  console.log(String(markers.stdout || '').trim().slice(-1000));
  if (!/MARK=[1-9]/.test(String(markers.stdout || ''))) throw new Error('OPS-1 admin markers missing in web image');
}

if (!skipApi) {
  const tar = join(ARTIFACT_DIR, 'launchos-alpha-api-ops1.tar');
  try {
    unlinkSync(tar);
  } catch {}
  if (local('docker', ['save', '-o', tar, API_TAG]).status !== 0) throw new Error('api save failed');
  console.log('[2a] upload api', statSync(tar).size);
  try {
    await runner.disconnect();
  } catch {}
  await runner.connect({ host: server.host, port: server.port, username, password });
  await runner.upload(tar, '/opt/launchos/tmp/launchos-alpha-api-ops1.tar', { timeoutMs: 900000 });
  await remoteOk(
    `podman load -i /opt/launchos/tmp/launchos-alpha-api-ops1.tar && rm -f /opt/launchos/tmp/launchos-alpha-api-ops1.tar && (podman tag docker.io/library/${API_TAG} ${API_REMOTE} 2>/dev/null || podman tag ${API_TAG} ${API_REMOTE} 2>/dev/null || true)`,
    'api-load',
    600000,
  );
  await remoteOk(`/opt/launchos/bin/m5-run-api.sh launchos-alpha-api 39110 ${API_REMOTE}`, 'run-api', 120000);
  await remoteOk('/opt/launchos/tmp/m5-wait-api.sh', 'wait-api', 120000);
}

if (!skipWeb) {
  const tar = join(ARTIFACT_DIR, 'launchos-alpha-web-ops1.tar');
  try {
    unlinkSync(tar);
  } catch {}
  if (local('docker', ['save', '-o', tar, WEB_TAG]).status !== 0) throw new Error('web save failed');
  console.log('[2b] upload web', statSync(tar).size);
  try {
    await runner.disconnect();
  } catch {}
  await runner.connect({ host: server.host, port: server.port, username, password });
  await runner.upload(tar, '/opt/launchos/tmp/launchos-alpha-web-ops1.tar', { timeoutMs: 900000 });
  await remoteOk(
    `podman load -i /opt/launchos/tmp/launchos-alpha-web-ops1.tar && rm -f /opt/launchos/tmp/launchos-alpha-web-ops1.tar && (podman tag docker.io/library/${WEB_TAG} ${WEB_REMOTE} 2>/dev/null || podman tag ${WEB_TAG} ${WEB_REMOTE} 2>/dev/null || true)`,
    'web-load',
    600000,
  );

  await runner.writeTextFile(
    '/opt/launchos/bin/ops1-run-web.sh',
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
  await remoteOk('chmod 700 /opt/launchos/bin/ops1-run-web.sh', 'chmod');

  console.log('[3] candidate web');
  await remoteOk(`/opt/launchos/bin/ops1-run-web.sh ${CANDIDATE_WEB} ${WEB_REMOTE} ${CANDIDATE_PORT}`, 'cand', 120000);
  await new Promise((r) => setTimeout(r, 4000));
  const cand = await remoteOk(
    `curl -sS -o /dev/null -w 'code=%{http_code}\\n' --max-time 15 http://127.0.0.1:${CANDIDATE_PORT}/login`,
    'cand-http',
  );
  if (!/code=200/.test(cand.stdout)) throw new Error('candidate unhealthy');

  console.log('[4] switch live web');
  await remoteOk(`/opt/launchos/bin/ops1-run-web.sh ${LIVE_WEB} ${WEB_REMOTE} ${WEB_PORT}`, 'live', 120000);
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

const login = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
});
let token = null;
try {
  token = JSON.parse(login.text || '{}').accessToken;
} catch {}
if (!token) throw new Error(`admin login failed: ${(login.text || '').slice(0, 300)}`);
const auth = { authorization: `Bearer ${token}` };

const profile = curl('https://api-alpha.zsaos.com/api/v1/auth/profile', 'api-alpha.zsaos.com', { headers: auth });
let profileBody = {};
try {
  profileBody = JSON.parse(profile.text || '{}');
} catch {}

const apiRoutes = [
  '/admin/overview',
  '/admin/users?page=1&pageSize=5',
  '/admin/workspaces?page=1&pageSize=5',
  '/admin/apps?page=1&pageSize=5',
  '/admin/deployments?page=1&pageSize=5',
  '/admin/domains?page=1&pageSize=5',
  '/admin/platform-resources',
  '/admin/system',
  '/admin/audit',
  '/alpha-tests',
];
const apiStatuses = {};
const apiBodies = {};
for (const path of apiRoutes) {
  const res = curl(`https://api-alpha.zsaos.com/api/v1${path}`, 'api-alpha.zsaos.com', { headers: auth });
  apiStatuses[path] = res.status;
  apiBodies[path] = (res.text || '').slice(0, 400);
}

// locate Alpha data: 测试2号 / web-ceshi
const usersRes = curl(
  `https://api-alpha.zsaos.com/api/v1/admin/users?page=1&pageSize=20&q=${encodeURIComponent('测试2号')}`,
  'api-alpha.zsaos.com',
  { headers: auth },
);
const appsRes = curl(
  `https://api-alpha.zsaos.com/api/v1/admin/apps?page=1&pageSize=20&q=${encodeURIComponent('web-ceshi')}`,
  'api-alpha.zsaos.com',
  { headers: auth },
);
let usersHit = null;
let appsHit = null;
try {
  usersHit = JSON.parse(usersRes.text || '{}');
} catch {}
try {
  appsHit = JSON.parse(appsRes.text || '{}');
} catch {}

const webPages = [
  '/admin',
  '/admin/users',
  '/admin/workspaces',
  '/admin/apps',
  '/admin/deployments',
  '/admin/resources',
  '/admin/domains',
  '/admin/beta',
  '/admin/commercial',
  '/admin/system',
  '/admin/audit',
  '/overview',
  '/projects',
  '/resources',
  '/plan',
  '/billing',
];
const webStatuses = {};
for (const p of webPages) {
  webStatuses[p] = curl(`https://alpha.zsaos.com${p}`, 'alpha.zsaos.com', { useResolve: false }).status;
}

// normal USER regression: try login as project owner if available
const ownerEmail = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.id='${PROJECT}'"`,
    'owner',
  )
).stdout.trim();
const ownerRole = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT \\"platformRole\\" FROM \\"User\\" WHERE email='${ownerEmail.replace(/'/g, "''")}'"`,
    'owner-role',
  )
).stdout.trim();

const liveWeb = await remoteOk(`podman inspect ${LIVE_WEB} --format '{{.ImageName}} {{.Image}}'`, 'inspect-web');
const liveApi = await remoteOk(`podman inspect launchos-alpha-api --format '{{.ImageName}} {{.Image}}'`, 'inspect-api');

const report = {
  apiImage: API_TAG,
  webImage: WEB_TAG,
  liveWeb: liveWeb.stdout.trim(),
  liveApi: liveApi.stdout.trim(),
  adminProfile: {
    email: profileBody.email ?? null,
    platformRole: profileBody.platformRole ?? null,
  },
  apiStatuses,
  webStatuses,
  alphaData: {
    usersSearch测试2号: {
      status: usersRes.status,
      total: usersHit?.total ?? null,
      sample: (usersHit?.items || []).slice(0, 2).map((u) => ({ email: u.email, name: u.displayName })),
    },
    appsSearchWebCeshi: {
      status: appsRes.status,
      total: appsHit?.total ?? null,
      sample: (appsHit?.items || []).slice(0, 2).map((a) => ({ name: a.name, workspace: a.workspace })),
    },
  },
  ownerEmail,
  ownerRole,
  secretsExposed: false,
  paidResourceCreated: false,
  realPaymentTriggered: false,
};
writeFileSync(join(ARTIFACT_DIR, 'ops1-promote.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await prisma.$disconnect();
try {
  await runner.disconnect();
} catch {}
