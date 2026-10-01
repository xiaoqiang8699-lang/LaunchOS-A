export const TRIAL_DAY_OPTIONS = [7, 14, 30] as const;
export const SUBSCRIPTION_SOURCES = ['DEFAULT_FREE', 'TRIAL', 'MANUAL_ADMIN', 'COMPLIMENTARY', 'PAYMENT_PROVIDER'] as const;
export const DEFAULT_BUSINESS_TIMEZONE = 'Asia/Shanghai';
export const IMMEDIATE_CANCEL_CONFIRMATION = '立即取消';

export const LIFECYCLE_EVENT_TYPES = [
  'TRIAL_STARTED',
  'TRIAL_ENDED',
  'SUBSCRIPTION_ACTIVATED',
  'SUBSCRIPTION_UPGRADED',
  'SUBSCRIPTION_DOWNGRADE_SCHEDULED',
  'SUBSCRIPTION_DOWNGRADED',
  'SUBSCRIPTION_CANCEL_SCHEDULED',
  'SUBSCRIPTION_RESUMED',
  'SUBSCRIPTION_CANCELED',
  'COMPLIMENTARY_GRANTED',
  'SUBSCRIPTION_EXPIRED',
] as const;

export const NOTIFICATION_INTENT_TYPES = [
  'TRIAL_ENDING_3_DAYS',
  'TRIAL_ENDED',
  'SUBSCRIPTION_ENDING',
  'PLAN_DOWNGRADE_PENDING',
  'QUOTA_NEAR_LIMIT',
] as const;

const PLAN_RANK: Record<string, number> = { free: 0, pro: 1, team: 2, enterprise: 3 };

export type LifecycleState = {
  id: string;
  workspaceId: string;
  planId: string;
  planCode: string;
  pendingPlanId: string | null;
  pendingPlanCode: string | null;
  fallbackPlanId: string | null;
  fallbackPlanCode: string | null;
  status: string;
  source: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  trialEndsAt: string | null;
  complimentaryUntil: string | null;
  manualAutoExtension: boolean;
  timeZone: string;
  workspaceStatus: string;
};

export type LifecyclePatch = {
  idempotencyKey: string;
  eventType: (typeof LIFECYCLE_EVENT_TYPES)[number] | 'PERIOD_ROLLED';
  fromPlanId: string;
  toPlanId: string;
  effectiveAt: string;
  source: string;
  keepsRunningServices: true;
  next: LifecycleState;
};

type Decision<T> = { ok: true; value: T } | { ok: false; message: string };

function fail(message: string): Decision<never> {
  return { ok: false, message };
}

export function isRevenueGenerating(source: string): boolean {
  return source === 'PAYMENT_PROVIDER';
}

export function planChangeDirection(fromCode: string, toCode: string): 'upgrade' | 'downgrade' | 'same' {
  const from = PLAN_RANK[fromCode] ?? 0;
  const to = PLAN_RANK[toCode] ?? 0;
  if (to > from) return 'upgrade';
  if (to < from) return 'downgrade';
  return 'same';
}

export function zonedParts(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0');
  return { year: read('year'), month: read('month'), day: read('day'), hour: read('hour'), minute: read('minute'), second: read('second') };
}

export function zonedDateTimeToUtc(
  parts: { year: number; month: number; day: number; hour: number; minute: number; second: number },
  timeZone: string,
): Date {
  const desired = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let guess = desired;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const local = zonedParts(new Date(guess), timeZone);
    const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    const delta = desired - localAsUtc;
    if (delta === 0) break;
    guess += delta;
  }
  return new Date(guess);
}

export function addCalendarMonths(instant: Date, months: number, timeZone: string): Date {
  const local = zonedParts(instant, timeZone);
  const index = local.month - 1 + months;
  const year = local.year + Math.floor(index / 12);
  const month = ((index % 12) + 12) % 12 + 1;
  const day = Math.min(local.day, new Date(Date.UTC(year, month, 0)).getUTCDate());
  return zonedDateTimeToUtc({ ...local, year, month, day }, timeZone);
}

export function formatInTimeZone(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(instant).replace(' ', ' ');
}

export function requireReason(reason: string | null | undefined): Decision<string> {
  const text = reason?.trim() ?? '';
  if (!text) return fail('请填写原因');
  return { ok: true, value: text };
}

