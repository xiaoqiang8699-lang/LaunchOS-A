import {
  SUBSCRIPTION_SOURCE,
  SUBSCRIPTION_GRACE_PERIOD_DAYS,
  isPaidSubscriptionSource,
  type BillingCycle,
  parseBillingCycle,
} from './subscription-lifecycle';
import { calculatePeriodEnd, gracePeriodEndFrom } from './billing-period';
import { DEFAULT_BUSINESS_TIMEZONE } from './subscription-operations';

export type ActivationPaymentInput = {
  paymentId: string;
  workspaceId: string;
  planId: string;
  planVersionId: string | null;
  planCode: string;
  billingCycle: BillingCycle | string;
  amountCents: number | null;
  paidAt: Date;
  isProductionTest?: boolean;
  isTestPayment?: boolean;
  businessType?: string | null;
  fulfillmentSource?: string | null;
  merchantOrderNo?: string | null;
};

export type ActivationResult =
  | { ok: true; action: 'SKIPPED_PAYMENT_TEST' }
  | { ok: true; action: 'ALREADY_APPLIED'; subscriptionId: string }
  | {
      ok: true;
      action: 'ACTIVATED' | 'RENEWED';
      subscriptionId: string;
      currentPeriodStart: string;
      currentPeriodEnd: string;
      billingCycle: BillingCycle;
      source: 'PAYMENT';
    }
  | { ok: false; code: string; message: string };

export function shouldSkipSubscriptionActivation(input: ActivationPaymentInput): boolean {
  if (input.isProductionTest) return true;
  if (String(input.planCode || '').toUpperCase() === 'PAYMENT_TEST') return true;
  const biz = String(input.businessType || '').toUpperCase();
  if (biz === 'PAYMENT_TEST') return true;
  const src = String(input.fulfillmentSource || '').toUpperCase();
  if (src === 'ALIPAY_PRODUCTION_TEST' || src === 'ALIPAY_SANDBOX') return true;
  return false;
}

export function decideSubscriptionActivation(input: {
  payment: ActivationPaymentInput;
  existing: {
    id: string;
    status: string;
    source: string;
    planId: string;
    currentPeriodEnd: Date | string;
    gracePeriodEnd?: Date | string | null;
    latestPaymentId?: string | null;
    billingCycle?: string | null;
  };
  timeZone?: string;
  now?: Date;
}): ActivationResult {
  const payment = input.payment;
  if (shouldSkipSubscriptionActivation(payment)) {
    return { ok: true, action: 'SKIPPED_PAYMENT_TEST' };
  }
  if (input.existing.latestPaymentId === payment.paymentId) {
    return { ok: true, action: 'ALREADY_APPLIED', subscriptionId: input.existing.id };
  }

  const code = String(payment.planCode || '').toLowerCase();
  if (!code || code === 'free' || code === 'payment_test' || code === 'enterprise') {
    return { ok: false, code: 'INVALID_PLAN', message: '付费订阅套餐无效' };
  }

  const cycle = parseBillingCycle(payment.billingCycle);
  if (cycle === 'NONE') {
    return { ok: false, code: 'INVALID_BILLING_CYCLE', message: '付费订阅需要月付或年付' };
  }

  const tz = input.timeZone || DEFAULT_BUSINESS_TIMEZONE;
  const now = input.now || payment.paidAt;
  const existingEnd = new Date(input.existing.currentPeriodEnd);
  const graceEnd = input.existing.gracePeriodEnd ? new Date(input.existing.gracePeriodEnd) : null;
  const status = input.existing.status;
  const paidSource = isPaidSubscriptionSource(input.existing.source);
  const inGrace =
    status === 'GRACE_PERIOD' ||
    (graceEnd != null && now.getTime() <= graceEnd.getTime() && now.getTime() >= existingEnd.getTime());

  const biz = String(payment.businessType || '').toUpperCase();
  const isRenewal =
    biz === 'SUBSCRIPTION_RENEWAL' ||
    (paidSource && (status === 'ACTIVE' || status === 'CANCEL_AT_PERIOD_END' || status === 'GRACE_PERIOD' || inGrace));

  let periodStart: Date;
  let action: 'ACTIVATED' | 'RENEWED';
  if (isRenewal && (inGrace || status === 'GRACE_PERIOD')) {
    periodStart = existingEnd;
    action = 'RENEWED';
  } else if (isRenewal && status === 'ACTIVE' && existingEnd.getTime() > now.getTime()) {
    periodStart = existingEnd;
    action = 'RENEWED';
  } else if (status === 'EXPIRED' || status === 'CANCELED') {
    periodStart = payment.paidAt;
    action = 'ACTIVATED';
  } else {
    periodStart = payment.paidAt;
    action = 'ACTIVATED';
  }

  const periodEnd = calculatePeriodEnd(periodStart, cycle, tz);
  return {
    ok: true,
    action,
    subscriptionId: input.existing.id,
    currentPeriodStart: periodStart.toISOString(),
    currentPeriodEnd: periodEnd.toISOString(),
    billingCycle: cycle,
    source: SUBSCRIPTION_SOURCE.PAYMENT,
  };
}

export function buildGraceStartPatch(input: {
  subscriptionId: string;
  currentPeriodEnd: string;
  timeZone?: string;
  graceDays?: number;
}): { gracePeriodEnd: string; status: 'GRACE_PERIOD'; eventType: 'SUBSCRIPTION_GRACE_STARTED'; idempotencyKey: string } {
  const days = input.graceDays ?? SUBSCRIPTION_GRACE_PERIOD_DAYS;
  const end = gracePeriodEndFrom(new Date(input.currentPeriodEnd), days, input.timeZone || DEFAULT_BUSINESS_TIMEZONE);
  return {
    status: 'GRACE_PERIOD',
    gracePeriodEnd: end.toISOString(),
    eventType: 'SUBSCRIPTION_GRACE_STARTED',
    idempotencyKey: `${input.subscriptionId}:SUBSCRIPTION_GRACE_STARTED:${input.currentPeriodEnd}`,
  };
}

export function entitlementPriority(input: {
  adminOverrideActive: boolean;
  paymentSubscriptionActive: boolean;
  betaOverrideActive: boolean;
}): 'ADMIN_OVERRIDE' | 'PAYMENT' | 'BETA_OVERRIDE' | 'FREE_DEFAULT' {
  if (input.adminOverrideActive) return 'ADMIN_OVERRIDE';
  if (input.paymentSubscriptionActive) return 'PAYMENT';
  if (input.betaOverrideActive) return 'BETA_OVERRIDE';
  return 'FREE_DEFAULT';
}
