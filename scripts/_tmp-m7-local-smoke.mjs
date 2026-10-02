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

async function get(path, token) {
  const res = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: res.status, json: await res.json().catch(async () => ({ raw: await res.text() })) };
}

const hash = await bcrypt.hash(PASS, 10);
const admin = await prisma.user.findFirst({ where: { platformRole: 'PLATFORM_ADMIN' } });
const user =
  (await prisma.user.findFirst({ where: { email: '1002@qq.com' } })) ||
  (await prisma.user.findFirst({ where: { platformRole: 'USER', email: { not: 'demo@launchos.dev' } } }));

if (!admin || !user) throw new Error('missing admin/user');

await prisma.user.update({ where: { id: admin.id }, data: { passwordHash: hash } });
await prisma.user.update({ where: { id: user.id }, data: { passwordHash: hash } });

const adminLogin = await login(admin.email, PASS);
const userLogin = await login(user.email, PASS);
if (adminLogin.status >= 400 || !adminLogin.json.accessToken) {
  throw new Error(`admin login failed: ${JSON.stringify(adminLogin)}`);
}
if (userLogin.status >= 400 || !userLogin.json.accessToken) {
  throw new Error(`user login failed: ${JSON.stringify(userLogin)}`);
}

const adminToken = adminLogin.json.accessToken;
const userToken = userLogin.json.accessToken;

const checks = {};
for (const p of [
  '/admin/growth/overview',
  '/admin/growth/funnel',
  '/admin/growth/usage',
  '/admin/growth/events',
  '/admin/growth/commercial',
  `/admin/users/${user.id}/health`,
]) {
  checks[`ADMIN ${p}`] = await get(p, adminToken);
}
checks['USER /admin/growth/overview'] = await get('/admin/growth/overview', userToken);
checks['USER /admin/growth/funnel'] = await get('/admin/growth/funnel', userToken);
checks['USER /admin/overview'] = await get('/admin/overview', userToken);

const event = await prisma.productEvent.create({
  data: {
    name: 'PROJECT_CREATED',
    userId: user.id,
    metadata: { source: 'm7_smoke' },
  },
});
checks['ADMIN events after write'] = await get('/admin/growth/events?eventType=PROJECT_CREATED&pageSize=5', adminToken);

const summary = {
  adminEmail: admin.email,
  userEmail: user.email,
  statuses: Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v.status])),
  overview: checks['ADMIN /admin/growth/overview'].json,
  funnelSteps: checks['ADMIN /admin/growth/funnel'].json?.steps?.map((s) => `${s.label}:${s.count}/${s.rate}%`),
  health: checks[`ADMIN /admin/users/${user.id}/health`].json,
  eventId: event.id,
  eventsTotal: checks['ADMIN events after write'].json?.total,
  M7_GROWTH_READY_LOCAL:
    checks['ADMIN /admin/growth/overview'].status === 200 &&
    checks['ADMIN /admin/growth/funnel'].status === 200 &&
    checks['ADMIN /admin/growth/usage'].status === 200 &&
    checks['ADMIN /admin/growth/events'].status === 200 &&
    checks['ADMIN /admin/growth/commercial'].status === 200 &&
    checks[`ADMIN /admin/users/${user.id}/health`].status === 200 &&
    checks['USER /admin/growth/overview'].status === 403 &&
    Number(checks['ADMIN events after write'].json?.total || 0) >= 1,
};

mkdirSync(resolve(root, '.tools/alpha-runtime'), { recursive: true });
writeFileSync(resolve(root, '.tools/alpha-runtime/m7-local-smoke.json'), JSON.stringify({ summary, checks }, null, 2));
console.log(JSON.stringify(summary, null, 2));
await prisma.$disconnect();
process.exit(summary.M7_GROWTH_READY_LOCAL ? 0 : 1);