export function decideStartTrial(input: {
  trialDays: number;
  allowedDays?: readonly number[];
  trialConsumedAt: string | null;
  adminRegrant?: boolean;
  reason?: string;
  now: Date;
  planCode: string;
}): Decision<{ trialStartedAt: string; trialEndsAt: string; trialConsumedAt: string; status: 'TRIALING'; source: 'TRIAL' }> {
  const allowed = input.allowedDays ?? TRIAL_DAY_OPTIONS;
  if (!allowed.includes(input.trialDays)) return fail('试用天数不在允许范围内');
  if (input.planCode === 'free') return fail('免费套餐不能作为试用');
  if (input.trialConsumedAt && !input.adminRegrant) return fail('这个工作空间已经使用过试用');
  if (input.adminRegrant) {
    const reason = requireReason(input.reason);
    if (!reason.ok) return reason;
  }
  const trialEndsAt = new Date(input.now.getTime() + input.trialDays * 24 * 60 * 60 * 1000);
  return {
    ok: true,
    value: {
      trialStartedAt: input.now.toISOString(),
      trialEndsAt: trialEndsAt.toISOString(),
      trialConsumedAt: input.now.toISOString(),
      status: 'TRIALING',
      source: 'TRIAL',
    },
  };
}

export function decideActivate(input: { actorIsAdmin: boolean; now: Date; timeZone: string }): Decision<{
  status: 'ACTIVE';
  source: 'MANUAL_ADMIN';
  activationSource: 'MANUAL_ADMIN';
  currentPeriodStart: string;
  currentPeriodEnd: string;
  manualAutoExtension: false;
}> {
  if (!input.actorIsAdmin) return fail('当前只能由平台管理员开通');
  const end = addCalendarMonths(input.now, 1, input.timeZone);
  return {
    ok: true,
    value: {
      status: 'ACTIVE',
      source: 'MANUAL_ADMIN',
      activationSource: 'MANUAL_ADMIN',
      currentPeriodStart: input.now.toISOString(),
      currentPeriodEnd: end.toISOString(),
      manualAutoExtension: false,
    },
  };
}

export function decidePlanChange(input: {
  fromCode: string;
  toCode: string;
  fromPlanId: string;
  toPlanId: string;
  currentPeriodEnd: string;
  usage?: Record<string, number>;
  targetLimits?: Record<string, number | null>;
}): Decision<{
  mode: 'immediate' | 'scheduled';
  pendingPlanId: string | null;
  planChangeEffectiveAt: string | null;
  eventType: 'SUBSCRIPTION_UPGRADED' | 'SUBSCRIPTION_DOWNGRADE_SCHEDULED';
  warning: string | null;
}> {
  const direction = planChangeDirection(input.fromCode, input.toCode);
  if (direction === 'same') return fail('套餐没有变化');
  if (direction === 'upgrade') {
    return {
      ok: true,
      value: {
        mode: 'immediate',
        pendingPlanId: null,
        planChangeEffectiveAt: null,
        eventType: 'SUBSCRIPTION_UPGRADED',
        warning: null,
      },
    };
  }
  let warning: string | null = null;
  if (input.usage && input.targetLimits) {
    const over = Object.keys(input.usage).some((key) => {
      const limit = input.targetLimits?.[key];
      return limit != null && (input.usage?.[key] ?? 0) > limit;
    });
    if (over) warning = '降级后当前用量将超过套餐额度。';
  }
  return {
    ok: true,
    value: {
      mode: 'scheduled',
      pendingPlanId: input.toPlanId,
      planChangeEffectiveAt: input.currentPeriodEnd,
      eventType: 'SUBSCRIPTION_DOWNGRADE_SCHEDULED',
      warning,
    },
  };
}

export function decideScheduleCancellation(input: { planCode: string; currentPeriodEnd: string }): Decision<{
  status: 'CANCEL_AT_PERIOD_END';
  cancelAtPeriodEnd: true;
}> {
  if (input.planCode === 'free') return fail('免费套餐不需要取消');
  return { ok: true, value: { status: 'CANCEL_AT_PERIOD_END', cancelAtPeriodEnd: true } };
}

export function decideResume(input: { status: string; currentPeriodEnd: string; now: Date }): Decision<{ status: 'ACTIVE'; cancelAtPeriodEnd: false }> {
  if (input.status !== 'CANCEL_AT_PERIOD_END') return fail('当前订阅没有待生效的取消');
  if (input.now.getTime() >= new Date(input.currentPeriodEnd).getTime()) return fail('当前周期已经结束');
  return { ok: true, value: { status: 'ACTIVE', cancelAtPeriodEnd: false } };
}

export function decideImmediateCancel(input: { actorIsAdmin: boolean; confirmation: string; reason?: string }): Decision<{
  status: 'CANCELED';
  source: 'DEFAULT_FREE';
  cancelAtPeriodEnd: false;
  keepsRunningServices: true;
}> {
  if (!input.actorIsAdmin) return fail('只有平台管理员可以立即取消');
  if (input.confirmation !== IMMEDIATE_CANCEL_CONFIRMATION) return fail('请确认立即取消');
  const reason = requireReason(input.reason);
  if (!reason.ok) return reason;
  return { ok: true, value: { status: 'CANCELED', source: 'DEFAULT_FREE', cancelAtPeriodEnd: false, keepsRunningServices: true } };
}

