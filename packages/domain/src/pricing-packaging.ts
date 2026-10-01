import { sanitizeAdminAuditMetadata } from './admin-user-management';

export const CLOUD_COST_DISCLAIMER = '套餐费用不包含实际云资源费用。云资源费用根据你使用的服务器、数据库等另行产生。';

export const PLAN_AUDIENCE: Record<string, string> = {
  free: '适合第一次体验 LaunchOS 的个人用户',
  pro: '适合独立开发者和小型线上项目',
  team: '适合多人协作和商业项目',
  enterprise: '适合需要高级权限、安全和定制能力的企业',
};

export const FEATURE_LABELS: Record<string, string> = {
  customDomain: '自定义域名',
  priorityBuild: '优先构建',
  advancedLogs: '高级日志',
  teamPermissions: '团队权限',
  auditLog: '审计日志',
  privateNetworking: '私有网络',
  sso: 'SSO',
  supportLevel: '支持级别',
};

export const LIMIT_LABELS: Record<string, string> = {
  maxProjects: '应用数量',
  maxMembers: '成员数量',
  maxDeploymentsPerMonth: '每月部署次数',
  maxBuildMinutesPerMonth: '构建分钟',
  maxServers: '服务器数量',
  maxDatabases: '数据库数量',
  maxRedisInstances: 'Redis 数量',
};

const SUPPORT_LABELS: Record<string, string> = {
  community: '社区',
  standard: '标准',
  priority: '优先',
  dedicated: '专属',
};

export type CommercialLimits = {
  maxProjects: number | null;
  maxMembers: number | null;
  maxDeploymentsPerMonth: number | null;
  maxBuildMinutesPerMonth: number | null;
  maxServers: number | null;
  maxDatabases: number | null;
  maxRedisInstances: number | null;
};

export type CatalogPlan = {
  code: string;
  name: string;
  priceMonthly: number;
  priceYearly: number | null;
  currency: string;
  contactSales: boolean;
  status: string;
  highlighted: boolean;
  limits: CommercialLimits;
  features: Record<string, boolean | string>;
};

const NEXT_PLAN: Record<string, string> = { free: 'pro', pro: 'team', team: 'enterprise' };
const PLAN_NAMES: Record<string, string> = { free: 'Pro', pro: 'Team', team: 'Enterprise', enterprise: 'Enterprise' };

export function displayMonthlyPrice(input: { contactSales: boolean; priceMonthly: number; currency: string }): string {
  if (input.contactSales) return '联系销售';
  return `${input.priceMonthly} ${input.currency} / 月`;
}

export function displayYearlyPrice(input: { contactSales: boolean; priceYearly: number | null; currency: string }): string | null {
  if (input.contactSales) return '联系销售';
  if (input.priceYearly == null) return null;
  return `${input.priceYearly} ${input.currency} / 年`;
}

export function yearlyIsIndependent(monthly: number, yearly: number | null): boolean {
  if (yearly == null) return true;
  return yearly !== monthly * 12;
}

export function formatLimitCell(value: number | null): string {
  if (value == null) return '自定义';
  return String(value);
}

export function formatFeatureCell(value: boolean | string | undefined): string {
  if (value === true) return '✓';
  if (value === false || value == null) return '—';
  return SUPPORT_LABELS[value] ?? String(value);
}

export function userLimitSentence(label: string, value: number | null): string {
  if (value == null) return `${label}按合同定制`;
  if (label === '应用数量') return `最多 ${value} 个应用`;
  if (label === '成员数量') return `最多 ${value} 名成员`;
  if (label === '每月部署次数') return `每月最多 ${value} 次部署`;
  if (label === '构建分钟') return `每月最多 ${value} 分钟构建`;
  return `${label} ${value}`;
}

export function buildFeatureMatrix(plans: CatalogPlan[]): { columns: string[]; rows: Array<{ label: string; cells: string[] }> } {
  const columns = plans.map((plan) => plan.name);
  const limitKeys = Object.keys(LIMIT_LABELS);
  const featureKeys = ['customDomain', 'priorityBuild', 'advancedLogs', 'teamPermissions', 'auditLog', 'privateNetworking', 'sso', 'supportLevel'];
  const rows = [
    ...limitKeys.map((key) => ({
      label: LIMIT_LABELS[key] ?? key,
      cells: plans.map((plan) => formatLimitCell(plan.limits[key as keyof CommercialLimits])),
    })),
    ...featureKeys.map((key) => ({
      label: FEATURE_LABELS[key] ?? key,
      cells: plans.map((plan) => formatFeatureCell(plan.features[key])),
    })),
  ];
  return { columns, rows };
}

