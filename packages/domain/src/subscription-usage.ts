export const PLAN_CODES = ['free', 'pro', 'team', 'enterprise'] as const;
export const SUBSCRIPTION_STATUSES = [
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'CANCEL_AT_PERIOD_END',
  'CANCELED',
  'EXPIRED',
] as const;
export const EFFECTIVE_SUBSCRIPTION_STATUSES = ['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCEL_AT_PERIOD_END'] as const;
export const NEAR_LIMIT_RATIO = 0.8;
export const NON_USAGE_DEPLOYMENT_CLASSES = ['DRY_RUN', 'GATE_ONLY', 'PLAN', 'VERIFY_ONLY'] as const;
export const REAL_DEPLOYMENT_STATUSES = ['RUNNING', 'SUCCESS', 'FAILED'] as const;

export const SUBSCRIPTION_EVENTS = [
  'SUBSCRIPTION_CREATED',
  'SUBSCRIPTION_PLAN_CHANGED',
  'SUBSCRIPTION_PLAN_OVERRIDDEN',
  'SUBSCRIPTION_CANCEL_SCHEDULED',
  'SUBSCRIPTION_CANCELED',
  'QUOTA_NEAR_LIMIT',
  'QUOTA_EXCEEDED',
  'PLAN_LIMIT_REACHED',
] as const;

export type PlanLimits = {
  projects: number | null;
  members: number | null;
  deployments: number | null;
  buildMinutes: number | null;
  servers: number | null;
  databases: number | null;
  redis: number | null;
};

export type UsageCounts = {
  projects: number;
  members: number;
  deployments: number;
  buildMinutes: number | null;
  servers: number;
  databases: number;
  redis: number;
};

export type QuotaMetric = {
  limit: number | null;
  used: number | null;
  remaining: number | null;
  percent: number | null;
  exceeded: boolean;
  near: boolean;
};

export function subscriptionStatusLabel(status: string): string {
  if (status === 'TRIALING') return '试用中';
  if (status === 'ACTIVE') return '正常';
  if (status === 'PAST_DUE') return '待处理';
  if (status === 'CANCEL_AT_PERIOD_END') return '到期取消';
  if (status === 'CANCELED') return '已取消';
  if (status === 'EXPIRED') return '已过期';
  return '正常';
}

export function shanghaiNaturalMonth(now: Date): { start: Date; end: Date } {
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const start = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - 8 * 60 * 60 * 1000;
  const end = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 1) - 8 * 60 * 60 * 1000;
  return { start: new Date(start), end: new Date(end) };
}

export function resolveUsagePeriod(input: {
  planCode: string;
  currentPeriodStart?: string | Date | null;
  currentPeriodEnd?: string | Date | null;
  now?: Date;
}): { start: Date; end: Date } {
  if (input.planCode !== 'free' && input.currentPeriodStart && input.currentPeriodEnd) {
    return { start: new Date(input.currentPeriodStart), end: new Date(input.currentPeriodEnd) };
  }
  return shanghaiNaturalMonth(input.now ?? new Date());
}

