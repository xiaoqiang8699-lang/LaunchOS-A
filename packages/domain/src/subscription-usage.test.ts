import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeAdminAuditMetadata } from './admin-user-management.js';
import {
  assertFeatureFlags,
  assertPlanCodeChange,
  assertPlanDelete,
  buildMinutesFromMilliseconds,
  countsAsDeployment,
  evaluateUsageAgainstPlan,
  memberCountsTowardQuota,
  memberLimitDecision,
  projectCountsTowardQuota,
  projectLimitDecision,
  recommendPlanUpgrade,
  resolveEffectivePlan,
  resolveUsagePeriod,
  separatePriceAndCost,
  shanghaiNaturalMonth,
  subscriptionStatusLabel,
  unavailablePaymentProvider,
  usageWarning,
} from './subscription-usage.js';

const free = { code: 'free', name: 'Free' };
const pro = { code: 'pro', name: 'Pro' };

test('default FREE when the workspace has no usable subscription', () => {
  const resolved = resolveEffectivePlan({ freePlan: free, subscription: null });
  assert.equal(resolved.source, 'DEFAULT_FREE');
  assert.equal(resolved.plan.code, 'free');
});

test('active subscription and admin override choose one plan', () => {
  const active = resolveEffectivePlan({
    freePlan: free,
    subscription: { status: 'ACTIVE', plan: pro, overrideSource: null },
  });
  assert.equal(active.source, 'SUBSCRIPTION');
  assert.equal(active.plan.code, 'pro');
  const override = resolveEffectivePlan({
    freePlan: free,
    subscription: { status: 'ACTIVE', plan: pro, overrideSource: 'MANUAL_ADMIN_OVERRIDE' },
  });
  assert.equal(override.source, 'ADMIN_OVERRIDE');
  assert.equal(subscriptionStatusLabel('PAST_DUE'), '待处理');
  assert.equal(subscriptionStatusLabel('CANCEL_AT_PERIOD_END'), '到期取消');
});

test('FREE usage period is the Shanghai natural month', () => {
  const period = shanghaiNaturalMonth(new Date('2026-09-15T04:00:00.000Z'));
  assert.equal(period.start.toISOString(), '2026-08-31T16:00:00.000Z');
  assert.equal(period.end.toISOString(), '2026-09-30T16:00:00.000Z');
  const paid = resolveUsagePeriod({
    planCode: 'pro',
    currentPeriodStart: '2026-09-10T00:00:00.000Z',
    currentPeriodEnd: '2026-10-10T00:00:00.000Z',
  });
  assert.equal(paid.start.toISOString(), '2026-09-10T00:00:00.000Z');
});

test('project, member, deployment, build, and resource usage follow the stated口径', () => {
  assert.equal(projectCountsTowardQuota({ status: 'ACTIVE', isDemo: false }), true);
  assert.equal(projectCountsTowardQuota({ status: 'ARCHIVED' }), false);
  assert.equal(projectCountsTowardQuota({ status: 'ACTIVE', isDemo: true }), false);
  assert.equal(projectCountsTowardQuota({ status: 'TEST', internal: true }), false);
  assert.equal(memberCountsTowardQuota({ status: 'ACTIVE' }), true);
  assert.equal(memberCountsTowardQuota({ status: 'PENDING' }), false);
  assert.equal(countsAsDeployment({ usageClass: 'REAL_EXECUTION', status: 'SUCCESS' }), true);
  assert.equal(countsAsDeployment({ usageClass: 'DRY_RUN', status: 'SUCCESS' }), false);
  assert.equal(countsAsDeployment({ usageClass: 'GATE_ONLY', status: 'SUCCESS' }), false);
  assert.equal(countsAsDeployment({ usageClass: 'PLAN', status: 'SUCCESS' }), false);
  assert.equal(countsAsDeployment({ usageClass: 'VERIFY_ONLY', status: 'SUCCESS' }), false);
  assert.equal(countsAsDeployment({ status: 'CREATED' }), false);
  assert.equal(buildMinutesFromMilliseconds(61_000), 2);
  assert.equal(buildMinutesFromMilliseconds(null), null);
});