export function matrixHidesTechnicalKeys(matrix: { rows: Array<{ label: string }> }): boolean {
  return matrix.rows.every((row) => !/maxProjects|priorityBuild|featuresJson/.test(row.label));
}

type Usage = { projects: number; members: number; deployments: number; buildMinutes: number | null; servers: number; databases: number; redis: number };
type UsageLimits = { projects: number | null; members: number | null; deployments: number | null; buildMinutes: number | null; servers: number | null; databases: number | null; redis: number | null };

function near(used: number, limit: number | null): boolean {
  if (limit == null || limit <= 0) return false;
  return used / limit >= 0.8;
}

function raisesQuota(next: number | null | undefined, current: number | null): boolean {
  if (next == null) return current != null;
  if (current == null) return false;
  return next > current;
}

export function recommendBestPlan(input: {
  currentPlan: string;
  usage: Usage;
  limits: UsageLimits;
  featureNeeds?: { customDomain?: boolean; teamPermissions?: boolean; auditLog?: boolean; sso?: boolean; privateNetworking?: boolean; dedicatedSla?: boolean };
  catalog?: Record<string, { projects: number | null; members: number | null }>;
}): { currentPlan: string; recommendedPlan: string | null; reasons: string[] } {
  const needs = input.featureNeeds ?? {};
  const catalog = input.catalog ?? { pro: { projects: 5, members: 3 }, team: { projects: 20, members: 10 }, enterprise: { projects: null, members: null } };
  const reasons: string[] = [];
  const current = input.currentPlan;
  if (current === 'free') {
    if (near(input.usage.projects, input.limits.projects) && raisesQuota(catalog.pro?.projects, input.limits.projects)) {
      reasons.push(formatUpgradeReason({ used: input.usage.projects, limit: input.limits.projects ?? 0, unit: '个应用', nextPlanName: 'Pro', nextLimit: catalog.pro?.projects ?? null }));
    }
    if (input.usage.members > 1 && raisesQuota(catalog.pro?.members, input.limits.members)) {
      reasons.push(formatUpgradeReason({ used: input.usage.members, limit: input.limits.members ?? input.usage.members, unit: '名成员', nextPlanName: 'Pro', nextLimit: catalog.pro?.members ?? null }));
    }
    if (needs.customDomain) reasons.push('当前套餐不包含自定义域名。升级到 Pro 后可以使用自定义域名。');
    if (reasons.length > 0) return { currentPlan: current, recommendedPlan: 'pro', reasons };
  }
  if (current === 'pro') {
    if (input.usage.members > 3 && raisesQuota(catalog.team?.members, input.limits.members)) {
      reasons.push(formatUpgradeReason({ used: input.usage.members, limit: input.limits.members ?? input.usage.members, unit: '名成员', nextPlanName: 'Team', nextLimit: catalog.team?.members ?? null }));
    }
    if (near(input.usage.projects, input.limits.projects) && raisesQuota(catalog.team?.projects, input.limits.projects)) {
      reasons.push(formatUpgradeReason({ used: input.usage.projects, limit: input.limits.projects ?? 0, unit: '个应用', nextPlanName: 'Team', nextLimit: catalog.team?.projects ?? null }));
    }
    if (needs.teamPermissions) reasons.push('团队权限需要 Team 套餐。升级到 Team 后可配置更完整的成员权限。');
    if (needs.auditLog) reasons.push('审计日志需要 Team 套餐。升级到 Team 后可以查看审计记录。');
    if (reasons.length > 0) return { currentPlan: current, recommendedPlan: 'team', reasons };
  }
  if (current === 'team') {
    if (needs.sso) reasons.push('SSO 需要 Enterprise。升级后可按合同开通单点登录。');
    if (needs.privateNetworking) reasons.push('私有网络需要 Enterprise。升级后可按合同开通。');
    if (needs.dedicatedSla) reasons.push('专属 SLA 需要 Enterprise。升级后可联系销售约定服务等级。');
    const over =
      (input.limits.projects != null && input.usage.projects > input.limits.projects) ||
      (input.limits.members != null && input.usage.members > input.limits.members) ||
      (input.limits.deployments != null && input.usage.deployments > input.limits.deployments);
    if (over) reasons.push('当前用量已超过 Team 额度。升级到 Enterprise 后可按合同定制额度。');
    if (reasons.length > 0) return { currentPlan: current, recommendedPlan: 'enterprise', reasons };
  }
  return { currentPlan: current, recommendedPlan: null, reasons: [] };
}

export function formatUpgradeReason(input: { used: number; limit: number; unit: string; nextPlanName: string; nextLimit: number | null }): string {
  const next = input.nextLimit == null ? '可按合同定制额度' : `可支持最多 ${input.nextLimit} ${input.unit}`;
  return `你当前已有 ${input.used}/${input.limit} ${input.unit}。升级到 ${input.nextPlanName} 后${next}。`;
}

