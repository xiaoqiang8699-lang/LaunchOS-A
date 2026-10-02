/**
 * Local smoke M7-6 AI Deployment Knowledge Base
 * node scripts/_tmp-m7-6-local-smoke.mjs
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
  return !/postgres(ql)?:\/\/|sk-[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/i.test(text);
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
      name: 'M7-6 Knowledge Smoke',
      slug: `m76-kb-${Date.now()}`,
      sourceType: 'UPLOAD',
      projectType: 'WEB',
      status: 'ACTIVE',
      environments: { create: [{ name: 'production', type: 'PRODUCTION' }] },
      sources: { create: [{ type: 'UPLOAD', url: 'local://m76', branch: 'main' }] },
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
    failureCode: 'BUILD_FAILED',
    errorMessage: 'Could not find Prisma Schema at /app/prisma/schema.prisma',
    finishedAt: new Date(Date.now() - 60_000),
    usageClass: 'DRY_RUN',
    logs: { create: [{ level: 'ERROR', message: 'Could not find Prisma Schema' }] },
  },
});

const analyze = await req(`/deployments/${failed.id}/copilot/analyze`, userToken, 'POST');
const knowledgeList = await req('/deployment-knowledge', userToken);
const refs = analyze.json?.knowledgeReferences || [];

await prisma.deploymentInsight.create({
  data: {
    deploymentId: failed.id,
    category: 'BUILD_ERROR',
    summary: 'Prisma Schema 缺失',
    rootCause: 'Docker 构建缺少 schema',
    impact: '构建失败',
    fixActionsJson: [
      { step: 1, title: '检查 Dockerfile COPY 顺序' },
      { step: 2, title: '确认 prisma/schema.prisma' },
      { step: 3, title: '重新上线' },
    ],
    confidence: 0.9,
    source: 'RULE',
  },
}).catch(() => null);

const success = await prisma.deployment.create({
  data: {
    projectId: project.id,
    environmentId: envId,
    status: 'SUCCESS',
    currentStage: 'READY',
    finishedAt: new Date(),
    usageClass: 'DRY_RUN',
  },
});

const extract = await req(`/deployment-knowledge/extract/${success.id}`, userToken, 'POST');
const adminList = await req('/admin/deployment-knowledge', adminToken);
const pending = (adminList.json?.candidates || []).filter((c) => c.status === 'PENDING');
let review = { status: 0, json: {} };
if (pending[0]?.id) {
  review = await req(`/admin/deployment-knowledge/${pending[0].id}/review`, adminToken, 'POST', {
    decision: 'APPROVED',
  });
}

const topRef = refs[0]?.id || (await prisma.deploymentKnowledgeItem.findFirst({ select: { id: true } }))?.id;
const feedback = topRef
  ? await req(`/deployment-knowledge/${topRef}/feedback`, userToken, 'POST', {
      deploymentId: failed.id,
      result: 'SUCCESS',
    })
  : { status: 0, json: {} };

const analytics = await req('/admin/ai-growth/knowledge/analytics', adminToken);
const forbidden = await req('/admin/deployment-knowledge', userToken);
const regress = {
  admin: await req('/admin/overview', adminToken),
  growth: await req('/admin/growth/overview', adminToken),
  automation: await req('/admin/automation', adminToken),
  aiGrowth: await req('/admin/ai-growth/summary', adminToken),
  preflight: await req('/admin/ai-growth/preflight', adminToken),
  copilot: await req('/admin/ai-growth/deployment-issues', adminToken),
  billing: await req('/billing/subscription', userToken),
};

const summary = {
  statuses: {
    analyze: analyze.status,
    knowledgeList: knowledgeList.status,
    extract: extract.status,
    adminList: adminList.status,
    review: review.status,
    feedback: feedback.status,
    analytics: analytics.status,
    forbidden: forbidden.status,
    ...Object.fromEntries(Object.entries(regress).map(([k, v]) => [k, v.status])),
  },
  hasKnowledgeRefs: Array.isArray(refs) && refs.length > 0,
  source: analyze.json?.source || null,
  candidateCreated: Boolean(extract.json?.id || pending.length),
  secretsSafe: assertNoSecrets(analyze.json) && assertNoSecrets(knowledgeList.json) && assertNoSecrets(adminList.json),
  knowledgeCount: await prisma.deploymentKnowledgeItem.count(),
};

const M7_KNOWLEDGE_BASE_READY_LOCAL =
  [200, 201].includes(analyze.status) &&
  knowledgeList.status === 200 &&
  adminList.status === 200 &&
  analytics.status === 200 &&
  forbidden.status === 403 &&
  summary.hasKnowledgeRefs &&
  summary.secretsSafe &&
  summary.knowledgeCount >= 4 &&
  Object.values(regress).every((r) => r.status === 200);

summary.M7_KNOWLEDGE_BASE_READY_LOCAL = M7_KNOWLEDGE_BASE_READY_LOCAL;
mkdirSync(resolve(root, '.tools/alpha-runtime'), { recursive: true });
writeFileSync(
  resolve(root, '.tools/alpha-runtime/m7-6-local-smoke.json'),
  JSON.stringify({ summary, analyze: analyze.json, extract: extract.json, analytics: analytics.json }, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
await prisma.$disconnect();
process.exit(M7_KNOWLEDGE_BASE_READY_LOCAL ? 0 : 1);