export function resolveEffectivePlan<TPlan extends { code: string }, TSubscription extends { status: string; overrideSource?: string | null; plan: TPlan }>(input: {
  freePlan: TPlan;
  subscription: TSubscription | null;
}): { plan: TPlan; subscription: TSubscription | null; source: 'DEFAULT_FREE' | 'SUBSCRIPTION' | 'ADMIN_OVERRIDE' } {
  const subscription = input.subscription;
  if (!subscription) {
    return { plan: input.freePlan, subscription: null, source: 'DEFAULT_FREE' };
  }
  const usable = (EFFECTIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(subscription.status);
  if (!usable) {
    return { plan: input.freePlan, subscription, source: 'DEFAULT_FREE' };
  }
  if (subscription.overrideSource) {
    return { plan: subscription.plan, subscription, source: 'ADMIN_OVERRIDE' };
  }
  if (subscription.plan.code === 'free') {
    return { plan: subscription.plan, subscription, source: 'DEFAULT_FREE' };
  }
  return { plan: subscription.plan, subscription, source: 'SUBSCRIPTION' };
}

export function projectCountsTowardQuota(project: { status: string; isDemo?: boolean; internal?: boolean }): boolean {
  if (project.status === 'ARCHIVED' || project.status === 'TEST') return false;
  if (project.isDemo || project.internal) return false;
  return true;
}

export function memberCountsTowardQuota(member: { status?: string }): boolean {
  return (member.status ?? 'ACTIVE') === 'ACTIVE';
}

export function countsAsDeployment(input: { usageClass?: string | null; status: string }): boolean {
  const usageClass = input.usageClass ?? 'REAL_EXECUTION';
  if ((NON_USAGE_DEPLOYMENT_CLASSES as readonly string[]).includes(usageClass)) return false;
  return (REAL_DEPLOYMENT_STATUSES as readonly string[]).includes(input.status);
}

export function isBuildStep(stepKey: string): boolean {
  return stepKey === 'BUILD_APPLICATION' || /^build/i.test(stepKey);
}

export function buildMinutesFromMilliseconds(totalMs: number | null): number | null {
  if (totalMs == null) return null;
  return Math.ceil(totalMs / 1000 / 60);
}

export function sumMeasuredBuildMilliseconds(durations: Array<number | null>): number | null {
  const measured = durations.filter((value): value is number => value != null);
  if (measured.length === 0) return null;
  return measured.reduce((sum, value) => sum + value, 0);
}

export function quotaMetric(used: number | null, limit: number | null): QuotaMetric {
  const comparable = used ?? 0;
  const exceeded = limit != null && used != null && comparable > limit;
  const percent = limit == null || used == null ? null : limit === 0 ? (comparable > 0 ? 100 : 0) : Math.round((comparable / limit) * 100);
  const near = !exceeded && percent != null && percent >= NEAR_LIMIT_RATIO * 100;
  return {
    limit,
    used,
    remaining: limit == null || used == null ? null : Math.max(0, limit - used),
    percent,
    exceeded,
    near,
  };
}

export function evaluateUsageAgainstPlan(input: { limits: PlanLimits; usage: UsageCounts }): {
  quota: Record<keyof UsageCounts, QuotaMetric>;
  overallStatus: 'WITHIN_LIMIT' | 'NEAR_LIMIT' | 'OVER_LIMIT';
} {
  const keys: Array<keyof UsageCounts> = ['projects', 'members', 'deployments', 'buildMinutes', 'servers', 'databases', 'redis'];
  const quota = Object.fromEntries(keys.map((key) => [key, quotaMetric(input.usage[key], input.limits[key])])) as Record<keyof UsageCounts, QuotaMetric>;
  const values = Object.values(quota);
  const overallStatus = values.some((line) => line.exceeded) ? 'OVER_LIMIT' : values.some((line) => line.near) ? 'NEAR_LIMIT' : 'WITHIN_LIMIT';
  return { quota, overallStatus };
}

export function projectLimitDecision(input: { used: number; limit: number | null; adminOverride?: boolean }):
  | { ok: true }
  | { ok: false; code: 'PLAN_LIMIT_REACHED'; message: string } {
  if (input.adminOverride || input.limit == null || input.used < input.limit) return { ok: true };
  return { ok: false, code: 'PLAN_LIMIT_REACHED', message: `当前套餐最多支持 ${input.limit} 个应用，请升级套餐后继续。` };
}

export function memberLimitDecision(input: { used: number; limit: number | null; adminOverride?: boolean }):
  | { ok: true }
  | { ok: false; code: 'MEMBER_LIMIT_REACHED'; message: string } {
  if (input.adminOverride || input.limit == null || input.used < input.limit) return { ok: true };
  return { ok: false, code: 'MEMBER_LIMIT_REACHED', message: `当前套餐最多支持 ${input.limit} 名成员，请升级套餐后继续。` };
}

export function usageWarning(input: { kind: 'deployments' | 'buildMinutes'; used: number | null; limit: number | null }): {
  blocks: false;
  quotaExceeded: boolean;
  message: string | null;
} {
  const line = quotaMetric(input.used, input.limit);
  if (input.kind === 'buildMinutes' && line.near) {
    return { blocks: false, quotaExceeded: false, message: '你的构建用量已接近上限' };
  }
  if (!line.exceeded) return { blocks: false, quotaExceeded: false, message: line.near ? '本月使用量接近套餐上限。' : null };
  return {
    blocks: false,
    quotaExceeded: true,
    message: input.kind === 'deployments' ? '本月部署次数已超过套餐建议额度' : '你的构建用量已接近上限',
  };
}

export function recommendPlanUpgrade(input: {
  currentPlan: string;
  usage: { projects: number; members: number };
  limits: { projects: number | null; members: number | null };
}): { currentPlan: string; recommendedPlan: string | null; reason: string | null } {
  const current = input.currentPlan;
  const projectsNear = input.limits.projects != null && input.limits.projects > 0 && input.usage.projects / input.limits.projects >= NEAR_LIMIT_RATIO;
  if (current === 'free' && (projectsNear || input.usage.members > 1)) {
    return { currentPlan: current, recommendedPlan: 'pro', reason: projectsNear ? '应用用量接近套餐上限' : '成员数量已超过个人使用范围' };
  }
  if (current === 'pro' && (input.usage.members > 3 || projectsNear)) {
    return { currentPlan: current, recommendedPlan: 'team', reason: '当前用量适合团队套餐' };
  }
  return { currentPlan: current, recommendedPlan: null, reason: null };
}

export function assertFeatureFlags(value: unknown): { ok: true; flags: Record<string, boolean | number | string> } | { ok: false; message: string } {
  if (value == null) return { ok: true, flags: {} };
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, message: '功能开关必须是对象' };
  const flags: Record<string, boolean | number | string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'boolean' || typeof item === 'number' || typeof item === 'string') flags[key] = item;
    else return { ok: false, message: '功能开关只支持布尔、数字或字符串' };
  }
  return { ok: true, flags };
}

