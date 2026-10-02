/**
 * Local smoke M7-3 AI Growth Assistant
 * node scripts/_tmp-m7-3-local-smoke.mjs
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
async function req(path, token) {
  const res = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}` },
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

const adminToken = (await login(admin.email, PASS)).json.accessToken;
const userToken = (await login(user.email, PASS)).json.accessToken;
if (!adminToken || !userToken) throw new Error('login failed');

const checks = {
  summary: await req('/admin/ai-growth/summary', adminToken),
  issues: await req('/admin/ai-growth/issues', adminToken),
  opportunities: await req('/admin/ai-growth/opportunities', adminToken),
  insight: await req(`/admin/users/${user.id}/ai-insight`, adminToken),
  forbidden: await req('/admin/ai-growth/summary', userToken),
  growth: await req('/admin/growth/overview', adminToken),
  automation: await req('/admin/automation', adminToken),
};

const summary = {
  statuses: Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v.status])),
  hasSummary: Boolean(checks.summary.json?.summary),
  failureCount: checks.issues.json?.failureCount ?? null,
  opportunities: checks.opportunities.json?.total ?? null,
  insightStage: checks.insight.json?.currentStage ?? null,
  M7_AI_GROWTH_READY_LOCAL:
    checks.summary.status === 200 &&
    checks.issues.status === 200 &&
    checks.opportunities.status === 200 &&
    checks.insight.status === 200 &&
    checks.forbidden.status === 403 &&
    checks.growth.status === 200 &&
    checks.automation.status === 200 &&
    Boolean(checks.summary.json?.summary),
};

mkdirSync(resolve(root, '.tools/alpha-runtime'), { recursive: true });
writeFileSync(
  resolve(root, '.tools/alpha-runtime/m7-3-local-smoke.json'),
  JSON.stringify({ summary, checks }, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
await prisma.$disconnect();
process.exit(summary.M7_AI_GROWTH_READY_LOCAL ? 0 : 1);
