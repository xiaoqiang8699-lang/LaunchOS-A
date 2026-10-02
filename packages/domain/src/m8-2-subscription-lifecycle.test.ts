import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculatePeriodEnd, addCalendarYears, renewalDue, gracePeriodEndFrom } from './billing-period.js';
import { decideSubscriptionActivation, shouldSkipSubscriptionActivation, entitlementPriority } from './subscription-activation.js';
import { evaluateSubscriptionCompliance, overQuotaBlocksCreate, SAFE_DOWNGRADE_GUARANTEES } from './subscription-compliance.js';
import { detectSubscriptionDrift, classifySubscriptionForBackfill } from './subscription-reconciliation.js';
import {
  nextLifecyclePatch,
  decideScheduleCancellation,
  decideResume,
  addCalendarMonths,
} from './subscription-operations.js';
import { fakeClock, normalizeSubscriptionSource, parseBillingCycle } from './subscription-lifecycle.js';

const TZ = 'Asia/Shanghai';

describe('billing period calendar math', () => {
  it('MONTHLY uses calendar month not 30 days', () => {
    const start = new Date('2026-01-31T16:00:00.000Z');
    const end = calculatePeriodEnd(start, 'MONTHLY', TZ);
    const viaMonths = addCalendarMonths(start, 1, TZ);
    assert.equal(end.toISOString(), viaMonths.toISOString());
  });

  it('YEARLY uses calendar year and leap day', () => {
    const leap = new Date('2024-02-29T16:00:00.000Z');
    const end = calculatePeriodEnd(leap, 'YEARLY', TZ);
    const viaYears = addCalendarYears(leap, 1, TZ);
    assert.equal(end.toISOString(), viaYears.toISOString());
    const localHint = end.toISOString();
    assert.ok(localHint.includes('2025-02-28') || localHint.includes('2025-02-27'));
  });

  it('NONE returns same instant', () => {
    const start = new Date('2026-10-02T00:00:00.000Z');
    assert.equal(calculatePeriodEnd(start, 'NONE', TZ).toISOString(), start.toISOString());
  });

  it('renewalDue window 7 days', () => {
    const end = new Date('2026-11-10T00:00:00.000Z');
    assert.equal(renewalDue({ currentPeriodEnd: end, now: new Date('2026-11-04T00:00:00.000Z') }), true);
    assert.equal(renewalDue({ currentPeriodEnd: end, now: new Date('2026-10-01T00:00:00.000Z') }), false);
  });

  it('gracePeriodEnd adds calendar days', () => {
    const periodEnd = new Date('2026-11-02T16:00:00.000Z');
    const grace = gracePeriodEndFrom(periodEnd, 3, TZ);
    assert.ok(grace.getTime() > periodEnd.getTime());
  });
});

describe('subscription activation', () => {
  it('skips PAYMENT_TEST', () => {
    assert.equal(
      shouldSkipSubscriptionActivation({
        paymentId: 'p1',
        workspaceId: 'w1',
        planId: 'plan',
        planVersionId: null,
        planCode: 'PAYMENT_TEST',
        billingCycle: 'MONTHLY',
        amountCents: 90,
        paidAt: new Date(),
        isProductionTest: true,
      }),
      true,
    );
  });

  it('activates Free→Pro monthly idempotently', () => {
    const paidAt = new Date('2026-10-02T08:00:00.000Z');
    const base = {
      payment: {
        paymentId: 'pay_1',
        workspaceId: 'ws',
        planId: 'plan_pro',
        planVersionId: 'pv1',
        planCode: 'pro',
        billingCycle: 'MONTHLY',
        amountCents: 9900,
        paidAt,
        businessType: 'SUBSCRIPTION_PURCHASE',
      },
      existing: {
        id: 'sub1',
        status: 'ACTIVE',
        source: 'DEFAULT_FREE',
        planId: 'plan_free',
        currentPeriodEnd: paidAt,
        latestPaymentId: null as string | null,
      },
      timeZone: TZ,
    };
    const first = decideSubscriptionActivation(base);
    assert.equal(first.ok && first.action, 'ACTIVATED');
    const second = decideSubscriptionActivation({
      ...base,
      existing: { ...base.existing, latestPaymentId: 'pay_1' },
    });
    assert.equal(second.ok && second.action, 'ALREADY_APPLIED');
  });

  it('entitlement priority prefers PAYMENT over BETA', () => {
    assert.equal(
      entitlementPriority({ adminOverrideActive: false, paymentSubscriptionActive: true, betaOverrideActive: true }),
      'PAYMENT',
    );
  });
});