export function decideComplimentary(input: {
  actorIsAdmin: boolean;
  days: number;
  reason?: string;
  now: Date;
  planCode: string;
}): Decision<{ source: 'COMPLIMENTARY'; status: 'ACTIVE'; complimentaryUntil: string }> {
  if (!input.actorIsAdmin) return fail('只有平台管理员可以赠送');
  const reason = requireReason(input.reason);
  if (!reason.ok) return reason;
  if (input.planCode === 'free' || input.days <= 0) return fail('赠送套餐无效');
  return {
    ok: true,
    value: {
      source: 'COMPLIMENTARY',
      status: 'ACTIVE',
      complimentaryUntil: new Date(input.now.getTime() + input.days * 24 * 60 * 60 * 1000).toISOString(),
    },
  };
}

export function freeFallback(input: { status: string; source: string; planCode: string }): { planCode: 'free'; source: 'DEFAULT_FREE' } | null {
  if (input.planCode === 'free' && input.source === 'DEFAULT_FREE') return { planCode: 'free', source: 'DEFAULT_FREE' };
  if (input.status === 'CANCELED' || input.status === 'EXPIRED' || input.source === 'DEFAULT_FREE') {
    return { planCode: 'free', source: 'DEFAULT_FREE' };
  }
  return null;
}

export function nextLifecyclePatch(state: LifecycleState, now: Date, freePlan: { id: string; code: string }): LifecyclePatch | null {
  if (state.status === 'TRIALING' && state.trialEndsAt && now.getTime() >= new Date(state.trialEndsAt).getTime()) {
    return patch(state, {
      idempotencyKey: `${state.id}:TRIAL_ENDED:${state.trialEndsAt}`,
      eventType: 'TRIAL_ENDED',
      toPlanId: freePlan.id,
      effectiveAt: state.trialEndsAt,
      source: 'DEFAULT_FREE',
      next: {
        ...state,
        planId: freePlan.id,
        planCode: freePlan.code,
        status: 'ACTIVE',
        source: 'DEFAULT_FREE',
        trialEndsAt: null,
        cancelAtPeriodEnd: false,
      },
    });
  }
  if (state.source === 'COMPLIMENTARY' && state.complimentaryUntil && now.getTime() >= new Date(state.complimentaryUntil).getTime()) {
    const toPlanId = state.fallbackPlanId ?? freePlan.id;
    const toCode = state.fallbackPlanCode ?? freePlan.code;
    return patch(state, {
      idempotencyKey: `${state.id}:SUBSCRIPTION_EXPIRED:${state.complimentaryUntil}`,
      eventType: 'SUBSCRIPTION_EXPIRED',
      toPlanId,
      effectiveAt: state.complimentaryUntil,
      source: toCode === 'free' ? 'DEFAULT_FREE' : 'MANUAL_ADMIN',
      next: {
        ...state,
        planId: toPlanId,
        planCode: toCode,
        source: toCode === 'free' ? 'DEFAULT_FREE' : 'MANUAL_ADMIN',
        status: 'ACTIVE',
        complimentaryUntil: null,
        fallbackPlanId: null,
        fallbackPlanCode: null,
      },
    });
  }
  if (now.getTime() < new Date(state.currentPeriodEnd).getTime()) return null;
  if (state.pendingPlanId && state.pendingPlanCode) {
    const end = addCalendarMonths(new Date(state.currentPeriodEnd), 1, state.timeZone).toISOString();
    return patch(state, {
      idempotencyKey: `${state.id}:SUBSCRIPTION_DOWNGRADED:${state.currentPeriodEnd}`,
      eventType: 'SUBSCRIPTION_DOWNGRADED',
      toPlanId: state.pendingPlanId,
      effectiveAt: state.currentPeriodEnd,
      source: state.source,
      next: {
        ...state,
        planId: state.pendingPlanId,
        planCode: state.pendingPlanCode,
        pendingPlanId: null,
        pendingPlanCode: null,
        currentPeriodStart: state.currentPeriodEnd,
        currentPeriodEnd: end,
      },
    });
  }
  if (state.cancelAtPeriodEnd || state.status === 'CANCEL_AT_PERIOD_END') {
    return patch(state, {
      idempotencyKey: `${state.id}:SUBSCRIPTION_CANCELED:${state.currentPeriodEnd}`,
      eventType: 'SUBSCRIPTION_CANCELED',
      toPlanId: freePlan.id,
      effectiveAt: state.currentPeriodEnd,
      source: 'DEFAULT_FREE',
      next: {
        ...state,
        planId: freePlan.id,
        planCode: freePlan.code,
        status: 'CANCELED',
        source: 'DEFAULT_FREE',
        cancelAtPeriodEnd: false,
      },
    });
  }
  if ((state.source === 'MANUAL_ADMIN' || state.source === 'PAYMENT_PROVIDER') && !state.manualAutoExtension && state.planCode !== 'free') {
    return patch(state, {
      idempotencyKey: `${state.id}:SUBSCRIPTION_EXPIRED:${state.currentPeriodEnd}`,
      eventType: 'SUBSCRIPTION_EXPIRED',
      toPlanId: freePlan.id,
      effectiveAt: state.currentPeriodEnd,
      source: 'DEFAULT_FREE',
      next: {
        ...state,
        planId: freePlan.id,
        planCode: freePlan.code,
        status: 'EXPIRED',
        source: 'DEFAULT_FREE',
      },
    });
  }
  if (state.manualAutoExtension && state.planCode !== 'free') {
    const end = addCalendarMonths(new Date(state.currentPeriodEnd), 1, state.timeZone).toISOString();
    return patch(state, {
      idempotencyKey: `${state.id}:PERIOD_ROLLED:${state.currentPeriodEnd}`,
      eventType: 'PERIOD_ROLLED',
      toPlanId: state.planId,
      effectiveAt: state.currentPeriodEnd,
      source: state.source,
      next: { ...state, currentPeriodStart: state.currentPeriodEnd, currentPeriodEnd: end },
    });
  }
  return null;
}

