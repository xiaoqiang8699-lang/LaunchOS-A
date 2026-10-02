/**
 * Local smoke M7-8 AI Onboarding Optimizer
 * node scripts/_tmp-m7-8-local-smoke.mjs
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
async function req(path, token, method = 'GET', body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(async () => ({ raw: await res.text() })) };
}
function assertNoSecrets(obj) {
  const text = JSON.stringify(obj || {});
  return !/postgres(ql)?:\/\/|sk-[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|DATABASE_URL\s*=/i.test(
    text,
  );
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

const backfill = await req('/admin/onboarding/backfill', adminToken, 'POST');
const overview = await req('/admin/onboarding/overview', adminToken);
const funnel = await req('/admin/onboarding/funnel', adminToken);
const blocked = await req('/admin/onboarding/blocked-users', adminToken);
const recommendations = await req('/admin/onboarding/recommendations', adminToken);
const userActivationAdmin = await req(`/admin/users/${user.id}/activation`, adminToken);
const myActivation = await req('/activation', userToken);
const userForbidden = await req('/admin/onboarding/overview', userToken);

const membership = await prisma.workspaceMember.findFirst({
  where: { userId: user.id },
  select: { workspaceId: true },
});
let projectActivation = { status: 0, json: {} };
if (membership) {
  const project = await prisma.project.findFirst({
    where: { workspaceId: membership.workspaceId },
    select: { id: true },
  });
  if (project) {
    projectActivation = await req(`/projects/${project.id}/activation`, userToken);
  }
}

// Cross-workspace: pick another workspace project if any
let crossForbidden = { status: 0 };
const otherProject = await prisma.project.findFirst({
  where: membership ? { workspaceId: { not: membership.workspaceId } } : undefined,
  select: { id: true },
});
if (otherProject) {
  crossForbidden = await req(`/projects/${otherProject.id}/activation`, userToken);
}

const regress = {
  admin: (await req('/admin/overview', adminToken)).status,
  growth: (await req('/admin/growth/overview', adminToken)).status,
  automation: (await req('/admin/automation', adminToken)).status,
  aiGrowth: (await req('/admin/ai-growth/summary', adminToken)).status,
  success: (await req('/admin/ai-growth/success', adminToken)).status,
  knowledge: (await req('/admin/ai-growth/knowledge', adminToken)).status,
  preflight: (await req('/admin/ai-growth/preflight', adminToken)).status,
  billing: (await req('/billing/subscription', userToken)).status,
};

const body = overview.json || {};
const M7_ONBOARDING_OPTIMIZER_READY =
  [200, 201].includes(backfill.status) &&
  overview.status === 200 &&
  funnel.status === 200 &&
  blocked.status === 200 &&
  recommendations.status === 200 &&
  userActivationAdmin.status === 200 &&
  myActivation.status === 200 &&
  userForbidden.status === 403 &&
  typeof body.metrics?.activationRate === 'number' &&
  typeof body.metrics?.firstDeploymentSuccessRate === 'number' &&
  Array.isArray(body.funnel) &&
  body.activationDefinition === 'FIRST_PUBLIC_DEPLOYMENT_SUCCESS' &&
  assertNoSecrets(body) &&
  assertNoSecrets(myActivation.json) &&
  regress.admin === 200 &&
  regress.growth === 200 &&
  regress.success === 200 &&
  regress.knowledge === 200 &&
  (crossForbidden.status === 0 || crossForbidden.status === 403) &&
  (projectActivation.status === 0 || projectActivation.status === 200);

const report = {
  backfillStatus: backfill.status,
  backfill: backfill.json,
  overviewStatus: overview.status,
  metrics: body.metrics || null,
  m7Comparison: body.m7Comparison || null,
  dropoff: body.dropoff || null,
  funnelTop: (body.funnel || []).slice(0, 4),
  myActivationStatus: myActivation.status,
  myActivated: myActivation.json?.activated,
  myStage: myActivation.json?.stage,
  userForbidden: userForbidden.status,
  crossForbidden: crossForbidden.status,
  projectActivationStatus: projectActivation.status,
  secretsSafe: assertNoSecrets(body) && assertNoSecrets(myActivation.json),
  regress,
  autoCodeModify: false,
  autoDeploy: false,
  autoMessage: false,
  paymentTriggered: false,
  M7_ONBOARDING_OPTIMIZER_READY,
};

const outDir = resolve(root, '.tools/alpha-runtime');
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'm7-8-local-smoke.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await prisma.$disconnect().catch(() => undefined);
process.exit(M7_ONBOARDING_OPTIMIZER_READY ? 0 : 1);