export function assertPlanCodeChange(input: { currentCode: string; nextCode: string; subscriptionCount: number }): { ok: true } | { ok: false; message: string } {
  if (input.currentCode === input.nextCode) return { ok: true };
  if (input.subscriptionCount > 0) return { ok: false, message: '已有订阅引用该套餐，不能修改代码' };
  return { ok: true };
}

export function assertPlanDelete(subscriptionCount: number): { ok: true } | { ok: false; message: string } {
  if (subscriptionCount > 0) return { ok: false, message: '已有订阅引用该套餐，不能删除' };
  return { ok: true };
}

export function separatePriceAndCost(input: { priceMonthly: number; estimatedCloudCost: number | null }): {
  priceMonthly: number;
  estimatedCloudCost: number | null;
  grossMargin: number | null;
} {
  return {
    priceMonthly: input.priceMonthly,
    estimatedCloudCost: input.estimatedCloudCost,
    grossMargin: input.estimatedCloudCost == null ? null : input.priceMonthly - input.estimatedCloudCost,
  };
}

export type PaymentCheckoutResult = { available: false; message: '支付功能即将开放' };

export interface PaymentProvider {
  createCheckout(input: { workspaceId: string; planCode: string }): Promise<PaymentCheckoutResult>;
  getCheckoutStatus(input: { orderId: string }): Promise<PaymentCheckoutResult>;
  createSubscription(input: { workspaceId: string; planCode: string }): Promise<PaymentCheckoutResult>;
  cancelSubscription(input: { subscriptionId: string }): Promise<PaymentCheckoutResult>;
  getInvoice(input: { invoiceId: string }): Promise<PaymentCheckoutResult>;
  refundPayment(input: { paymentId: string }): Promise<PaymentCheckoutResult>;
}

const paymentUnavailable = async (): Promise<PaymentCheckoutResult> => ({ available: false, message: '支付功能即将开放' });

export const unavailablePaymentProvider: PaymentProvider = {
  createCheckout: paymentUnavailable,
  getCheckoutStatus: paymentUnavailable,
  createSubscription: paymentUnavailable,
  cancelSubscription: paymentUnavailable,
  getInvoice: paymentUnavailable,
  refundPayment: paymentUnavailable,
};

export function nearLimitCopy(): string {
  return '本月使用量接近套餐上限。';
}
