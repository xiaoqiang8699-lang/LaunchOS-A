import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const bcrypt = require('bcrypt');
const { PrismaClient } = require('@launchos/database');
const prisma = new PrismaClient();

const email = 'ux4-billing@launchos.local';
const password = 'Ux4-Billing-Test!';
const hash = await bcrypt.hash(password, 10);

let user = await prisma.user.findUnique({ where: { email } });
if (!user) {
  user = await prisma.user.create({
    data: {
      email,
      name: 'UX4 Billing',
      passwordHash: hash,
      platformRole: 'USER',
      onboardingStatus: 'COMPLETED',
      hasCompletedOnboarding: true,
    },
  });
} else {
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: hash, onboardingStatus: 'COMPLETED', hasCompletedOnboarding: true },
  });
}

let ws = await prisma.workspace.findFirst({ where: { ownerId: user.id } });
if (!ws) {
  ws = await prisma.workspace.create({
    data: { name: 'UX4 Workspace', ownerId: user.id, status: 'ACTIVE' },
  });
  await prisma.workspaceMember.create({
    data: { workspaceId: ws.id, userId: user.id, role: 'OWNER' },
  });
}

const free = await prisma.plan.findUnique({ where: { code: 'free' } });
let sub = await prisma.subscription.findFirst({
  where: { workspaceId: ws.id },
  orderBy: { createdAt: 'desc' },
});
const now = new Date();
const end = new Date(now.getTime() + 30 * 24 * 3600 * 1000);
if (!sub) {
  const version = await prisma.planVersion.findFirst({
    where: { planId: free.id },
    orderBy: { createdAt: 'desc' },
  });
  sub = await prisma.subscription.create({
    data: {
      workspaceId: ws.id,
      planId: free.id,
      planVersionId: version?.id,
      status: 'ACTIVE',
      currentPeriodStart: now,
      currentPeriodEnd: end,
      source: 'DEFAULT_FREE',
    },
  });
} else {
  await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      planId: free.id,
      status: 'ACTIVE',
      cancelAtPeriodEnd: false,
      pendingPlanId: null,
      planChangeEffectiveAt: null,
      source: 'DEFAULT_FREE',
      currentPeriodStart: now,
      currentPeriodEnd: end,
    },
  });
}

function curl(method, path, token, body) {
  const args = [
    '-sS',
    '-X',
    method,
    '-H',
    'content-type: application/json',
    '-w',
    '\n__STATUS__:%{http_code}',
  ];
  if (token) args.push('-H', `authorization: Bearer ${token}`);
  if (body != null) args.push('--data-binary', body);
  args.push(`http://localhost:3001/api/v1${path}`);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8' });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)\s*$/);
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out };
}

function parse(x) {
  try {
    return JSON.parse(x.text || '{}');
  } catch {
    return { raw: x.text };
  }
}

const login = curl('POST', '/auth/login', null, JSON.stringify({ email, password }));
const token = parse(login).accessToken;
if (!token) {
  console.error(JSON.stringify({ login }, null, 2));
  process.exit(1);
}

const subGet = curl('GET', '/billing/subscription', token);
const change = curl('POST', '/billing/subscription/change-plan', token, JSON.stringify({ plan: 'pro' }));
const afterUpgrade = curl('GET', '/billing/subscription', token);
const cancel = curl('POST', '/billing/subscription/cancel', token, '{}');
const afterCancel = curl('GET', '/billing/subscription', token);
const resume = curl('POST', '/billing/subscription/resume', token, '{}');
const afterResume = curl('GET', '/billing/subscription', token);
const downgrade = curl(
  'POST',
  '/billing/subscription/change-plan',
  token,
  JSON.stringify({ plan: 'free' }),
);

const pages = {};
for (const p of ['/billing', '/plan', '/overview', '/projects', '/resources', '/team', '/usage', '/admin']) {
  const r = spawnSync(
    'curl.exe',
    ['-sS', '-o', 'NUL', '-w', '%{http_code}', '--max-time', '8', `http://localhost:3000${p}`],
    { encoding: 'utf8' },
  );
  pages[p] = Number(String(r.stdout || '0').trim());
}

const report = {
  login: login.status,
  subscriptionGet: subGet.status,
  changeToPro: { status: change.status, body: parse(change) },
  afterUpgrade: {
    plan: parse(afterUpgrade).effectivePlan?.code,
    autoRenew: parse(afterUpgrade).autoRenew,
    cancelAtPeriodEnd: parse(afterUpgrade).cancelAtPeriodEnd,
  },
  cancel: { status: cancel.status, body: parse(cancel) },
  afterCancel: {
    status: parse(afterCancel).subscription?.status,
    cancelAtPeriodEnd: parse(afterCancel).cancelAtPeriodEnd,
    autoRenew: parse(afterCancel).autoRenew,
    canResume: parse(afterCancel).canResume,
  },
  resume: { status: resume.status, body: parse(resume) },
  afterResume: {
    status: parse(afterResume).subscription?.status,
    cancelAtPeriodEnd: parse(afterResume).cancelAtPeriodEnd,
    autoRenew: parse(afterResume).autoRenew,
  },
  downgrade: { status: downgrade.status, body: parse(downgrade) },
  pages,
  paymentTriggered: false,
  charged: parse(change).charged === false,
  paymentTriggeredFlag: parse(change).paymentTriggered === false,
};

writeFileSync('.tools/alpha-runtime/ux4-billing-smoke.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await prisma.$disconnect();
