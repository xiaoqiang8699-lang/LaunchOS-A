/**
 * Set 1002@qq.com plan to pro via Prisma (uses current DATABASE_URL).
 * node scripts/_tmp-set-1002-pro-local.mjs
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient, SubscriptionStatus } = requireApi('@launchos/database');
const prisma = new PrismaClient();

const email = '1002@qq.com';
const user = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
if (!user) {
  console.error('USER_MISSING');
  process.exit(1);
}
const membership = await prisma.workspaceMember.findFirst({
  where: { userId: user.id },
  orderBy: { createdAt: 'asc' },
});
if (!membership) {
  console.error('WORKSPACE_MISSING');
  process.exit(1);
}
const pro = await prisma.plan.findFirst({ where: { code: { equals: 'pro', mode: 'insensitive' } } });
if (!pro) {
  console.error('PRO_PLAN_MISSING');
  process.exit(1);
}
const version = await prisma.planVersion.findFirst({
  where: { planId: pro.id, effectiveTo: null },
  orderBy: { version: 'desc' },
});
const sub = await prisma.subscription.findFirst({ where: { workspaceId: membership.workspaceId } });
if (!sub) {
  console.error('SUBSCRIPTION_MISSING');
  process.exit(1);
}

console.log('BEFORE', {
  email: user.email,
  workspaceId: membership.workspaceId,
  subscriptionId: sub.id,
  planId: sub.planId,
  status: sub.status,
  source: sub.source,
});

const updated = await prisma.subscription.update({
  where: { id: sub.id },
  data: {
    planId: pro.id,
    planVersionId: version?.id ?? null,
    pendingPlanId: null,
    planChangeEffectiveAt: null,
    status: SubscriptionStatus.ACTIVE,
    source: 'COMPLIMENTARY',
    complimentaryReason: sub.complimentaryReason || 'Admin set plan to pro',
  },
  include: { plan: true },
});

console.log('AFTER', {
  email: user.email,
  plan: updated.plan.code,
  status: updated.status,
  source: updated.source,
  maxProjects: updated.plan.maxProjects,
});

await prisma.$disconnect();
if (updated.plan.code.toLowerCase() !== 'pro') process.exit(1);
console.log('PLAN_SET=pro');
