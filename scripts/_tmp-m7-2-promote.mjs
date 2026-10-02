/**
 * Beta M7-2: Lifecycle Automation promote to Alpha.
 * node scripts/_tmp-m7-2-promote.mjs --confirm-m72
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
if (!process.argv.includes('--confirm-m72')) {
  console.error('pass --confirm-m72');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const { applyColocatedNginxRoute } = requireDomain('@launchos/domain');

const TARGET_HOST = '116.62.198.184';
const API_TAG = 'launchos-alpha-api:m72';
const API_REMOTE = `localhost/${API_TAG}`;
const WEB_TAG = 'launchos-alpha-web:m72';
const WEB_REMOTE = `localhost/${WEB_TAG}`;
const LIVE_WEB = 'launchos-alpha-web';
const CANDIDATE_WEB = 'launchos-alpha-web-m72-cand';
const WEB_PORT = 39082;
const CANDIDATE_PORT = 39098;
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
  writeFileSync(join(ARTIFACT_DIR, 'm72-api-build.log'), `${b.stdout || ''}\n${b.stderr || ''}`.slice(-400000));
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
  writeFileSync(join(ARTIFACT_DIR, 'm72-web-build.log'), `${b.stdout || ''}\n${b.stderr || ''}`.slice(-400000));
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
    `grep -Rsl '运营自动化\\|/admin/automation\\|生命周期状态\\|活动时间线' /app 2>/dev/null | head -20; echo MARK=$(grep -Rsl '运营自动化' /app 2>/dev/null | wc -l)`,
  ]);
  console.log(String(markers.stdout || '').trim().slice(-1000));
  if (!/MARK=[1-9]/.test(String(markers.stdout || ''))) throw new Error('M7-2 automation markers missing in web image');
}

console.log('[1c] apply lifecycle SQL on Alpha Postgres');
await runner.writeTextFile(
  '/opt/launchos/tmp/m72-lifecycle.sql',
  `
DO $$ BEGIN CREATE TYPE "LifecycleRuleStatus" AS ENUM ('ACTIVE', 'DISABLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "LifecycleActionType" AS ENUM ('ADD_TAG', 'CREATE_ALERT', 'SHOW_IN_ADMIN'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "LifecycleActionStatus" AS ENUM ('PENDING', 'COMPLETED', 'DISMISSED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "UserTagSource" AS ENUM ('SYSTEM', 'ADMIN'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "LifecycleRule" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "triggerEvent" TEXT NOT NULL,
  "conditionJson" JSONB NOT NULL DEFAULT '{}',
  "actionType" "LifecycleActionType" NOT NULL,
  "actionConfigJson" JSONB NOT NULL DEFAULT '{}',
  "status" "LifecycleRuleStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LifecycleRule_pkey" PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "UserTag" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tag" TEXT NOT NULL,
  "source" "UserTagSource" NOT NULL DEFAULT 'SYSTEM',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserTag_pkey" PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "LifecycleAction" (
  "id" TEXT NOT NULL,
  "ruleId" TEXT,
  "userId" TEXT NOT NULL,
  "actionType" "LifecycleActionType" NOT NULL,
  "status" "LifecycleActionStatus" NOT NULL DEFAULT 'PENDING',
  "detailJson" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LifecycleAction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "LifecycleRule_status_triggerEvent_idx" ON "LifecycleRule"("status", "triggerEvent");
CREATE INDEX IF NOT EXISTS "LifecycleRule_triggerEvent_idx" ON "LifecycleRule"("triggerEvent");
CREATE INDEX IF NOT EXISTS "UserTag_tag_createdAt_idx" ON "UserTag"("tag", "createdAt");
CREATE INDEX IF NOT EXISTS "UserTag_userId_createdAt_idx" ON "UserTag"("userId", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "UserTag_userId_tag_key" ON "UserTag"("userId", "tag");
CREATE INDEX IF NOT EXISTS "LifecycleAction_status_createdAt_idx" ON "LifecycleAction"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "LifecycleAction_userId_createdAt_idx" ON "LifecycleAction"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "LifecycleAction_ruleId_createdAt_idx" ON "LifecycleAction"("ruleId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "UserTag" ADD CONSTRAINT "UserTag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "LifecycleAction" ADD CONSTRAINT "LifecycleAction_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "LifecycleRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "LifecycleAction" ADD CONSTRAINT "LifecycleAction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
`,
);
await remoteOk(
  'podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < /opt/launchos/tmp/m72-lifecycle.sql',
  'lifecycle-sql',
);

if (!skipApi) {
  const tar = join(ARTIFACT_DIR, 'launchos-alpha-api-m72.tar');
  try {
    unlinkSync(tar);
  } catch {}
  if (local('docker', ['save', '-o', tar, API_TAG]).status !== 0) throw new Error('api save failed');
  console.log('[2a] upload api', statSync(tar).size);
  try {
    await runner.disconnect();
  } catch {}
  await runner.connect({ host: server.host, port: server.port, username, password });
  await runner.upload(tar, '/opt/launchos/tmp/launchos-alpha-api-m72.tar', { timeoutMs: 900000 });
  await remoteOk(
    `podman load -i /opt/launchos/tmp/launchos-alpha-api-m72.tar && rm -f /opt/launchos/tmp/launchos-alpha-api-m72.tar && (podman tag docker.io/library/${API_TAG} ${API_REMOTE} 2>/dev/null || podman tag ${API_TAG} ${API_REMOTE} 2>/dev/null || true)`,
    'api-load',
    600000,
  );
  await remoteOk(`/opt/launchos/bin/m5-run-api.sh launchos-alpha-api 39110 ${API_REMOTE}`, 'run-api', 120000);
  await remoteOk('/opt/launchos/tmp/m5-wait-api.sh', 'wait-api', 120000);
}

if (!skipWeb) {
  const tar = join(ARTIFACT_DIR, 'launchos-alpha-web-m72.tar');
  try {
    unlinkSync(tar);
  } catch {}
  if (local('docker', ['save', '-o', tar, WEB_TAG]).status !== 0) throw new Error('web save failed');
  console.log('[2b] upload web', statSync(tar).size);
  try {
    await runner.disconnect();
  } catch {}
  await runner.connect({ host: server.host, port: server.port, username, password });
  await runner.upload(tar, '/opt/launchos/tmp/launchos-alpha-web-m72.tar', { timeoutMs: 900000 });
  await remoteOk(
    `podman load -i /opt/launchos/tmp/launchos-alpha-web-m72.tar && rm -f /opt/launchos/tmp/launchos-alpha-web-m72.tar && (podman tag docker.io/library/${WEB_TAG} ${WEB_REMOTE} 2>/dev/null || podman tag ${WEB_TAG} ${WEB_REMOTE} 2>/dev/null || true)`,
    'web-load',
    600000,
  );

  await runner.writeTextFile(
    '/opt/launchos/bin/m72-run-web.sh',
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
  await remoteOk('chmod 700 /opt/launchos/bin/m72-run-web.sh', 'chmod');

  console.log('[3] candidate web');
  await remoteOk(`/opt/launchos/bin/m72-run-web.sh ${CANDIDATE_WEB} ${WEB_REMOTE} ${CANDIDATE_PORT}`, 'cand', 120000);
  await new Promise((r) => setTimeout(r, 4000));
  const cand = await remoteOk(
    `curl -sS -o /dev/null -w 'code=%{http_code}\\n' --max-time 15 http://127.0.0.1:${CANDIDATE_PORT}/login`,
    'cand-http',
  );
  if (!/code=200/.test(cand.stdout)) throw new Error('candidate unhealthy');

  console.log('[4] switch live web');
  await remoteOk(`/opt/launchos/bin/m72-run-web.sh ${LIVE_WEB} ${WEB_REMOTE} ${WEB_PORT}`, 'live', 120000);
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

const adminLogin = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
});
const adminToken = parse(adminLogin.text).accessToken;
if (!adminToken) throw new Error(`admin login failed: ${(adminLogin.text || '').slice(0, 300)}`);
const adminHdr = { authorization: `Bearer ${adminToken}` };

// Wait for default rules seed on API boot
await new Promise((r) => setTimeout(r, 8000));

const automation = curl('https://api-alpha.zsaos.com/api/v1/admin/automation', 'api-alpha.zsaos.com', {
  headers: adminHdr,
});
const rules = curl('https://api-alpha.zsaos.com/api/v1/admin/automation/rules', 'api-alpha.zsaos.com', {
  headers: adminHdr,
});
const create = curl('https://api-alpha.zsaos.com/api/v1/admin/automation/rules', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: adminHdr,
  body: JSON.stringify({
    name: `alpha-smoke-${Date.now()}`,
    description: 'm72 smoke',
    triggerEvent: 'PLAN_VIEWED',
    actionType: 'ADD_TAG',
    conditionJson: { kind: 'ALWAYS' },
    actionConfigJson: { tag: 'HIGH_VALUE', also: ['SHOW_IN_ADMIN'] },
  }),
});
const createdId = parse(create.text).id;
const toggle = createdId
  ? curl(`https://api-alpha.zsaos.com/api/v1/admin/automation/rules/${createdId}/toggle`, 'api-alpha.zsaos.com', {
      method: 'POST',
      headers: adminHdr,
    })
  : { status: 0, text: '' };
const scan = curl('https://api-alpha.zsaos.com/api/v1/admin/automation/scan', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: adminHdr,
  maxTime: '180',
});

const users = curl('https://api-alpha.zsaos.com/api/v1/admin/users?page=1&pageSize=1', 'api-alpha.zsaos.com', {
  headers: adminHdr,
});
const sampleUserId = parse(users.text)?.items?.[0]?.id;
const lifecycle = sampleUserId
  ? curl(`https://api-alpha.zsaos.com/api/v1/admin/users/${sampleUserId}/lifecycle`, 'api-alpha.zsaos.com', {
      headers: adminHdr,
    })
  : { status: 0, text: '{}' };

const userLogin = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: USER_EMAIL, password: USER_PASSWORD }),
});
const userToken = parse(userLogin.text).accessToken;
const userForbidden = userToken
  ? curl('https://api-alpha.zsaos.com/api/v1/admin/automation', 'api-alpha.zsaos.com', {
      headers: { authorization: `Bearer ${userToken}` },
    }).status
  : null;

const regress = {};
for (const path of ['/admin', '/admin/growth', '/admin/overview', '/billing', '/projects', '/runtime']) {
  if (path.startsWith('/admin')) {
    regress[path] = curl(`https://api-alpha.zsaos.com/api/v1${path === '/admin' ? '/admin/overview' : path === '/admin/growth' ? '/admin/growth/overview' : path}`, 'api-alpha.zsaos.com', {
      headers: adminHdr,
    }).status;
  } else {
    regress[path] = curl(`https://api-alpha.zsaos.com/api/v1${path === '/billing' ? '/billing/subscription' : path === '/projects' ? '/projects' : path === '/runtime' ? '/admin/runtime' : path}`, 'api-alpha.zsaos.com', {
      headers: path === '/runtime' ? adminHdr : userToken ? { authorization: `Bearer ${userToken}` } : adminHdr,
    }).status;
  }
}

const pages = {};
for (const p of ['/admin', '/admin/automation', '/admin/growth', '/overview', '/billing', '/projects']) {
  pages[p] = curl(`https://alpha.zsaos.com${p}`, 'alpha.zsaos.com', { useResolve: false }).status;
}

const liveWeb = await remoteOk(`podman inspect ${LIVE_WEB} --format '{{.ImageName}} {{.Image}}'`, 'inspect-web');
const liveApi = await remoteOk(`podman inspect launchos-alpha-api --format '{{.ImageName}} {{.Image}}'`, 'inspect-api');
const schemaCheck = await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT COUNT(*) FROM information_schema.tables WHERE table_name IN ('LifecycleRule','UserTag','LifecycleAction');"`,
  'schema-check',
);

const rulesCount = parse(rules.text)?.items?.length ?? 0;
const M7_LIFECYCLE_READY =
  automation.status === 200 &&
  rules.status === 200 &&
  [200, 201].includes(create.status) &&
  [200, 201].includes(toggle.status) &&
  [200, 201].includes(scan.status) &&
  lifecycle.status === 200 &&
  userForbidden === 403 &&
  rulesCount >= 4 &&
  pages['/admin/automation'] >= 200 &&
  pages['/admin/automation'] < 500 &&
  regress['/admin/growth'] === 200 &&
  Number(schemaCheck.stdout.trim()) >= 3;

const report = {
  apiImage: API_TAG,
  webImage: WEB_TAG,
  liveWeb: liveWeb.stdout.trim(),
  liveApi: liveApi.stdout.trim(),
  schemaCheck: schemaCheck.stdout.trim(),
  automationStatus: automation.status,
  rulesStatus: rules.status,
  rulesCount,
  createStatus: create.status,
  toggleStatus: toggle.status,
  scanStatus: scan.status,
  lifecycleStatus: lifecycle.status,
  lifecycleLabel: parse(lifecycle.text)?.statusLabel ?? null,
  userForbidden,
  regress,
  pages,
  emailSent: false,
  smsSent: false,
  paymentTriggered: false,
  paidResourceCreated: false,
  M7_LIFECYCLE_READY,
};
writeFileSync(join(ARTIFACT_DIR, 'm7-2-promote.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await prisma.$disconnect().catch(() => undefined);
try {
  await runner.disconnect();
} catch {}
process.exit(M7_LIFECYCLE_READY ? 0 : 1);