test('quota remaining, near limit, and over limit', () => {
  const near = evaluateUsageAgainstPlan({
    limits: { projects: 5, members: 5, deployments: 10, buildMinutes: 100, servers: null, databases: null, redis: null },
    usage: { projects: 4, members: 1, deployments: 1, buildMinutes: 10, servers: 0, databases: 0, redis: 0 },
  });
  assert.equal(near.overallStatus, 'NEAR_LIMIT');
  assert.equal(near.quota.projects.remaining, 1);
  assert.equal(near.quota.projects.percent, 80);
  const over = evaluateUsageAgainstPlan({
    limits: { projects: 5, members: 5, deployments: 10, buildMinutes: 100, servers: null, databases: null, redis: null },
    usage: { projects: 6, members: 1, deployments: 1, buildMinutes: null, servers: 0, databases: 0, redis: 0 },
  });
  assert.equal(over.overallStatus, 'OVER_LIMIT');
  assert.equal(over.quota.buildMinutes.exceeded, false);
  assert.equal(over.quota.servers.limit, null);
});

test('project and member limits block the next write, deployment and build only warn', () => {
  const project = projectLimitDecision({ used: 5, limit: 5 });
  assert.equal(project.ok, false);
  if (!project.ok) {
    assert.equal(project.code, 'PLAN_LIMIT_REACHED');
    assert.equal(project.message.includes('PLAN_LIMIT_REACHED'), false);
    assert.match(project.message, /最多支持 5 个应用/);
  }
  assert.equal(projectLimitDecision({ used: 5, limit: 5, adminOverride: true }).ok, true);
  const member = memberLimitDecision({ used: 5, limit: 5 });
  assert.equal(member.ok, false);
  if (!member.ok) assert.match(member.message, /最多支持 5 名成员/);
  const deployment = usageWarning({ kind: 'deployments', used: 11, limit: 10 });
  assert.equal(deployment.blocks, false);
  assert.equal(deployment.quotaExceeded, true);
  assert.match(deployment.message ?? '', /部署次数已超过套餐建议额度/);
  const build = usageWarning({ kind: 'buildMinutes', used: 80, limit: 100 });
  assert.equal(build.blocks, false);
  assert.match(build.message ?? '', /构建用量已接近上限/);
});

test('upgrade recommendation does not change the plan', () => {
  const projects = recommendPlanUpgrade({
    currentPlan: 'free',
    usage: { projects: 4, members: 1 },
    limits: { projects: 5, members: 5 },
  });
  assert.equal(projects.recommendedPlan, 'pro');
  const members = recommendPlanUpgrade({
    currentPlan: 'free',
    usage: { projects: 1, members: 5 },
    limits: { projects: 5, members: 5 },
  });
  assert.equal(members.recommendedPlan, 'pro');
  assert.equal(members.currentPlan, 'free');
});

test('plan code and delete protection, feature flags, price versus cost, and secret safety', async () => {
  assert.equal(assertPlanDelete(1).ok, false);
  assert.equal(assertPlanDelete(0).ok, true);
  assert.equal(assertPlanCodeChange({ currentCode: 'pro', nextCode: 'team', subscriptionCount: 1 }).ok, false);
  assert.equal(assertPlanCodeChange({ currentCode: 'pro', nextCode: 'team', subscriptionCount: 0 }).ok, true);
  assert.equal(assertFeatureFlags({ customDomain: true, supportLevel: 'community', seats: 3 }).ok, true);
  assert.equal(assertFeatureFlags({ nested: { ok: true } }).ok, false);
  const money = separatePriceAndCost({ priceMonthly: 49, estimatedCloudCost: 10 });
  assert.equal(money.priceMonthly, 49);
  assert.equal(money.estimatedCloudCost, 10);
  assert.equal(money.grossMargin, 39);
  const payment = await unavailablePaymentProvider.createCheckout({ workspaceId: 'ws', planCode: 'pro' });
  assert.equal(payment.available, false);
  assert.equal(payment.message, '支付功能即将开放');
  const safe = sanitizeAdminAuditMetadata({ planCode: 'pro', reason: 'alpha', password: 'x', token: 'y', secret: 'z' });
  assert.equal(safe.password, undefined);
  assert.equal(safe.planCode, 'pro');
});
