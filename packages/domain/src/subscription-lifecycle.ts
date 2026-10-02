/**
 * M8-2 Subscription Lifecycle constants (sources, cycles, grace).
 * Keep string sources (not Prisma enum) for backwards compatibility.
 */

export const SUBSCRIPTION_GRACE_PERIOD_DAYS = Number(process.env.SUBSCRIPTION_GRACE_PERIOD_DAYS ?? '3') || 3;

/** Canonical sources (write these going forward). */
export const SUBSCRIPTION_SOURCE = {
  FREE_DEFAULT: 'FREE_DEFAULT',
  PAYMENT: 'PAYMENT',
  BETA_OVERRIDE: 'BETA_OVERRIDE',
  ADMIN_OVERRIDE: 'ADMIN_OVERRIDE',
  MIGRATED_LEGACY: 'MIGRATED_LEGACY',
  TRIAL: 'TRIAL',
  COMPLIMENTARY: 'COMPLIMENTARY',
  /** @deprecated alias kept for reads */
  DEFAULT_FREE: 'DEFAULT_FREE',
  /** @deprecated alias kept for reads */
  PAYMENT_PROVIDER: 'PAYMENT_PROVIDER',
  MANUAL_ADMIN: 'MANUAL_ADMIN',
} as const;

export type SubscriptionSourceCanonical =
  | 'FREE_DEFAULT'
  | 'PAYMENT'
  | 'BETA_OVERRIDE'
  | 'ADMIN_OVERRIDE'
  | 'MIGRATED_LEGACY'
  | 'TRIAL'
  | 'COMPLIMENTARY'
  | 'MANUAL_ADMIN';

export const BILLING_CYCLES = ['MONTHLY', 'YEARLY', 'NONE'] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

export const M8_LIFECYCLE_EVENT_TYPES = [
  'SUBSCRIPTION_CREATED',
  'SUBSCRIPTION_ACTIVATED',
  'SUBSCRIPTION_RENEWED',
  'SUBSCRIPTION_CANCEL_SCHEDULED',
  'SUBSCRIPTION_CANCEL_REVERSED',
  'SUBSCRIPTION_GRACE_STARTED',
  'SUBSCRIPTION_EXPIRED',
  'SUBSCRIPTION_PLAN_CHANGE_SCHEDULED',
  'SUBSCRIPTION_PLAN_CHANGE_APPLIED',
  'SUBSCRIPTION_OVER_QUOTA',
  'SUBSCRIPTION_RECONCILED',
] as const;

/** Normalize legacy source strings to canonical form for display / entitlement. */
export function normalizeSubscriptionSource(source: string | null | undefined): SubscriptionSourceCanonical {
  const s = (source || '').trim();
  if (!s || s === 'DEFAULT_FREE' || s === 'FREE_DEFAULT') return 'FREE_DEFAULT';
  if (s === 'PAYMENT_PROVIDER' || s === 'PAYMENT' || s === 'ALIPAY' || s === 'MOCK_PAYMENT') return 'PAYMENT';
  if (s === 'BETA_OVERRIDE' || s === 'BETA_TESTER_OVERRIDE' || s === 'COMPLIMENTARY') {
    // COMPLIMENTARY stays distinct for lifecycle expiry; map display later
    if (s === 'COMPLIMENTARY') return 'COMPLIMENTARY';
    return 'BETA_OVERRIDE';
  }
  if (s === 'ADMIN_OVERRIDE' || s === 'MANUAL_ADMIN_OVERRIDE') return 'ADMIN_OVERRIDE';
  if (s === 'MANUAL_ADMIN') return 'MANUAL_ADMIN';
  if (s === 'TRIAL') return 'TRIAL';
  if (s === 'MIGRATED_LEGACY' || s === 'MIGRATED_LEGACY_BETA') return 'MIGRATED_LEGACY';
  if (s === 'ALIPAY_PRODUCTION_TEST' || s === 'ALIPAY_SANDBOX') return 'FREE_DEFAULT';
  return 'FREE_DEFAULT';
}

export function isPaidSubscriptionSource(source: string | null | undefined): boolean {
  const n = normalizeSubscriptionSource(source);
  return n === 'PAYMENT';
}

export function isRevenueGeneratingSource(source: string | null | undefined): boolean {
  return isPaidSubscriptionSource(source);
}

export function sourceDisplayLabel(source: string | null | undefined): string {
  const n = normalizeSubscriptionSource(source);
  switch (n) {
    case 'PAYMENT':
      return '真实订阅';
    case 'BETA_OVERRIDE':
      return 'Beta 测试权益';
    case 'ADMIN_OVERRIDE':
      return '管理员覆盖';
    case 'COMPLIMENTARY':
      return '平台赠送';
    case 'TRIAL':
      return '试用';
    case 'MANUAL_ADMIN':
      return '管理员开通';
    case 'MIGRATED_LEGACY':
      return '历史迁移';
    default:
      return '免费默认';
  }
}

export function parseBillingCycle(raw: string | null | undefined): BillingCycle {
  const v = String(raw || '')
    .trim()
    .toUpperCase();
  if (v === 'MONTHLY' || v === 'MONTH') return 'MONTHLY';
  if (v === 'YEARLY' || v === 'YEAR' || v === 'ANNUAL') return 'YEARLY';
  return 'NONE';
}

export type SystemClock = { now: () => Date };

export const systemClock: SystemClock = { now: () => new Date() };

export function fakeClock(fixed: Date): SystemClock {
  return { now: () => new Date(fixed.getTime()) };
}