describe('lifecycle grace and cancel', () => {
  const free = { id: 'free_id', code: 'free' };
  const baseState = {
    id: 'sub1',
    workspaceId: 'ws',
    planId: 'pro_id',
    planCode: 'pro',
    pendingPlanId: null as string | null,
    pendingPlanCode: null as string | null,
    fallbackPlanId: null as string | null,
    fallbackPlanCode: null as string | null,
    status: 'ACTIVE',
    source: 'PAYMENT',
    currentPeriodStart: '2026-09-02T16:00:00.000Z',
    currentPeriodEnd: '2026-10-02T16:00:00.000Z',
    cancelAtPeriodEnd: false,
    trialEndsAt: null as string | null,
    complimentaryUntil: null as string | null,
    manualAutoExtension: false,
    timeZone: TZ,
    workspaceStatus: 'ACTIVE',
    gracePeriodEnd: null as string | null,
    billingCycle: 'MONTHLY',
  };

  it('period end enters GRACE_PERIOD', () => {
    const clock = fakeClock(new Date('2026-10-02T16:00:01.000Z'));
    const patch = nextLifecyclePatch(baseState, clock.now(), free, { gracePeriodDays: 3 });
    assert.ok(patch);
    assert.equal(patch!.eventType, 'SUBSCRIPTION_GRACE_STARTED');
    assert.equal(patch!.next.status, 'GRACE_PERIOD');
    assert.ok(patch!.next.gracePeriodEnd);
  });

  it('grace end expires to free', () => {
    const graceEnd = '2026-10-05T16:00:00.000Z';
    const patch = nextLifecyclePatch(
      { ...baseState, status: 'GRACE_PERIOD', gracePeriodEnd: graceEnd },
      new Date('2026-10-05T16:00:01.000Z'),
      free,
    );
    assert.ok(patch);
    assert.equal(patch!.eventType, 'SUBSCRIPTION_EXPIRED');
    assert.equal(patch!.next.status, 'EXPIRED');
    assert.equal(patch!.next.planCode, 'free');
  });

  it('cancel then resume', () => {
    const cancel = decideScheduleCancellation({ planCode: 'pro', currentPeriodEnd: baseState.currentPeriodEnd });
    assert.equal(cancel.ok && cancel.value.status, 'CANCEL_AT_PERIOD_END');
    const resume = decideResume({
      status: 'CANCEL_AT_PERIOD_END',
      currentPeriodEnd: '2026-11-02T00:00:00.000Z',
      now: new Date('2026-10-10T00:00:00.000Z'),
    });
    assert.equal(resume.ok && resume.value.status, 'ACTIVE');
  });
});

describe('compliance safe downgrade', () => {
  it('marks OVER_QUOTA without delete guarantees', () => {
    const r = evaluateSubscriptionCompliance({
      usage: { projects: 3, members: 5, runningApps: 3 },
      limits: { maxProjects: 1, maxMembers: 1, maxRunningApps: 1 },
    });
    assert.equal(r.status, 'OVER_QUOTA');
    assert.equal(overQuotaBlocksCreate({ status: r.status, dimensions: r.dimensions, action: 'CREATE_PROJECT' }), true);
    assert.equal(SAFE_DOWNGRADE_GUARANTEES.projects, 'NO_DELETE');
    assert.equal(SAFE_DOWNGRADE_GUARANTEES.members, 'NO_REMOVE');
    assert.equal(SAFE_DOWNGRADE_GUARANTEES.runningApps, 'NO_AUTO_STOP');
  });
});

describe('reconciliation and backfill', () => {
  it('detects payment without activation', () => {
    const findings = detectSubscriptionDrift({
      now: new Date(),
      payments: [
        {
          id: 'p1',
          workspaceId: 'w1',
          status: 'SUCCEEDED',
          planCode: 'pro',
          activatedOnSubscription: false,
        },
      ],
      subscriptions: [],
    });
    assert.ok(findings.some((f) => f.code === 'PAYMENT_SUCCEEDED_SUBSCRIPTION_NOT_ACTIVATED'));
  });

  it('PAYMENT_TEST backfill stays FREE', () => {
    const c = classifySubscriptionForBackfill({
      planCode: 'free',
      source: 'DEFAULT_FREE',
      status: 'ACTIVE',
      isProductionTestPaymentOnly: true,
    });
    assert.equal(c.class, 'FREE');
  });

  it('normalizes sources and billing cycle', () => {
    assert.equal(normalizeSubscriptionSource('PAYMENT_PROVIDER'), 'PAYMENT');
    assert.equal(normalizeSubscriptionSource('DEFAULT_FREE'), 'FREE_DEFAULT');
    assert.equal(parseBillingCycle('yearly'), 'YEARLY');
  });
});
