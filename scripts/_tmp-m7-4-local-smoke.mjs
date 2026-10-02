/**
 * Local smoke M7-4 AI Deployment Copilot
 * node scripts/_tmp-m7-4-local-smoke.mjs
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
  return !/DATABASE_URL|AUTH_SECRET|postgres(ql)?:\/\/|sk-[A-Za-z0-9]{20,}/i.test(text);
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

// Find or create a FAILED deployment owned by user for rule matching
const membership = await prisma.workspaceMember.findFirst({
  where: { userId: user.id },
  select: { workspaceId: true },
});
if (!membership) throw new Error('user has no workspace');

let project = await prisma.project.findFirst({
  where: { workspaceId: membership.workspaceId },
  include: { environments: { take: 1 } },
});
if (!project) {
  project = await prisma.project.create({
    data: {
      workspaceId: membership.workspaceId,
      name: 'M7-4 Copilot Smoke',
      slug: `m74-copilot-${Date.now()}`,
      sourceType: 'UPLOAD',
      projectType: 'WEB',
      status: 'ACTIVE',
      environments: { create: [{ name: 'production', type: 'PRODUCTION' }] },
    },
    include: { environments: { take: 1 } },
  });
} else if (!project.environments[0]) {
  await prisma.projectEnvironment.create({
    data: { projectId: project.id, name: 'production', type: 'PRODUCTION' },
  });
  project = await prisma.project.findUnique({
    where: { id: project.id },
    include: { environments: { take: 1 } },
  });
}

let failedId = null;
let successId = null;
let otherUserFailedId = null;
let npmFailId = null;
let configFailId = null;

if (project?.environments?.[0]) {
  const envId = project.environments[0].id;
  const base = {
    projectId: project.id,
    environmentId: envId,
    status: 'FAILED',
    currentStage: 'BUILD',
    finishedAt: new Date(),
    usageClass: 'DRY_RUN',
  };

  const prismaFail = await prisma.deployment.create({
    data: {
      ...base,
      failureCode: 'BUILD_FAILED',
      errorMessage: 'Error: Could not find Prisma Schema at /app/prisma/schema.prisma',
      logs: {
        create: [{ level: 'ERROR', message: 'Could not find Prisma Schema' }],
      },
    },
  });
  failedId = prismaFail.id;

  const npmFail = await prisma.deployment.create({
    data: {
      ...base,
      failureCode: 'BUILD_FAILED',
      errorMessage: 'npm ERR! code ERESOLVE could not resolve',
      logs: { create: [{ level: 'ERROR', message: 'npm ERR! ERESOLVE unable to resolve dependency tree' }] },
    },
  });

  const configFail = await prisma.deployment.create({
    data: {
      ...base,
      failureCode: 'RUNTIME_CONFIG_MISSING',
      errorMessage: 'RUNTIME_CONFIG_MISSING: required config is missing',
      currentStage: 'START',
    },
  });

  const ok = await prisma.deployment.create({
    data: {
      projectId: project.id,
      environmentId: envId,
      status: 'SUCCESS',
      currentStage: 'READY',
      finishedAt: new Date(),
      usageClass: 'DRY_RUN',
    },
  });
  successId = ok.id;

  // Another user's failed deploy for 403 check
  const otherMember = await prisma.workspaceMember.findFirst({
    where: { userId: { not: user.id }, workspace: { members: { none: { userId: user.id } } } },
    select: { workspaceId: true },
  });
  if (otherMember) {
    let otherProject = await prisma.project.findFirst({
      where: { workspaceId: otherMember.workspaceId },
      include: { environments: { take: 1 } },
    });
    if (!otherProject) {
      otherProject = await prisma.project.create({
        data: {
          workspaceId: otherMember.workspaceId,
          name: 'M7-4 Other Smoke',
          slug: `m74-other-${Date.now()}`,
          sourceType: 'UPLOAD',
          projectType: 'WEB',
          status: 'ACTIVE',
          environments: { create: [{ name: 'production', type: 'PRODUCTION' }] },
        },
        include: { environments: { take: 1 } },
      });
    } else if (!otherProject.environments[0]) {
      await prisma.projectEnvironment.create({
        data: { projectId: otherProject.id, name: 'production', type: 'PRODUCTION' },
      });
      otherProject = await prisma.project.findUnique({
        where: { id: otherProject.id },
        include: { environments: { take: 1 } },
      });
    }
    if (otherProject?.environments?.[0]) {
      const other = await prisma.deployment.create({
        data: {
          projectId: otherProject.id,
          environmentId: otherProject.environments[0].id,
          status: 'FAILED',
          failureCode: 'BUILD_FAILED',
          errorMessage: 'npm ERR!',
          currentStage: 'BUILD',
          usageClass: 'DRY_RUN',
        },
      });
      otherUserFailedId = other.id;
    }
  }

  npmFailId = npmFail.id;
  configFailId = configFail.id;
} else {
  throw new Error('no project/env for user');
}

const prismaAnalysis = await req(`/deployments/${failedId}/copilot/analyze`, userToken, 'POST');
const npmAnalysis = await req(`/deployments/${npmFailId}/copilot/analyze`, userToken, 'POST');
const configAnalysis = await req(`/deployments/${configFailId}/copilot/analyze`, userToken, 'POST');
const cached = await req(`/deployments/${failedId}/copilot`, userToken);
const forbidden = otherUserFailedId
  ? await req(`/deployments/${otherUserFailedId}/copilot`, userToken)
  : { status: 403, json: {} };
const adminCopilot = await req(`/admin/deployments/${failedId}/copilot`, adminToken);
const stats = await req('/admin/deployment-insights', adminToken);
const issuesPage = await req('/admin/ai-growth/deployment-issues', adminToken);
const regress = {
  admin: await req('/admin/overview', adminToken),
  growth: await req('/admin/growth/overview', adminToken),
  automation: await req('/admin/automation', adminToken),
  aiGrowth: await req('/admin/ai-growth/summary', adminToken),
  billing: await req('/billing/subscription', userToken),
};

const summary = {
  statuses: {
    prisma: prismaAnalysis.status,
    npm: npmAnalysis.status,
    config: configAnalysis.status,
    cached: cached.status,
    forbidden: forbidden.status,
    adminCopilot: adminCopilot.status,
    stats: stats.status,
    issuesPage: issuesPage.status,
    ...Object.fromEntries(Object.entries(regress).map(([k, v]) => [k, v.status])),
  },
  categories: {
    prisma: prismaAnalysis.json?.category,
    npm: npmAnalysis.json?.category,
    config: configAnalysis.json?.category,
  },
  sources: {
    prisma: prismaAnalysis.json?.source,
    npm: npmAnalysis.json?.source,
    config: configAnalysis.json?.source,
  },
  secretsSafe:
    assertNoSecrets(prismaAnalysis.json) &&
    assertNoSecrets(npmAnalysis.json) &&
    assertNoSecrets(configAnalysis.json) &&
    assertNoSecrets(adminCopilot.json),
  ruleCount: await prisma.deploymentDiagnosisRule.count(),
  insightCount: await prisma.deploymentInsight.count(),
  successId,
  note: 'success deployments do not surface AI diagnosis in UI (status!==FAILED)',
};

const M7_DEPLOYMENT_COPILOT_READY_LOCAL =
  [200, 201].includes(prismaAnalysis.status) &&
  prismaAnalysis.json?.category === 'BUILD_ERROR' &&
  npmAnalysis.json?.category === 'DEPENDENCY_ERROR' &&
  configAnalysis.json?.category === 'CONFIG_ERROR' &&
  cached.status === 200 &&
  forbidden.status === 403 &&
  adminCopilot.status === 200 &&
  stats.status === 200 &&
  issuesPage.status === 200 &&
  summary.secretsSafe &&
  summary.ruleCount >= 4 &&
  Object.values(regress).every((r) => r.status === 200);

summary.M7_DEPLOYMENT_COPILOT_READY_LOCAL = M7_DEPLOYMENT_COPILOT_READY_LOCAL;

mkdirSync(resolve(root, '.tools/alpha-runtime'), { recursive: true });
writeFileSync(
  resolve(root, '.tools/alpha-runtime/m7-4-local-smoke.json'),
  JSON.stringify({ summary, prismaAnalysis: prismaAnalysis.json, npmAnalysis: npmAnalysis.json, configAnalysis: configAnalysis.json, stats: stats.json }, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
await prisma.$disconnect();
process.exit(M7_DEPLOYMENT_COPILOT_READY_LOCAL ? 0 : 1);
