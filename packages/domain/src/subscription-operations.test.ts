import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeAdminAuditMetadata } from './admin-user-management.js';
import {
  addCalendarMonths,
  decideActivate,
  decideComplimentary,
  decideImmediateCancel,
  decidePlanChange,
  decideResume,
  decideScheduleCancellation,
  decideStartTrial,
  formatInTimeZone,
  freeFallback,
  isRevenueGenerating,
  lifecycleLeavesWorkspaceStatus,
  nextLifecyclePatch,
  notificationIntents,
  resolveWorkspaceEntitlements,
  type LifecycleState,
} from './subscription-operations.js';

const free = { id: 'plan_free', code: 'free' };
const now = new Date('2026-09-28T02:00:00.000Z');

function state(overrides: Partial<LifecycleState> = {}): LifecycleState {
  return {
    id: 'sub',
    workspaceId: 'ws',
    planId: 'plan_pro',
    planCode: 'pro',
    pendingPlanId: null,
    pendingPlanCode: null,
    fallbackPlanId: null,
    fallbackPlanCode: null,
    status: 'ACTIVE',
    source: 'MANUAL_ADMIN',
    currentPeriodStart: '2026-09-01T00:00:00.000Z',
    currentPeriodEnd: '2026-10-01T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    trialEndsAt: null,
    complimentaryUntil: null,
    manualAutoExtension: false,
    timeZone: 'Asia/Shanghai',
    workspaceStatus: 'ACTIVE',
    ...overrides,
  };
}

test('default free fallback and revenue classification', () => {
  assert.deepEqual(freeFallback({ status: 'CANCELED', source: 'MANUAL_ADMIN', planCode: 'pro' }), { planCode: 'free', source: 'DEFAULT_FREE' });
  assert.equal(isRevenueGenerating('PAYMENT_PROVIDER'), true);
  assert.equal(isRevenueGenerating('MANUAL_ADMIN'), false);
  assert.equal(isRevenueGenerating('TRIAL'), false);
  assert.equal(isRevenueGenerating('COMPLIMENTARY'), false);
  assert.equal(isRevenueGenerating('DEFAULT_FREE'), false);
});

test('trial can start once, admin can regrant, and expiry returns to free', () => {
  const started = decideStartTrial({ trialDays: 14, trialConsumedAt: null, now, planCode: 'pro' });
  assert.equal(started.ok, true);
  const again = decideStartTrial({ trialDays: 14, trialConsumedAt: now.toISOString(), now, planCode: 'pro' });
  assert.equal(again.ok, false);
  const regrant = decideStartTrial({ trialDays: 7, trialConsumedAt: now.toISOString(), adminRegrant: true, reason: 'Alpha tester', now, planCode: 'pro' });
  assert.equal(regrant.ok, true);
  const ended = nextLifecyclePatch(state({ status: 'TRIALING', source: 'TRIAL', trialEndsAt: '2026-09-28T00:00:00.000Z', workspaceStatus: 'SUSPENDED' }), now, free);
  assert.equal(ended?.eventType, 'TRIAL_ENDED');
  assert.equal(ended?.next.planCode, 'free');
  assert.equal(ended?.next.source, 'DEFAULT_FREE');
  assert.equal(ended?.keepsRunningServices, true);
  assert.equal(lifecycleLeavesWorkspaceStatus(state({ workspaceStatus: 'SUSPENDED' }), ended!.next), true);
});

test('manual activation, immediate upgrade, and scheduled downgrade', () => {
  const activated = decideActivate({ actorIsAdmin: true, now, timeZone: 'Asia/Shanghai' });
  assert.equal(activated.ok, true);
  if (activated.ok) {
    assert.equal(activated.value.activationSource, 'MANUAL_ADMIN');
    assert.equal(activated.value.manualAutoExtension, false);
    assert.equal(decideActivate({ actorIsAdmin: false, now, timeZone: 'Asia/Shanghai' }).ok, false);
  }
  const upgrade = decidePlanChange({ fromCode: 'free', toCode: 'pro', fromPlanId: 'plan_free', toPlanId: 'plan_pro', currentPeriodEnd: '2026-10-01T00:00:00.000Z' });
  assert.equal(upgrade.ok && upgrade.value.mode, 'immediate');
  const downgrade = decidePlanChange({
    fromCode: 'team',
    toCode: 'pro',
    fromPlanId: 'plan_team',
    toPlanId: 'plan_pro',
    currentPeriodEnd: '2026-10-28T00:00:00.000Z',
    usage: { projects: 30 },
    targetLimits: { projects: 20 },
  });
  assert.equal(downgrade.ok && downgrade.value.mode, 'scheduled');
  if (downgrade.ok) assert.match(downgrade.value.warning ?? '', /超过套餐额度/);
});

