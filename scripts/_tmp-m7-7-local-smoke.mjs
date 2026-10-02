/**
 * Local smoke M7-7 AI Deployment Success Optimizer
 * node scripts/_tmp-m7-7-local-smoke.mjs
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
  return !/postgres(ql)?:\/\/|sk-[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|DATABASE_URL|AUTH_SECRET/i.test(
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

const membership = await prisma.workspaceMember.findFirst({
  where: { userId: user.id },
  select: { workspaceId: true },
});
if (!membership) throw new Error('no workspace');

let project = await prisma.project.findFirst({
  where: { workspaceId: membership.workspaceId },
  include: { environments: { take: 1 }, sources: true },
});
if (!project) {
  project = await prisma.project.create({
    data: {
      workspaceId: membership.workspaceId,
      name: 'M7-7 Success Smoke',
      slug: `m77-success-${Date.now()}`,
      sourceType: 'UPLOAD',
      projectType: 'WEB',
      status: 'ACTIVE',
      framework: 'nextjs',
      environments: { create: [{ name: 'production', type: 'PRODUCTION' }] },
      sources: { create: [{ type: 'UPLOAD', url: 'local://m77', branch: 'main' }] },
    },
    include: { environments: { take: 1 }, sources: true },
  });
}
if (!project.environments[0]) {
  await prisma.projectEnvironment.create({
    data: { projectId: project.id, name: 'production', type: 'PRODUCTION' },
  });
  project = await prisma.project.findUnique({
    where: { id: project.id },
    include: { environments: { take: 1 }, sources: true },
  });
}
const envId = project.environments[0].id;

const failed = await prisma.deployment.create({
  data: {
    projectId: project.id,
    environmentId: envId,
    status: 'FAILED',
    currentStage: 'BUILD',
    failureCode: 'CONFIG_MISSING',
    errorMessage: 'Missing required env AUTH_SECRET for runtime',
    finishedAt: new Date(Date.now() - 120_000),
    usageClass: 'DRY_RUN',
  },
});
await prisma.deploymentInsight.create({
  data: {
    deploymentId: failed.id,
    category: 'CONFIG_ERROR',
    summary: '环境变量缺失',
    rootCause: 'AUTH_SECRET 未配置',
    impact: '首次部署失败',
    fixActionsJson: [{ step: 1, title: '补齐运行配置' }],
    confidence: 0.9,
    source: 'RULE',
  },
}).catch(() => null);

const ok = await prisma.deployment.create({
  data: {
    projectId: project.id,
    environmentId: envId,
    status: 'SUCCESS',
    currentStage: 'READY',
    startedAt: new Date(Date.now() - 30_000),
    finishedAt: new Date(),
    usageClass: 'DRY_RUN',
  },
});

await prisma.productEvent.create({
  data: {
    name: 'source_connected',
    userId: user.id,
    workspaceId: membership.workspaceId,
    projectId: project.id,
    metadata: { stage: 'SOURCE_CONNECTED' },
  },
}).catch(() => null);

const refresh = await req('/admin/ai-growth/success/refresh', adminToken, 'POST');
const overview = await req('/admin/success-analytics', adminToken);
const frameworks = await req('/admin/success-analytics/frameworks', adminToken);
const recommendations = await req('/admin/success-analytics/recommendations', adminToken);
const aiGrowthSuccess = await req('/admin/ai-growth/success', adminToken);
const userForbidden = await req('/admin/success-analytics', userToken);

const regress = {
  admin: (await req('/admin/overview', adminToken)).status,
  growth: (await req('/admin/growth/overview', adminToken)).status,
  automation: (await req('/admin/automation', adminToken)).status,
  aiGrowth: (await req('/admin/ai-growth/summary', adminToken)).status,
  copilot: (await req('/admin/ai-growth/deployment-issues', adminToken)).status,
  preflight: (await req('/admin/ai-growth/preflight', adminToken)).status,
  knowledge: (await req('/admin/ai-growth/knowledge', adminToken)).status,
  billing: (await req('/billing/subscription', userToken)).status,
};

const body = overview.json || {};
const M7_SUCCESS_OPTIMIZER_READY =
  [200, 201].includes(refresh.status) &&
  overview.status === 200 &&
  frameworks.status === 200 &&
  recommendations.status === 200 &&
  aiGrowthSuccess.status === 200 &&
  userForbidden.status === 403 &&
  typeof body.metrics?.successRate === 'number' &&
  typeof body.metrics?.firstDeploymentSuccessRate === 'number' &&
  Array.isArray(body.frameworks) &&
  Array.isArray(body.topBlockers) &&
  Array.isArray(body.recommendations) &&
  Array.isArray(body.risks) &&
  assertNoSecrets(body) &&
  assertNoSecrets(frameworks.json) &&
  assertNoSecrets(recommendations.json) &&
  regress.admin === 200 &&
  regress.growth === 200 &&
  regress.automation === 200 &&
  regress.aiGrowth === 200 &&
  regress.knowledge === 200 &&
  regress.preflight === 200;

const report = {
  failedId: failed.id,
  successId: ok.id,
  refreshStatus: refresh.status,
  overviewStatus: overview.status,
  frameworksStatus: frameworks.status,
  recommendationsStatus: recommendations.status,
  userForbidden: userForbidden.status,
  metrics: body.metrics || null,
  topBlockers: body.topBlockers || [],
  recommendationCount: Array.isArray(body.recommendations) ? body.recommendations.length : 0,
  secretsSafe: assertNoSecrets(body),
  regress,
  autoCodeModify: false,
  autoFlowChange: false,
  autoDeploy: false,
  paymentTriggered: false,
  M7_SUCCESS_OPTIMIZER_READY,
};

const outDir = resolve(root, '.tools/alpha-runtime');
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'm7-7-local-smoke.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await prisma.$disconnect().catch(() => undefined);
process.exit(M7_SUCCESS_OPTIMIZER_READY ? 0 : 1);
