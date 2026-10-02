import { isPaidSubscriptionSource, normalizeSubscriptionSource } from './subscription-lifecycle';
import { shouldSkipSubscriptionActivation } from './subscription-activation';

export type ReconcileFinding =
  | { code: 'PAYMENT_SUCCEEDED_SUBSCRIPTION_NOT_ACTIVATED'; paymentId: string; workspaceId: string; severity: 'HIGH' }
  | { code: 'ACTIVE_WITHOUT_VALID_SOURCE'; subscriptionId: string; workspaceId: string; severity: 'MEDIUM' }
  | { code: 'PLAN_PAYMENT_MISMATCH'; subscriptionId: string; paymentId: string; severity: 'HIGH' }
  | { code: 'PERIOD_ENDED_STILL_ACTIVE'; subscriptionId: string; workspaceId: string; severity: 'MEDIUM' }
  | { code: 'SCHEDULED_CHANGE_DUE'; subscriptionId: string; changeRequestId: string; severity: 'LOW' }
  | { code: 'PAYMENT_TEST_MUST_NOT_ACTIVATE'; paymentId: string; severity: 'HIGH' }
  | { code: 'AMBIGUOUS_SOURCE'; subscriptionId: string; workspaceId: string; severity: 'HIGH'; note: string };

export function detectSubscriptionDrift(input: {
  now: Date;
  payments: Array<{
    id: string;
    workspaceId: string;
    status: string;
    planCode?: string | null;
    isProductionTest?: boolean;
    businessType?: string | null;
    fulfillmentSource?: string | null;
    activatedOnSubscription?: boolean;
  }>;
  subscriptions: Array<{
    id: string;
    workspaceId: string;
    status: string;
    source: string;
    planCode: string;
    currentPeriodEnd: Date | string;
    gracePeriodEnd?: Date | string | null;
    latestPaymentId?: string | null;
    pendingPlanId?: string | null;
    planChangeEffectiveAt?: Date | string | null;
  }>;
  changeRequests?: Array<{
    id: string;
    subscriptionId: string;
    status: string;
    effectiveAt: Date | string;
  }>;
}): ReconcileFinding[] {
  const findings: ReconcileFinding[] = [];
  for (const p of input.payments) {
    if (p.status !== 'SUCCEEDED') continue;
    const skip = shouldSkipSubscriptionActivation({
      paymentId: p.id,
      workspaceId: p.workspaceId,
      planId: '',
      planVersionId: null,
      planCode: p.planCode || '',
      billingCycle: 'MONTHLY',
      amountCents: null,
      paidAt: input.now,
      isProductionTest: p.isProductionTest,
      businessType: p.businessType,
      fulfillmentSource: p.fulfillmentSource,
    });
    if (skip) {
      if (p.activatedOnSubscription) {
        findings.push({ code: 'PAYMENT_TEST_MUST_NOT_ACTIVATE', paymentId: p.id, severity: 'HIGH' });
      }
      continue;
    }
    if (!p.activatedOnSubscription) {
      findings.push({
        code: 'PAYMENT_SUCCEEDED_SUBSCRIPTION_NOT_ACTIVATED',
        paymentId: p.id,
        workspaceId: p.workspaceId,
        severity: 'HIGH',
      });
    }
  }

  for (const s of input.subscriptions) {
    const end = new Date(s.currentPeriodEnd).getTime();
    const grace = s.gracePeriodEnd ? new Date(s.gracePeriodEnd).getTime() : null;
    if (
      (s.status === 'ACTIVE' || s.status === 'CANCEL_AT_PERIOD_END') &&
      isPaidSubscriptionSource(s.source) &&
      end < input.now.getTime() &&
      (grace == null || grace < input.now.getTime())
    ) {
      findings.push({
        code: 'PERIOD_ENDED_STILL_ACTIVE',
        subscriptionId: s.id,
        workspaceId: s.workspaceId,
        severity: 'MEDIUM',
      });
    }
    if (
      (s.status === 'ACTIVE' || s.status === 'CANCEL_AT_PERIOD_END') &&
      s.planCode !== 'free' &&
      !isPaidSubscriptionSource(s.source) &&
      normalizeSubscriptionSource(s.source) === 'FREE_DEFAULT'
    ) {
      findings.push({
        code: 'ACTIVE_WITHOUT_VALID_SOURCE',
        subscriptionId: s.id,
        workspaceId: s.workspaceId,
        severity: 'MEDIUM',
      });
    }
    if (s.planCode !== 'free' && s.source === 'COMPLIMENTARY' && !s.latestPaymentId) {
      // beta complimentary is valid; not ambiguous
    }
  }

  for (const c of input.changeRequests || []) {
    if (c.status !== 'PENDING') continue;
    if (new Date(c.effectiveAt).getTime() <= input.now.getTime()) {
      findings.push({
        code: 'SCHEDULED_CHANGE_DUE',
        subscriptionId: c.subscriptionId,
        changeRequestId: c.id,
        severity: 'LOW',
      });
    }
  }

  return findings;
}

export type BackfillClass = 'FREE' | 'BETA_OVERRIDE' | 'PAYMENT' | 'AMBIGUOUS';

export function classifySubscriptionForBackfill(row: {
  planCode: string;
  source: string;
  status: string;
  complimentaryReason?: string | null;
  overrideSource?: string | null;
  latestPaymentId?: string | null;
  isProductionTestPaymentOnly?: boolean;
}): { class: BackfillClass; targetSource: string; note?: string } {
  if (row.isProductionTestPaymentOnly) {
    return { class: 'FREE', targetSource: 'FREE_DEFAULT', note: 'PAYMENT_TEST must not become PAYMENT' };
  }
  if (row.planCode === 'free' || row.source === 'DEFAULT_FREE' || row.source === 'FREE_DEFAULT') {
    return { class: 'FREE', targetSource: 'FREE_DEFAULT' };
  }
  if (row.latestPaymentId && (row.source === 'PAYMENT_PROVIDER' || row.source === 'PAYMENT' || row.source === 'MOCK_PAYMENT')) {
    return { class: 'PAYMENT', targetSource: 'PAYMENT' };
  }
  if (
    row.source === 'COMPLIMENTARY' ||
    row.source === 'BETA_OVERRIDE' ||
    /beta/i.test(row.complimentaryReason || '') ||
    /beta/i.test(row.overrideSource || '')
  ) {
    return { class: 'BETA_OVERRIDE', targetSource: 'BETA_OVERRIDE' };
  }
  if (row.source === 'MANUAL_ADMIN' || row.source === 'ADMIN_OVERRIDE') {
    return { class: 'BETA_OVERRIDE', targetSource: 'ADMIN_OVERRIDE', note: 'admin/manual mapped for review' };
  }
  if (row.planCode !== 'free' && !row.latestPaymentId) {
    return {
      class: 'AMBIGUOUS',
      targetSource: row.source,
      note: 'paid-looking plan without payment reference',
    };
  }
  return { class: 'AMBIGUOUS', targetSource: row.source, note: 'unclassified' };
}
