import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLOUD_COST_DISCLAIMER,
  approveUpgradeAction,
  assertPlanReferences,
  billedSubscriptionAmount,
  buildFeatureMatrix,
  canAssignPlan,
  isCustomerVisiblePlan,
  canRequestUpgrade,
  canReviewUpgrade,
  comparisonBadges,
  displayMonthlyPrice,
  displayYearlyPrice,
  estimateGrossMargin,
  formatUpgradeReason,
  matrixHidesTechnicalKeys,
  presentCommercialSummary,
  recommendBestPlan,
  safeUpgradeMetadata,
  selectCommercialVersion,
  upgradeTrigger,
  userLimitSentence,
  yearlyIsIndependent,
  type CatalogPlan,
} from './pricing-packaging.js';

const limits = (projects: number | null, members: number | null, deployments: number | null = 10, build: number | null = 60, servers: number | null = 1, databases: number | null = 0, redis: number | null = 0) => ({
  maxProjects: projects,
  maxMembers: members,
  maxDeploymentsPerMonth: deployments,
  maxBuildMinutesPerMonth: build,
  maxServers: servers,
  maxDatabases: databases,
  maxRedisInstances: redis,
});

const plans: CatalogPlan[] = [
  { code: 'free', name: 'Free', priceMonthly: 0, priceYearly: 0, currency: 'CNY', contactSales: false, status: 'ACTIVE', highlighted: false, limits: limits(1, 1), features: { customDomain: false, advancedLogs: false, teamPermissions: false, auditLog: false, sso: false, supportLevel: 'community' } },
  { code: 'pro', name: 'Pro', priceMonthly: 99, priceYearly: 990, currency: 'CNY', contactSales: false, status: 'ACTIVE', highlighted: false, limits: limits(5, 3, 100, 500, 3, 2, 2), features: { customDomain: true, advancedLogs: true, teamPermissions: false, auditLog: false, sso: false, supportLevel: 'standard' } },
  { code: 'team', name: 'Team', priceMonthly: 299, priceYearly: 2990, currency: 'CNY', contactSales: false, status: 'ACTIVE', highlighted: false, limits: limits(20, 10, 500, 3000, 10, 10, 10), features: { customDomain: true, teamPermissions: true, auditLog: true, sso: false, supportLevel: 'priority' } },
  { code: 'enterprise', name: 'Enterprise', priceMonthly: 0, priceYearly: null, currency: 'CNY', contactSales: true, status: 'ACTIVE', highlighted: false, limits: limits(null, null, null, null, null, null, null), features: { customDomain: true, sso: true, privateNetworking: true, supportLevel: 'dedicated' } },
];

const emptyUsage = { projects: 0, members: 1, deployments: 0, buildMinutes: 0, servers: 0, databases: 0, redis: 0 };

test('pricing comes from configuration and yearly is independent', () => {
  assert.equal(displayMonthlyPrice({ contactSales: false, priceMonthly: 99, currency: 'CNY' }), '99 CNY / 月');
  assert.equal(displayMonthlyPrice({ contactSales: false, priceMonthly: 129, currency: 'CNY' }), '129 CNY / 月');
  assert.equal(displayMonthlyPrice({ contactSales: true, priceMonthly: 0, currency: 'CNY' }), '联系销售');
  assert.equal(displayYearlyPrice({ contactSales: false, priceYearly: 990, currency: 'CNY' }), '990 CNY / 年');
  assert.equal(yearlyIsIndependent(99, 990), true);
  assert.equal(yearlyIsIndependent(99, 99 * 12), false);
});

test('feature matrix uses product language', () => {
  const matrix = buildFeatureMatrix(plans);
  assert.equal(matrix.columns.join(','), 'Free,Pro,Team,Enterprise');
  const projects = matrix.rows.find((row) => row.label === '应用数量');
  assert.deepEqual(projects?.cells, ['1', '5', '20', '自定义']);
  const domain = matrix.rows.find((row) => row.label === '自定义域名');
  assert.deepEqual(domain?.cells, ['—', '✓', '✓', '✓']);
  const sso = matrix.rows.find((row) => row.label === 'SSO');
  assert.equal(sso?.cells[3], '✓');
  assert.equal(matrixHidesTechnicalKeys(matrix), true);
  assert.equal(userLimitSentence('应用数量', 5), '最多 5 个应用');
});

test('recommendations follow the packaging ladder', () => {
  const free = recommendBestPlan({
    currentPlan: 'free',
    usage: { ...emptyUsage, projects: 1, members: 1 },
    limits: { projects: 1, members: 1, deployments: 10, buildMinutes: 60, servers: 1, databases: 0, redis: 0 },
  });
  assert.equal(free.recommendedPlan, 'pro');
  assert.match(free.reasons[0] ?? '', /1\/1 个应用/);
  const pro = recommendBestPlan({
    currentPlan: 'pro',
    usage: { ...emptyUsage, projects: 2, members: 4 },
    limits: { projects: 5, members: 3, deployments: 100, buildMinutes: 500, servers: 3, databases: 2, redis: 2 },
    featureNeeds: { teamPermissions: true },
  });
  assert.equal(pro.recommendedPlan, 'team');
  assert.match(pro.reasons.join(' '), /Team/);
  const team = recommendBestPlan({
    currentPlan: 'team',
    usage: { ...emptyUsage, projects: 4, members: 2 },
    limits: { projects: 20, members: 10, deployments: 500, buildMinutes: 3000, servers: 10, databases: 10, redis: 10 },
    featureNeeds: { sso: true },
  });
  assert.equal(team.recommendedPlan, 'enterprise');
  const grandfathered = recommendBestPlan({
    currentPlan: 'free',
    usage: { ...emptyUsage, projects: 5, members: 1 },
    limits: { projects: 5, members: 5, deployments: 100, buildMinutes: 300, servers: 1, databases: 1, redis: 1 },
  });
  assert.equal(grandfathered.recommendedPlan, null);
});