test('cancel, resume, immediate cancel, and complimentary access', () => {
  const scheduled = decideScheduleCancellation({ planCode: 'pro', currentPeriodEnd: '2026-10-28T00:00:00.000Z' });
  assert.equal(scheduled.ok, true);
  const resumed = decideResume({ status: 'CANCEL_AT_PERIOD_END', currentPeriodEnd: '2026-10-28T00:00:00.000Z', now });
  assert.equal(resumed.ok && resumed.value.status, 'ACTIVE');
  const immediate = decideImmediateCancel({ actorIsAdmin: true, confirmation: '立即取消', reason: '风控' });
  assert.equal(immediate.ok && immediate.value.keepsRunningServices, true);
  assert.equal(decideImmediateCancel({ actorIsAdmin: false, confirmation: '立即取消', reason: '风控' }).ok, false);
  const gift = decideComplimentary({ actorIsAdmin: true, days: 30, reason: 'Partner account', now, planCode: 'team' });
  assert.equal(gift.ok && gift.value.source, 'COMPLIMENTARY');
  const expired = nextLifecyclePatch(state({
    source: 'COMPLIMENTARY',
    complimentaryUntil: '2026-09-28T00:00:00.000Z',
    fallbackPlanId: free.id,
    fallbackPlanCode: 'free',
    currentPeriodEnd: '2026-11-01T00:00:00.000Z',
  }), now, free);
  assert.equal(expired?.next.planCode, 'free');
  assert.equal(expired?.next.source, 'DEFAULT_FREE');
});

test('period rollover is idempotent by key and does not rewrite workspace status', () => {
  const first = nextLifecyclePatch(state({ currentPeriodEnd: '2026-09-28T00:00:00.000Z' }), now, free);
  const second = nextLifecyclePatch(state({ currentPeriodEnd: '2026-09-28T00:00:00.000Z' }), now, free);
  assert.equal(first?.eventType, 'SUBSCRIPTION_EXPIRED');
  assert.equal(first?.idempotencyKey, second?.idempotencyKey);
  const downgraded = nextLifecyclePatch(state({
    currentPeriodEnd: '2026-09-28T00:00:00.000Z',
    planId: 'plan_team',
    pendingPlanId: 'plan_pro',
    pendingPlanCode: 'pro',
    planCode: 'team',
    manualAutoExtension: true,
  }), now, free);
  assert.equal(downgraded?.eventType, 'SUBSCRIPTION_DOWNGRADED');
  assert.equal(downgraded?.next.planCode, 'pro');
  assert.equal(downgraded?.fromPlanId, 'plan_team');
});

test('entitlements, notifications, timezone display, and secret safety', () => {
  const rights = resolveWorkspaceEntitlements({
    status: 'CANCELED',
    source: 'DEFAULT_FREE',
    features: { customDomain: true },
    limits: { maxProjects: 20 },
    freeFeatures: { customDomain: false },
    freeLimits: { maxProjects: 5 },
  });
  assert.equal(rights.features.customDomain, false);
  assert.equal(rights.limits.maxProjects, 5);
  const intents = notificationIntents({
    now,
    trialEndsAt: '2026-09-30T00:00:00.000Z',
    status: 'TRIALING',
    currentPeriodEnd: '2026-10-01T00:00:00.000Z',
    pendingPlanCode: 'free',
    quotaNear: true,
  });
  assert.ok(intents.some((item) => item.type === 'TRIAL_ENDING_3_DAYS'));
  assert.ok(intents.some((item) => item.type === 'PLAN_DOWNGRADE_PENDING'));
  assert.ok(intents.some((item) => item.type === 'QUOTA_NEAR_LIMIT'));
  const shown = formatInTimeZone(new Date('2026-10-12T02:00:00.000Z'), 'Asia/Shanghai');
  assert.match(shown, /2026-10-12/);
  const month = addCalendarMonths(new Date('2026-09-28T16:00:00.000Z'), 1, 'Asia/Shanghai');
  assert.match(formatInTimeZone(month, 'Asia/Shanghai'), /2026-10-29/);
  const safe = sanitizeAdminAuditMetadata({ reason: 'Customer support', password: 'x', token: 'y' });
  assert.equal(safe.password, undefined);
  assert.equal(safe.reason, 'Customer support');
});
