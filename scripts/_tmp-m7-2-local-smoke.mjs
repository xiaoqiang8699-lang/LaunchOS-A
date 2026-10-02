/**
 * Local smoke for M7-2 Lifecycle Automation.
 * node scripts/_tmp-m7-2-local-smoke.mjs
 */
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const bcrypt = requireApi('bcrypt');
const prisma = new PrismaClient();
const API = process.env.API_URL || 'http://127.0.0.1:3001/api/v1';
const PASS = '12345678';

async function login(email, password) {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
async function req(path, token, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    method: opts.method || 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.body || undefined,
  });
  return { status: res.status, json: await res.json().catch(async () => ({ raw: await res.text() })) };
}

const hash = await bcrypt.hash(PASS, 10);
const admin = await prisma.user.findFirst({ where: { platformRole: 'PLATFORM_ADMIN' } });
const user =
  (await prisma.user.findFirst({ where: { email: '1002@qq.com' } })) ||
  (await prisma.user.findFirst({ where: { platformRole: 'USER' } }));
if (!admin || !user) throw new Error('missing users');
await prisma.user.update({ where: { id: admin.id }, data: { passwordHash: hash } });
await prisma.user.update({ where: { id: user.id }, data: { passwordHash: hash } });

const adminLogin = await login(admin.email, PASS);
const userLogin = await login(user.email, PASS);
const adminToken = adminLogin.json.accessToken;
const userToken = userLogin.json.accessToken;
if (!adminToken || !userToken) throw new Error('login failed');

const checks = {};
checks.overview = await req('/admin/automation', adminToken);
checks.rules = await req('/admin/automation/rules', adminToken);
checks.create = await req('/admin/automation/rules', adminToken, {
  method: 'POST',
  body: JSON.stringify({
    name: `M72 smoke ${Date.now()}`,
    description: 'temp',
    triggerEvent: 'PLAN_VIEWED',
    actionType: 'ADD_TAG',
    actionConfigJson: { tag: 'HIGH_VALUE', also: ['SHOW_IN_ADMIN'] },
    conditionJson: { kind: 'ALWAYS' },
  }),
});
const createdId = checks.create.json?.id;
checks.toggle = createdId
  ? await req(`/admin/automation/rules/${createdId}/toggle`, adminToken, { method: 'POST' })
  : { status: 0, json: {} };

// Trigger via ProductEvent track path indirectly: insert event + scan
await prisma.productEvent.create({
  data: {
    name: 'DEPLOY_FAILED',
    userId: user.id,
    metadata: { errorMessage: 'm7-2 smoke failure', failureCode: 'SMOKE' },
  },
});
checks.scan = await req('/admin/automation/scan', adminToken, { method: 'POST' });
checks.lifecycle = await req(`/admin/users/${user.id}/lifecycle`, adminToken);
checks.userForbidden = await req('/admin/automation', userToken);
checks.growthStill = await req('/admin/growth/overview', adminToken);

const tags = await prisma.userTag.findMany({ where: { userId: user.id } });
const summary = {
  statuses: Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v.status])),
  rulesCount: checks.rules.json?.items?.length ?? 0,
  activeRules: checks.overview.json?.activeRules ?? null,
  lifecycleStatus: checks.lifecycle.json?.statusLabel ?? null,
  tags: tags.map((t) => t.tag),
  timelineLen: checks.lifecycle.json?.timeline?.length ?? 0,
  M7_LIFECYCLE_READY_LOCAL:
    checks.overview.status === 200 &&
    checks.rules.status === 200 &&
    [200, 201].includes(checks.create.status) &&
    [200, 201].includes(checks.scan.status) &&
    checks.lifecycle.status === 200 &&
    checks.userForbidden.status === 403 &&
    checks.growthStill.status === 200 &&
    (checks.rules.json?.items?.length || 0) >= 4,
};

mkdirSync(resolve(root, '.tools/alpha-runtime'), { recursive: true });
writeFileSync(
  resolve(root, '.tools/alpha-runtime/m7-2-local-smoke.json'),
  JSON.stringify({ summary, checks, tags }, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
await prisma.$disconnect();
process.exit(summary.M7_LIFECYCLE_READY_LOCAL ? 0 : 1);
