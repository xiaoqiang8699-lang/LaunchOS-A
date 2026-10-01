/**
 * Align Free PlanVersion limits with BETA_PLAN_ENTITLEMENTS (maxProjects=1).
 * node scripts/_tmp-ux3-fix-free-limits.mjs --confirm
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
if (!process.argv.includes('--confirm')) process.exit(2);

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const bcryptLib = requireApi('bcrypt');
const TARGET_HOST = '116.62.198.184';

function curl(url, host, opts = {}) {
  const { method = 'GET', headers = {}, body = null, maxTime = '60' } = opts;
  const args = [
    '-sS', '-L', '-X', method, '-w', '\n__STATUS__:%{http_code}',
    '--max-time', String(maxTime), '--resolve', `${host}:443:${TARGET_HOST}`,
  ];
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
const username = resolveServerSshUsername({ serverUsername: server.username, provider: server.provider });
const password = decryptCredential(server.credentialEncrypted);
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username, password });
async function remoteOk(cmd, label, timeoutMs = 120000) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs });
  if (r.exitCode !== 0) throw new Error(`${label}: ${(r.stderr || r.stdout || '').slice(0, 800)}`);
  return r;
}

const freeLimits = JSON.stringify({
  maxProjects: 1,
  maxMembers: 1,
  maxWorkspaceMembers: 1,
  maxDeploymentsPerMonth: 10,
  maxMonthlyDeployments: 10,
  maxRunningApps: 1,
  maxRetainedVersions: 3,
  logRetentionDays: 1,
  maxServers: 0,
  maxDatabases: 0,
  maxRedisInstances: 0,
  maxBuildMinutesPerMonth: 60,
});
const freeFeatures = JSON.stringify({
  customDomainEnabled: false,
  rollbackEnabled: true,
  runtimeConfigEnabled: true,
});

await runner.writeTextFile(
  '/opt/launchos/tmp/ux3-fix-free-limits.sql',
  `UPDATE "PlanVersion" SET "limitsJson"='${freeLimits.replace(/'/g, "''")}'::jsonb, "featuresJson"='${freeFeatures.replace(/'/g, "''")}'::jsonb WHERE id='pv1_plan_free' OR ("planId" IN (SELECT id FROM "Plan" WHERE lower(code)='free') AND "effectiveTo" IS NULL);\nUPDATE "Plan" SET "maxProjects"=1, "maxMembers"=1, "maxDeploymentsPerMonth"=10 WHERE lower(code)='free';\n`,
);
await remoteOk(
  'podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < /opt/launchos/tmp/ux3-fix-free-limits.sql',
  'fix-limits',
);

// Pick a free workspace with >=1 ordinary project for block test.
const pick = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email || '|' || w.id FROM \\"Workspace\\" w JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" JOIN \\"Subscription\\" s ON s.\\"workspaceId\\"=w.id AND s.status='ACTIVE' JOIN \\"Plan\\" pl ON pl.id=s.\\"planId\\" LEFT JOIN \\"WorkspaceEntitlementOverride\\" o ON o.\\"workspaceId\\"=w.id AND o.\\"revokedAt\\" IS NULL WHERE lower(pl.code)='free' AND o.id IS NULL AND u.\\"platformRole\\" IS DISTINCT FROM 'PLATFORM_ADMIN' AND u.email <> '1002@qq.com' AND EXISTS (SELECT 1 FROM \\"Project\\" p WHERE p.\\"workspaceId\\"=w.id AND COALESCE(p.\\"isDemo\\",false)=false) ORDER BY w.\\"createdAt\\" ASC LIMIT 1"`,
    'pick',
  )
).stdout.trim();
if (!pick) throw new Error('no free test workspace');
const [email, workspaceId] = pick.split('|');
const tempPass = `Free-${randomBytes(6).toString('hex')}!`;
const hash = await bcryptLib.hash(tempPass, 10);
await runner.writeTextFile(
  '/opt/launchos/tmp/ux3-free-pass2.sql',
  `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g, "''")}' WHERE email='${email.replace(/'/g, "''")}';\n`,
);
await remoteOk(
  'podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < /opt/launchos/tmp/ux3-free-pass2.sql',
  'set-pass',
);

const login = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email, password: tempPass }),
});
const token = JSON.parse(login.text || '{}').accessToken;
if (!token) throw new Error(`login failed: ${(login.text || '').slice(0, 200)}`);
const auth = { authorization: `Bearer ${token}` };
const usage = curl('https://api-alpha.zsaos.com/api/v1/account/usage', 'api-alpha.zsaos.com', { headers: auth });
const usageBody = JSON.parse(usage.text || '{}');
const create = curl('https://api-alpha.zsaos.com/api/v1/projects', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({
    name: `ux3-block-${Date.now().toString(36)}`,
    applicationPurpose: 'WEBSITE',
    source: {
      type: 'GITHUB',
      url: 'https://github.com/vercel/next.js.git',
      branch: 'canary',
      fullName: 'vercel/next.js',
      isPrivate: false,
    },
  }),
});
let createBody = {};
try {
  createBody = JSON.parse(create.text || '{}');
} catch {}
const code =
  (typeof createBody.code === 'string' && createBody.code) ||
  (typeof createBody.message === 'object' && createBody.message?.code) ||
  null;

const out = {
  email,
  workspaceId,
  usageProjects: usageBody.ui?.projects ?? null,
  maxProjects: usageBody.entitlements?.maxProjects ?? null,
  createStatus: create.status,
  createCode: code,
  createMessage:
    typeof createBody.message === 'string'
      ? createBody.message
      : createBody.message?.message || null,
  blocked:
    usageBody.entitlements?.maxProjects === 1 &&
    Number(usageBody.usage?.projects || 0) >= 1 &&
    create.status === 403 &&
    String(code || '').includes('PROJECT_LIMIT'),
};
writeFileSync(join(root, '.tools/alpha-runtime/ux3-free-quota.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await prisma.$disconnect();
await runner.disconnect().catch(() => undefined);
process.exit(out.blocked ? 0 : 1);