function patch(state: LifecycleState, input: Omit<LifecyclePatch, 'fromPlanId' | 'keepsRunningServices'>): LifecyclePatch {
  return { ...input, fromPlanId: state.planId, keepsRunningServices: true, next: { ...input.next, workspaceStatus: state.workspaceStatus } };
}

export function resolveWorkspaceEntitlements(input: {
  status: string;
  source: string;
  features: Record<string, boolean | number | string>;
  limits: Record<string, number | null>;
  freeFeatures: Record<string, boolean | number | string>;
  freeLimits: Record<string, number | null>;
}): { features: Record<string, boolean | number | string>; limits: Record<string, number | null>; subscriptionStatus: string } {
  const fallen = input.status === 'CANCELED' || input.status === 'EXPIRED';
  return {
    features: fallen ? input.freeFeatures : input.features,
    limits: fallen ? input.freeLimits : input.limits,
    subscriptionStatus: input.status,
  };
}

export function notificationIntents(input: {
  now: Date;
  trialEndsAt: string | null;
  status: string;
  currentPeriodEnd: string;
  pendingPlanCode: string | null;
  quotaNear: boolean;
}): Array<{ type: (typeof NOTIFICATION_INTENT_TYPES)[number]; periodKey: string }> {
  const intents: Array<{ type: (typeof NOTIFICATION_INTENT_TYPES)[number]; periodKey: string }> = [];
  if (input.trialEndsAt && input.status === 'TRIALING') {
    const remaining = new Date(input.trialEndsAt).getTime() - input.now.getTime();
    if (remaining <= 0) intents.push({ type: 'TRIAL_ENDED', periodKey: input.trialEndsAt });
    else if (remaining <= 3 * 24 * 60 * 60 * 1000) intents.push({ type: 'TRIAL_ENDING_3_DAYS', periodKey: input.trialEndsAt });
  }
  if (input.status === 'CANCEL_AT_PERIOD_END') intents.push({ type: 'SUBSCRIPTION_ENDING', periodKey: input.currentPeriodEnd });
  if (input.pendingPlanCode) intents.push({ type: 'PLAN_DOWNGRADE_PENDING', periodKey: input.currentPeriodEnd });
  if (input.quotaNear) intents.push({ type: 'QUOTA_NEAR_LIMIT', periodKey: input.currentPeriodEnd });
  return intents;
}

export function describeNextChange(input: {
  status: string;
  pendingPlanName: string | null;
  planChangeEffectiveAt: string | null;
  trialEndsAt: string | null;
  timeZone: string;
}): string | null {
  if (input.status === 'TRIALING' && input.trialEndsAt) {
    return `试用截止：${formatInTimeZone(new Date(input.trialEndsAt), input.timeZone)}`;
  }
  if (input.pendingPlanName && input.planChangeEffectiveAt) {
    return `已预约降级到 ${input.pendingPlanName}，${formatInTimeZone(new Date(input.planChangeEffectiveAt), input.timeZone)} 生效`;
  }
  if (input.status === 'CANCEL_AT_PERIOD_END' && input.planChangeEffectiveAt) {
    return `已预约取消，${formatInTimeZone(new Date(input.planChangeEffectiveAt), input.timeZone)} 后回到免费套餐`;
  }
  return null;
}

export function lifecycleLeavesWorkspaceStatus(before: { workspaceStatus: string }, after: { workspaceStatus: string }): boolean {
  return before.workspaceStatus === after.workspaceStatus;
}