test('upgrade triggers only when the user hits a need', () => {
  assert.equal(upgradeTrigger({ moment: 'browse' }).show, false);
  assert.equal(upgradeTrigger({ moment: 'create_project', blocked: true }).show, true);
  assert.equal(upgradeTrigger({ moment: 'create_project', blocked: false }).show, false);
  assert.equal(upgradeTrigger({ moment: 'invite_member', blocked: true }).show, true);
  assert.equal(upgradeTrigger({ moment: 'locked_feature', featureEnabled: false }).show, true);
  assert.equal(upgradeTrigger({ moment: 'locked_feature', featureEnabled: true }).show, false);
  assert.match(formatUpgradeReason({ used: 4, limit: 5, unit: '个应用', nextPlanName: 'Team', nextLimit: 20 }), /4\/5 个应用/);
  assert.match(formatUpgradeReason({ used: 4, limit: 5, unit: '个应用', nextPlanName: 'Team', nextLimit: 20 }), /20 个应用/);
});

test('comparison badges mark one current plan and one recommendation', () => {
  const badges = comparisonBadges({ codes: ['free', 'pro', 'team', 'enterprise'], currentPlan: 'free', recommendedPlan: 'pro' });
  assert.deepEqual(badges.free, ['当前套餐']);
  assert.deepEqual(badges.pro, ['推荐']);
  assert.deepEqual(badges.team, []);
  const same = comparisonBadges({ codes: ['free', 'pro'], currentPlan: 'pro', recommendedPlan: 'pro' });
  assert.deepEqual(same.pro, ['当前套餐']);
});

test('versions, grandfathering, inactive plans, and delete protection', () => {
  const oldVersion = { id: 'v1', version: 1, grandfathered: true };
  const latest = { id: 'v2', version: 2, grandfathered: false };
  assert.equal(selectCommercialVersion({ pinned: oldVersion, latest }).id, 'v1');
  assert.equal(selectCommercialVersion({ pinned: null, latest }).id, 'v2');
  assert.equal(billedSubscriptionAmount({ versionPrice: 99, livePrice: 129 }), 99);
  assert.equal(oldVersion.grandfathered, true);
  assert.equal(canAssignPlan('ACTIVE'), true);
  assert.equal(canAssignPlan('INACTIVE'), false);
  assert.equal(canAssignPlan('INTERNAL_TEST'), false);
  assert.equal(isCustomerVisiblePlan('PAYMENT_TEST', 'INTERNAL_TEST'), false);
  assert.equal(isCustomerVisiblePlan('pro', 'ACTIVE'), true);
  assert.notEqual(recommendBestPlan({
    currentPlan: 'free',
    usage: { projects: 1, members: 1, deployments: 0, buildMinutes: 0, servers: 0, databases: 0, redis: 0 },
    limits: { projects: 1, members: 1, deployments: 10, buildMinutes: 60, servers: 0, databases: 0, redis: 0 },
    catalog: { pro: { projects: 5, members: 3 }, team: { projects: 20, members: 10 }, enterprise: { projects: null, members: null } },
  }).recommendedPlan, 'PAYMENT_TEST');
  assert.equal(canAssignPlan('DRAFT'), false);
  assert.equal(assertPlanReferences({ subscriptions: 0, versions: 1, invoices: 0 }).ok, false);
  assert.equal(assertPlanReferences({ subscriptions: 1, versions: 0, invoices: 0 }).ok, false);
  assert.equal(assertPlanReferences({ subscriptions: 0, versions: 0, invoices: 1 }).ok, false);
  assert.equal(assertPlanReferences({ subscriptions: 0, versions: 0, invoices: 0 }).ok, true);
});

test('cloud cost, revenue, upgrade workflow, copy, and secrets stay separate', () => {
  const summary = presentCommercialSummary({ planName: 'LaunchOS Pro', priceMonthly: 99, contactSales: false, currency: 'CNY', estimatedCloudCost: 126 });
  assert.equal(summary.subscriptionFeeLabel, 'LaunchOS Pro：99 CNY / 月');
  assert.equal(summary.cloudCostLabel, '预计云资源：126 CNY / 月');
  assert.equal(summary.totalLabel, '合计预计：225 CNY / 月');
  assert.match(summary.disclaimer, /不包含实际云资源费用/);
  assert.equal(CLOUD_COST_DISCLAIMER.includes('另行产生'), true);
  const gift = estimateGrossMargin({ isRevenueGenerating: false, priceMonthly: 99, estimatedCloudCost: 126 });
  assert.equal(gift.subscriptionRevenue, null);
  assert.equal(gift.estimatedGrossMargin, null);
  const paid = estimateGrossMargin({ isRevenueGenerating: true, priceMonthly: 99, estimatedCloudCost: 126 });
  assert.equal(paid.estimatedGrossMargin, -27);
  assert.equal(approveUpgradeAction({ fromPlanCode: 'free' }).method, 'activateSubscription');
  assert.equal(approveUpgradeAction({ fromPlanCode: 'pro' }).method, 'changePlan');
  assert.equal(canRequestUpgrade('VIEWER'), false);
  assert.equal(canRequestUpgrade('OWNER'), true);
  assert.equal(canReviewUpgrade('USER'), false);
  assert.equal(canReviewUpgrade('PLATFORM_ADMIN'), true);
  const metadata = safeUpgradeMetadata({ reason: '需要更多应用', password: 'secret-value' });
  assert.equal('password' in metadata, false);
  assert.equal(metadata.reason, '需要更多应用');
});
