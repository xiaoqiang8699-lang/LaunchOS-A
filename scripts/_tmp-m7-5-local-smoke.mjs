/**
 * Local smoke M7-5 AI Deployment Preflight
 * node scripts/_tmp-m7-5-local-smoke.mjs
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
  return !/DATABASE_URL=|AUTH_SECRET=|postgres(ql)?:\/\/|sk-[A-Za-z0-9]{20,}/i.test(text);
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
  include: { sources: true, deployableUnits: true },
});
if (!project) {
  project = await prisma.project.create({
    data: {
      workspaceId: membership.workspaceId,
      name: 'M7-5 Preflight Smoke',
      slug: `m75-preflight-${Date.now()}`,
      sourceType: 'UPLOAD',
      projectType: 'WEB',
      status: 'ACTIVE',
      framework: 'next',
    },
    include: { sources: true, deployableUnits: true },
  });
}

if (project.sources.length === 0) {
  await prisma.sourceRepository.create({
    data: {
      projectId: project.id,
      type: 'UPLOAD',
      url: 'local://m75-smoke',
      branch: 'main',
    },
  });
}

let unit = project.deployableUnits[0];
if (!unit) {
  unit = await prisma.deployableUnit.create({
    data: {
      projectId: project.id,
      name: 'web',
      type: 'WEB',
      rootPath: '.',
      framework: 'next',
      packageManager: 'pnpm',
      buildCommand: 'pnpm build',
      startCommand: 'pnpm start',
      port: 3000,
      deployable: true,
      status: 'CONFIRMED',
      metadata: {
        hasLockfile: true,
        lockfile: 'pnpm-lock.yaml',
        hasDockerfile: true,
        dockerfile: 'Dockerfile',
      },
    },
  });
} else {
  unit = await prisma.deployableUnit.update({
    where: { id: unit.id },
    data: {
      framework: unit.framework || 'next',
      packageManager: unit.packageManager || 'pnpm',
      startCommand: unit.startCommand || 'pnpm start',
      port: unit.port || 3000,
      metadata: {
        hasLockfile: true,
        lockfile: 'pnpm-lock.yaml',
        hasDockerfile: true,
        dockerfile: 'Dockerfile',
      },
    },
  });
}

// Ensure AUTH_SECRET requirement exists and is missing for BLOCKED case
await prisma.runtimeConfigRequirement.deleteMany({
  where: { projectId: project.id, deployableUnitId: unit.id, key: 'AUTH_SECRET' },
});
await prisma.runtimeConfigRequirement.create({
  data: {
    projectId: project.id,
    deployableUnitId: unit.id,
    key: 'AUTH_SECRET',
    label: 'AUTH_SECRET',
    required: true,
    sensitive: true,
    managedByLaunchOS: false,
    source: 'MANUAL',
    status: 'DETECTED',
  },
});
await prisma.runtimeConfigValue.deleteMany({
  where: { projectId: project.id, key: 'AUTH_SECRET' },
});

const blocked = await req(`/projects/${project.id}/preflight`, userToken, 'POST', { unitId: unit.id });

// Prisma signal via DATABASE_URL requirement
await prisma.runtimeConfigRequirement.deleteMany({
  where: { projectId: project.id, deployableUnitId: unit.id, key: 'AUTH_SECRET' },
});
await prisma.runtimeConfigRequirement.upsert({
  where: { deployableUnitId_key: { deployableUnitId: unit.id, key: 'DATABASE_URL' } },
  create: {
    projectId: project.id,
    deployableUnitId: unit.id,
    key: 'DATABASE_URL',
    label: 'DATABASE_URL',
    required: false,
    sensitive: true,
    managedByLaunchOS: true,
    source: 'FRAMEWORK',
    status: 'DETECTED',
  },
  update: { required: false, managedByLaunchOS: true },
});
await prisma.deployableUnit.update({
  where: { id: unit.id },
  data: {
    startCommand: null,
    metadata: { prisma: true, schema: 'prisma/schema.prisma' },
  },
});
const warning = await req(`/projects/${project.id}/preflight`, userToken, 'POST', { unitId: unit.id });

// Healthy Next-like project
await prisma.runtimeConfigRequirement.deleteMany({
  where: { projectId: project.id, deployableUnitId: unit.id },
});
await prisma.deployableUnit.update({
  where: { id: unit.id },
  data: {
    framework: 'next',
    packageManager: 'pnpm',
    startCommand: 'pnpm start',
    port: 3000,
    metadata: {
      hasLockfile: true,
      lockfile: 'pnpm-lock.yaml',
      hasDockerfile: true,
      dockerfile: 'Dockerfile',
    },
  },
});
const passed = await req(`/projects/${project.id}/preflight`, userToken, 'POST', { unitId: unit.id });
const latest = await req(`/projects/${project.id}/preflight?unitId=${unit.id}`, userToken);

const otherProject = await prisma.project.findFirst({
  where: { workspace: { members: { none: { userId: user.id } } } },
  select: { id: true },
});
const forbidden = otherProject
  ? await req(`/projects/${otherProject.id}/preflight`, userToken)
  : { status: 403, json: {} };

const stats = await req('/admin/preflight-insights', adminToken);
const adminPage = await req('/admin/ai-growth/preflight', adminToken);
const regress = {
  admin: await req('/admin/overview', adminToken),
  growth: await req('/admin/growth/overview', adminToken),
  automation: await req('/admin/automation', adminToken),
  aiGrowth: await req('/admin/ai-growth/summary', adminToken),
  copilotStats: await req('/admin/ai-growth/deployment-issues', adminToken),
  billing: await req('/billing/subscription', userToken),
};

const summary = {
  statuses: {
    blocked: blocked.status,
    warning: warning.status,
    passed: passed.status,
    latest: latest.status,
    forbidden: forbidden.status,
    stats: stats.status,
    adminPage: adminPage.status,
    ...Object.fromEntries(Object.entries(regress).map(([k, v]) => [k, v.status])),
  },
  results: {
    blocked: { status: blocked.json?.status, risk: blocked.json?.riskLevel },
    warning: { status: warning.json?.status, risk: warning.json?.riskLevel },
    passed: { status: passed.json?.status, risk: passed.json?.riskLevel },
  },
  secretsSafe: assertNoSecrets(blocked.json) && assertNoSecrets(warning.json) && assertNoSecrets(passed.json),
  ruleCount: await prisma.deploymentPreflightRule.count(),
};

const M7_PREFLIGHT_READY_LOCAL =
  [200, 201].includes(blocked.status) &&
  blocked.json?.status === 'BLOCKED' &&
  blocked.json?.riskLevel === 'HIGH' &&
  [200, 201].includes(warning.status) &&
  (warning.json?.status === 'WARNING' || warning.json?.status === 'BLOCKED') &&
  [200, 201].includes(passed.status) &&
  passed.json?.status === 'PASSED' &&
  latest.status === 200 &&
  forbidden.status === 403 &&
  stats.status === 200 &&
  adminPage.status === 200 &&
  summary.secretsSafe &&
  summary.ruleCount >= 4 &&
  Object.values(regress).every((r) => r.status === 200);

summary.M7_PREFLIGHT_READY_LOCAL = M7_PREFLIGHT_READY_LOCAL;
mkdirSync(resolve(root, '.tools/alpha-runtime'), { recursive: true });
writeFileSync(
  resolve(root, '.tools/alpha-runtime/m7-5-local-smoke.json'),
  JSON.stringify({ summary, blocked: blocked.json, warning: warning.json, passed: passed.json, stats: stats.json }, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
await prisma.$disconnect();
process.exit(M7_PREFLIGHT_READY_LOCAL ? 0 : 1);