export function upgradeTrigger(input: { moment: 'create_project' | 'invite_member' | 'near_quota' | 'locked_feature' | 'browse'; blocked?: boolean; featureEnabled?: boolean }): { show: boolean } {
  if (input.moment === 'browse') return { show: false };
  if (input.moment === 'near_quota') return { show: true };
  if (input.moment === 'locked_feature') return { show: input.featureEnabled === false };
  return { show: input.blocked === true };
}

export function comparisonBadges(input: { codes: string[]; currentPlan: string; recommendedPlan: string | null }): Record<string, Array<'当前套餐' | '推荐'>> {
  const badges: Record<string, Array<'当前套餐' | '推荐'>> = {};
  for (const code of input.codes) badges[code] = [];
  if (badges[input.currentPlan]) badges[input.currentPlan]?.push('当前套餐');
  if (input.recommendedPlan && input.recommendedPlan !== input.currentPlan && badges[input.recommendedPlan]) {
    badges[input.recommendedPlan]?.push('推荐');
  }
  return badges;
}

export function selectCommercialVersion<T extends { id: string; version: number; grandfathered: boolean }>(input: { pinned: T | null; latest: T }): T {
  return input.pinned ?? input.latest;
}

export function billedSubscriptionAmount(input: { versionPrice: number; livePrice: number }): number {
  return input.versionPrice;
}

export function canAssignPlan(status: string): boolean {
  return status === 'ACTIVE';
}

export function isCustomerVisiblePlan(code: string, status: string): boolean {
  return status === 'ACTIVE' && (code === 'free' || code === 'pro' || code === 'team' || code === 'enterprise');
}

export function assertPlanReferences(input: { subscriptions: number; versions: number; invoices: number }): { ok: true } | { ok: false; message: string } {
  if (input.subscriptions > 0 || input.versions > 0 || input.invoices > 0) {
    return { ok: false, message: '套餐已被订阅、版本或账单引用，只能停用' };
  }
  return { ok: true };
}

export function presentCommercialSummary(input: {
  planName: string;
  priceMonthly: number;
  contactSales: boolean;
  currency: string;
  estimatedCloudCost: number | null;
}): {
  subscriptionFeeLabel: string;
  cloudCostLabel: string;
  totalLabel: string | null;
  cloudCostEstimated: true;
  disclaimer: string;
} {
  const subscriptionFeeLabel = input.contactSales ? `${input.planName}：联系销售` : `${input.planName}：${input.priceMonthly} ${input.currency} / 月`;
  const cloudCostLabel = input.estimatedCloudCost == null ? '预计云资源：暂未估算' : `预计云资源：${input.estimatedCloudCost} ${input.currency} / 月`;
  const totalLabel =
    input.contactSales || input.estimatedCloudCost == null ? null : `合计预计：${input.priceMonthly + input.estimatedCloudCost} ${input.currency} / 月`;
  return { subscriptionFeeLabel, cloudCostLabel, totalLabel, cloudCostEstimated: true, disclaimer: CLOUD_COST_DISCLAIMER };
}

export function estimateGrossMargin(input: { isRevenueGenerating: boolean; priceMonthly: number; estimatedCloudCost: number | null }): {
  subscriptionRevenue: number | null;
  estimatedCloudCost: number | null;
  estimatedGrossMargin: number | null;
} {
  if (!input.isRevenueGenerating) return { subscriptionRevenue: null, estimatedCloudCost: input.estimatedCloudCost, estimatedGrossMargin: null };
  return {
    subscriptionRevenue: input.priceMonthly,
    estimatedCloudCost: input.estimatedCloudCost,
    estimatedGrossMargin: input.estimatedCloudCost == null ? null : input.priceMonthly - input.estimatedCloudCost,
  };
}

export function canRequestUpgrade(role: string): boolean {
  return role === 'OWNER' || role === 'ADMIN' || role === 'MEMBER';
}

export function canReviewUpgrade(platformRole: string): boolean {
  return platformRole === 'PLATFORM_ADMIN';
}

export function approveUpgradeAction(input: { fromPlanCode: string }): { method: 'activateSubscription' | 'changePlan' } {
  if (input.fromPlanCode === 'free') return { method: 'activateSubscription' };
  return { method: 'changePlan' };
}

export function nextPlanCode(current: string): string | null {
  return NEXT_PLAN[current] ?? null;
}

export function planDisplayName(code: string): string {
  return PLAN_NAMES[code] ?? code;
}

export function safeUpgradeMetadata(input: { reason: string; password?: string }): Record<string, string | number | boolean | null> {
  return sanitizeAdminAuditMetadata(input);
}
