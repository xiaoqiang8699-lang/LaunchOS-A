/**
 * Beta M6 — Plan Entitlement & Quota Enforcement (pure helpers).
 * Prices stay on PlanVersion; entitlements resolve from pinned PlanVersion + optional admin override.
 */

import { quotaMetric, type QuotaMetric } from './subscription-usage';

export const ENTITLEMENT_LIMIT_KEYS = [
  'maxProjects',
  'maxMonthlyDeployments',
  'maxWorkspaceMembers',
  'maxRetainedVersions',
  'logRetentionDays',
  'maxRunningApps',
] as const;

export const ENTITLEMENT_FEATURE_KEYS = [
  'customDomainEnabled',
  'rollbackEnabled',
  'runtimeConfigEnabled',
] as const;

export type EntitlementSet = {
  maxProjects: number | null;
  maxMonthlyDeployments: number | null;
  maxWorkspaceMembers: number | null;
  maxRetainedVersions: number | null;
  logRetentionDays: number | null;
  customDomainEnabled: boolean;
  rollbackEnabled: boolean;
  runtimeConfigEnabled: boolean;
  maxRunningApps: number | null;
};

export type EntitlementUsage = {
  projects: number;
  monthlyDeployments: number;
  members: number;
  retainedVersions: number;
  runningApps: number;
};

export type EffectiveEntitlements = {
  planCode: string;
  planName: string;
  planVersionId: string | null;
  planVersionNumber: number | null;
  grandfathered: boolean;
  subscriptionStatus: string | null;
  source: 'DEFAULT_FREE' | 'SUBSCRIPTION' | 'ADMIN_OVERRIDE' | 'BETA_TESTER_OVERRIDE';
  entitlements: EntitlementSet;
  baseEntitlements: EntitlementSet;
  override: {
    id: string;
    reason: string;
    expiresAt: string | null;
    actorId: string | null;
  } | null;
  usage: EntitlementUsage;
  remaining: {
    projects: number | null;
    monthlyDeployments: number | null;
    members: number | null;
    runningApps: number | null;
  };
  quota: {
    projects: QuotaMetric;
    monthlyDeployments: QuotaMetric;
    members: QuotaMetric;
    runningApps: QuotaMetric;
    retainedVersions: QuotaMetric;
  };
  warnings: Array<{ code: string; message: string; metric: string }>;
};

export const QUOTA_ERROR_CODES = [
  'PROJECT_LIMIT_REACHED',
  'DEPLOYMENT_QUOTA_EXCEEDED',
  'MEMBER_LIMIT_REACHED',
  'RUNNING_APP_LIMIT_REACHED',
  'FEATURE_NOT_INCLUDED',
  'VERSION_RETENTION_LIMIT',
] as const;

export type QuotaErrorCode = (typeof QUOTA_ERROR_CODES)[number];

export const USAGE_LEDGER_EVENTS = [
  'DEPLOYMENT_STARTED',
  'PROJECT_CREATED',
  'MEMBER_ADDED',
  'ROLLBACK_STARTED',
  'QUOTA_RESERVED',
  'QUOTA_RELEASED',
  'QUOTA_BLOCKED',
  'OVERRIDE_CREATED',
  'OVERRIDE_CHANGED',
  'OVERRIDE_EXPIRED',
  'PLAN_CHANGED',
] as const;

export type UsageLedgerEvent = (typeof USAGE_LEDGER_EVENTS)[number];

export const ANALYTICS_EVENTS = [
  'quota_viewed',
  'quota_warning_shown',
  'quota_blocked',
  'upgrade_clicked',
] as const;

/** Official Beta M6 defaults — prices live elsewhere; do not encode prices here. */
export const BETA_PLAN_ENTITLEMENTS: Record<'free' | 'pro' | 'team', EntitlementSet> = {
  free: {
    maxProjects: 1,
    maxMonthlyDeployments: 10,
    maxWorkspaceMembers: 1,
    maxRetainedVersions: 3,
    logRetentionDays: 1,
    customDomainEnabled: false,
    rollbackEnabled: true,
    runtimeConfigEnabled: true,
    maxRunningApps: 1,
  },
  pro: {
    maxProjects: 10,
    maxMonthlyDeployments: 100,
    maxWorkspaceMembers: 1,
    maxRetainedVersions: 20,
    logRetentionDays: 7,
    customDomainEnabled: true,
    rollbackEnabled: true,
    runtimeConfigEnabled: true,
    maxRunningApps: 5,
  },
  team: {
    maxProjects: 30,
    maxMonthlyDeployments: 500,
    maxWorkspaceMembers: 5,
    maxRetainedVersions: 100,
    logRetentionDays: 30,
    customDomainEnabled: true,
    rollbackEnabled: true,
    runtimeConfigEnabled: true,
    maxRunningApps: 15,
  },
};

/** Enterprise: custom / admin-configured — no hardcoded caps. */
export const ENTERPRISE_ENTITLEMENTS: EntitlementSet = {
  maxProjects: null,
  maxMonthlyDeployments: null,
  maxWorkspaceMembers: null,
  maxRetainedVersions: null,
  logRetentionDays: null,
  customDomainEnabled: true,
  rollbackEnabled: true,
  runtimeConfigEnabled: true,
  maxRunningApps: null,
};

export const BETA_TESTER_OVERRIDE_DEFAULTS: Partial<EntitlementSet> = {
  maxProjects: 3,
  maxMonthlyDeployments: 50,
  maxRunningApps: 3,
  maxRetainedVersions: 10,
  logRetentionDays: 7,
  customDomainEnabled: false,
};

export const INTERNAL_TEST_PLAN_CODES = ['PAYMENT_TEST'] as const;

export function isInternalTestPlan(code: string): boolean {
  return (INTERNAL_TEST_PLAN_CODES as readonly string[]).includes(code);
}

export function defaultEntitlementsForPlan(code: string): EntitlementSet {
  if (code === 'enterprise') return { ...ENTERPRISE_ENTITLEMENTS };
  if (code === 'pro') return { ...BETA_PLAN_ENTITLEMENTS.pro };
  if (code === 'team') return { ...BETA_PLAN_ENTITLEMENTS.team };
  return { ...BETA_PLAN_ENTITLEMENTS.free };
}

/** Map PlanVersion limitsJson/featuresJson (+ legacy Plan columns) → EntitlementSet. */
export function entitlementsFromPlanVersion(input: {
  planCode: string;
  limitsJson?: Record<string, unknown> | null;
  featuresJson?: Record<string, unknown> | null;
  legacy?: Partial<{
    maxProjects: number | null;
    maxMembers: number | null;
    maxDeploymentsPerMonth: number | null;
  }>;
}): EntitlementSet {
  const base = defaultEntitlementsForPlan(input.planCode);
  const limits = input.limitsJson ?? {};
  const features = input.featuresJson ?? {};
  const num = (v: unknown, fallback: number | null): number | null => {
    if (v === null) return null;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    return fallback;
  };
  const bool = (v: unknown, fallback: boolean): boolean => {
    if (typeof v === 'boolean') return v;
    return fallback;
  };

  return {
    maxProjects: num(
      limits.maxProjects ?? input.legacy?.maxProjects,
      base.maxProjects,
    ),
    maxMonthlyDeployments: num(
      limits.maxMonthlyDeployments ?? limits.maxDeploymentsPerMonth ?? input.legacy?.maxDeploymentsPerMonth,
      base.maxMonthlyDeployments,
    ),
    maxWorkspaceMembers: num(
      limits.maxWorkspaceMembers ?? limits.maxMembers ?? input.legacy?.maxMembers,
      base.maxWorkspaceMembers,
    ),
    maxRetainedVersions: num(limits.maxRetainedVersions, base.maxRetainedVersions),
    logRetentionDays: num(limits.logRetentionDays, base.logRetentionDays),
    customDomainEnabled: bool(
      features.customDomainEnabled ?? features.customDomain,
      base.customDomainEnabled,
    ),
    rollbackEnabled: bool(features.rollbackEnabled ?? features.rollback, base.rollbackEnabled),
    runtimeConfigEnabled: bool(
      features.runtimeConfigEnabled ?? features.runtimeConfig,
      base.runtimeConfigEnabled,
    ),
    maxRunningApps: num(limits.maxRunningApps, base.maxRunningApps),
  };
}

/** Serialize EntitlementSet into PlanVersion JSON (prices excluded). */
export function toPlanVersionJson(ent: EntitlementSet, planCode: string): {
  limitsJson: Record<string, number | null>;
  featuresJson: Record<string, boolean | string>;
} {
  const unlimited = planCode === 'enterprise';
  return {
    limitsJson: {
      maxProjects: ent.maxProjects,
      maxMembers: ent.maxWorkspaceMembers,
      maxWorkspaceMembers: ent.maxWorkspaceMembers,
      maxDeploymentsPerMonth: ent.maxMonthlyDeployments,
      maxMonthlyDeployments: ent.maxMonthlyDeployments,
      maxRetainedVersions: ent.maxRetainedVersions,
      logRetentionDays: ent.logRetentionDays,
      maxRunningApps: ent.maxRunningApps,
      maxBuildMinutesPerMonth: unlimited
        ? null
        : ent.maxMonthlyDeployments == null
          ? null
          : ent.maxMonthlyDeployments * 5,
      maxServers: unlimited ? null : ent.maxProjects,
      maxDatabases: unlimited ? null : planCode === 'free' ? 0 : Math.min(10, ent.maxProjects ?? 10),
      maxRedisInstances: unlimited ? null : planCode === 'free' ? 0 : Math.min(10, ent.maxProjects ?? 10),
    },
    featuresJson: {
      customDomain: ent.customDomainEnabled,
      customDomainEnabled: ent.customDomainEnabled,
      rollback: ent.rollbackEnabled,
      rollbackEnabled: ent.rollbackEnabled,
      runtimeConfig: ent.runtimeConfigEnabled,
      runtimeConfigEnabled: ent.runtimeConfigEnabled,
      supportLevel: planCode === 'enterprise' ? 'dedicated' : planCode === 'team' ? 'priority' : planCode === 'pro' ? 'standard' : 'community',
    },
  };
}

/** Override merges on top of base; null means “unlimited / use override explicit null”. */
export function mergeEntitlementOverride(
  base: EntitlementSet,
  override: Partial<EntitlementSet> | null | undefined,
): EntitlementSet {
  if (!override) return { ...base };
  return {
    maxProjects: override.maxProjects !== undefined ? override.maxProjects : base.maxProjects,
    maxMonthlyDeployments:
      override.maxMonthlyDeployments !== undefined
        ? override.maxMonthlyDeployments
        : base.maxMonthlyDeployments,
    maxWorkspaceMembers:
      override.maxWorkspaceMembers !== undefined
        ? override.maxWorkspaceMembers
        : base.maxWorkspaceMembers,
    maxRetainedVersions:
      override.maxRetainedVersions !== undefined
        ? override.maxRetainedVersions
        : base.maxRetainedVersions,
    logRetentionDays:
      override.logRetentionDays !== undefined ? override.logRetentionDays : base.logRetentionDays,
    customDomainEnabled:
      override.customDomainEnabled !== undefined
        ? override.customDomainEnabled
        : base.customDomainEnabled,
    rollbackEnabled:
      override.rollbackEnabled !== undefined ? override.rollbackEnabled : base.rollbackEnabled,
    runtimeConfigEnabled:
      override.runtimeConfigEnabled !== undefined
        ? override.runtimeConfigEnabled
        : base.runtimeConfigEnabled,
    maxRunningApps:
      override.maxRunningApps !== undefined ? override.maxRunningApps : base.maxRunningApps,
  };
}

export function isOverrideActive(input: {
  expiresAt?: string | Date | null;
  now?: Date;
}): boolean {
  if (!input.expiresAt) return true;
  return new Date(input.expiresAt).getTime() > (input.now ?? new Date()).getTime();
}

export function buildEffectiveEntitlements(input: {
  planCode: string;
  planName: string;
  planVersionId: string | null;
  planVersionNumber: number | null;
  grandfathered: boolean;
  subscriptionStatus: string | null;
  source: EffectiveEntitlements['source'];
  base: EntitlementSet;
  override?: {
    id: string;
    reason: string;
    expiresAt: string | null;
    actorId: string | null;
    entitlements: Partial<EntitlementSet>;
  } | null;
  usage: EntitlementUsage;
  now?: Date;
}): EffectiveEntitlements {
  const overrideLive =
    input.override && isOverrideActive({ expiresAt: input.override.expiresAt, now: input.now })
      ? input.override
      : null;
  const entitlements = mergeEntitlementOverride(input.base, overrideLive?.entitlements);
  const source: EffectiveEntitlements['source'] = overrideLive
    ? /beta/i.test(overrideLive.reason)
      ? 'BETA_TESTER_OVERRIDE'
      : 'ADMIN_OVERRIDE'
    : input.source;

  const projects = quotaMetric(input.usage.projects, entitlements.maxProjects);
  const monthlyDeployments = quotaMetric(
    input.usage.monthlyDeployments,
    entitlements.maxMonthlyDeployments,
  );
  const members = quotaMetric(input.usage.members, entitlements.maxWorkspaceMembers);
  const runningApps = quotaMetric(input.usage.runningApps, entitlements.maxRunningApps);
  const retainedVersions = quotaMetric(
    input.usage.retainedVersions,
    entitlements.maxRetainedVersions,
  );

  const warnings: EffectiveEntitlements['warnings'] = [];
  if (monthlyDeployments.near) {
    warnings.push({
      code: 'QUOTA_NEAR_LIMIT',
      message: '本月上线次数即将用完。',
      metric: 'monthlyDeployments',
    });
  }
  if (projects.near) {
    warnings.push({
      code: 'QUOTA_NEAR_LIMIT',
      message: '应用数量即将达到套餐上限。',
      metric: 'projects',
    });
  }
  if (monthlyDeployments.exceeded) {
    warnings.push({
      code: 'DEPLOYMENT_QUOTA_EXCEEDED',
      message: '本月上线次数已用完。',
      metric: 'monthlyDeployments',
    });
  }

  return {
    planCode: input.planCode,
    planName: input.planName,
    planVersionId: input.planVersionId,
    planVersionNumber: input.planVersionNumber,
    grandfathered: input.grandfathered,
    subscriptionStatus: input.subscriptionStatus,
    source,
    entitlements,
    baseEntitlements: input.base,
    override: overrideLive
      ? {
          id: overrideLive.id,
          reason: overrideLive.reason,
          expiresAt: overrideLive.expiresAt,
          actorId: overrideLive.actorId,
        }
      : null,
    usage: input.usage,
    remaining: {
      projects: projects.remaining,
      monthlyDeployments: monthlyDeployments.remaining,
      members: members.remaining,
      runningApps: runningApps.remaining,
    },
    quota: { projects, monthlyDeployments, members, runningApps, retainedVersions },
    warnings,
  };
}

export type QuotaBlock = {
  ok: false;
  code: QuotaErrorCode;
  message: string;
  limit: number | null;
  used: number;
  remaining: number;
  plan: string;
  upgradeAvailable: boolean;
};

export type QuotaAllow = { ok: true };

export function projectQuotaDecision(input: {
  used: number;
  limit: number | null;
  planCode: string;
}): QuotaAllow | QuotaBlock {
  if (input.limit == null || input.used < input.limit) return { ok: true };
  return {
    ok: false,
    code: 'PROJECT_LIMIT_REACHED',
    message: `你的套餐最多可创建 ${input.limit} 个应用。`,
    limit: input.limit,
    used: input.used,
    remaining: 0,
    plan: input.planCode,
    upgradeAvailable: input.planCode !== 'enterprise',
  };
}

export function memberQuotaDecision(input: {
  used: number;
  limit: number | null;
  planCode: string;
}): QuotaAllow | QuotaBlock {
  if (input.limit == null || input.used < input.limit) return { ok: true };
  return {
    ok: false,
    code: 'MEMBER_LIMIT_REACHED',
    message: `当前套餐最多支持 ${input.limit} 位成员。`,
    limit: input.limit,
    used: input.used,
    remaining: 0,
    plan: input.planCode,
    upgradeAvailable: input.planCode !== 'enterprise',
  };
}

export function deploymentQuotaDecision(input: {
  used: number;
  limit: number | null;
  planCode: string;
}): QuotaAllow | QuotaBlock {
  if (input.limit == null || input.used < input.limit) return { ok: true };
  return {
    ok: false,
    code: 'DEPLOYMENT_QUOTA_EXCEEDED',
    message: '本月上线次数已用完。',
    limit: input.limit,
    used: input.used,
    remaining: 0,
    plan: input.planCode,
    upgradeAvailable: input.planCode !== 'enterprise',
  };
}

/**
 * New app first launch blocked when running apps at cap.
 * Redeploy/rollback of an already-running app must pass isExistingRunningApp=true.
 */
export function runningAppQuotaDecision(input: {
  used: number;
  limit: number | null;
  planCode: string;
  isExistingRunningApp?: boolean;
}): QuotaAllow | QuotaBlock {
  if (input.isExistingRunningApp) return { ok: true };
  if (input.limit == null || input.used < input.limit) return { ok: true };
  return {
    ok: false,
    code: 'RUNNING_APP_LIMIT_REACHED',
    message: `当前套餐最多可同时运行 ${input.limit} 个应用。`,
    limit: input.limit,
    used: input.used,
    remaining: 0,
    plan: input.planCode,
    upgradeAvailable: input.planCode !== 'enterprise',
  };
}

export function customDomainDecision(input: {
  enabled: boolean;
  planCode: string;
}): QuotaAllow | QuotaBlock {
  if (input.enabled) return { ok: true };
  return {
    ok: false,
    code: 'FEATURE_NOT_INCLUDED',
    message: '自定义域名需要 Pro 或更高套餐。',
    limit: null,
    used: 0,
    remaining: 0,
    plan: input.planCode,
    upgradeAvailable: true,
  };
}

/** OWNER counts toward maxWorkspaceMembers (Free=1 → owner only). */
export function memberCountsIncludingOwner(): true {
  return true;
}

/**
 * Deployment/redeploy/rollback that reach BUILD/DEPLOY count as 1.
 * Analyze/plan-only / gate-only do not count (caller sets usageClass).
 */
export function deploymentConsumesQuota(input: {
  usageClass?: string | null;
  kind?: 'deploy' | 'redeploy' | 'rollback' | 'analyze' | 'plan';
}): boolean {
  if (input.kind === 'analyze' || input.kind === 'plan') return false;
  const usageClass = input.usageClass ?? 'REAL_EXECUTION';
  if (['DRY_RUN', 'GATE_ONLY', 'PLAN', 'VERIFY_ONLY'].includes(usageClass)) return false;
  return true;
}

/**
 * After downgrade: existing resources preserved; only new consuming actions blocked.
 */
export function downgradeEnforcement(input: {
  used: number;
  limit: number | null;
  action: 'create_new' | 'keep_existing';
}): { allow: boolean; destructive: false } {
  if (input.action === 'keep_existing') return { allow: true, destructive: false };
  if (input.limit == null) return { allow: true, destructive: false };
  return { allow: input.used < input.limit, destructive: false };
}

/**
 * Version retention: keep newest N success versions (+ current). Older → EXPIRED metadata keep.
 * Never mark the current active version expired.
 */
export function selectVersionsForRetention(input: {
  versions: Array<{ id: string; createdAt: Date | string; isCurrent?: boolean; status?: string }>;
  maxRetained: number | null;
}): { keep: string[]; expire: string[] } {
  if (input.maxRetained == null) {
    return { keep: input.versions.map((v) => v.id), expire: [] };
  }
  const sorted = [...input.versions].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  const keep = new Set<string>();
  for (const v of sorted) {
    if (v.isCurrent) keep.add(v.id);
  }
  for (const v of sorted) {
    if (keep.size >= input.maxRetained) break;
    keep.add(v.id);
  }
  const expire = sorted.filter((v) => !keep.has(v.id)).map((v) => v.id);
  return { keep: [...keep], expire };
}

export function usageLedgerIdempotencyKey(input: {
  eventType: UsageLedgerEvent;
  workspaceId: string;
  resourceId: string;
}): string {
  return `${input.eventType}:${input.workspaceId}:${input.resourceId}`;
}

export function canReserveDeploymentSlot(input: {
  used: number;
  reserved: number;
  limit: number | null;
}): boolean {
  if (input.limit == null) return true;
  return input.used + input.reserved < input.limit;
}

export function subscriptionEntitlementBehavior(status: string): {
  usePlanEntitlements: boolean;
  fallBackToFree: boolean;
  blockNewConsumingActions: boolean;
  stopRunningApps: boolean;
} {
  if (status === 'ACTIVE' || status === 'TRIALING' || status === 'CANCEL_AT_PERIOD_END') {
    return {
      usePlanEntitlements: true,
      fallBackToFree: false,
      blockNewConsumingActions: false,
      stopRunningApps: false,
    };
  }
  if (status === 'PAST_DUE') {
    return {
      usePlanEntitlements: true,
      fallBackToFree: false,
      blockNewConsumingActions: true,
      stopRunningApps: false,
    };
  }
  if (status === 'CANCELED') {
    // Keep until period end handled by lifecycle; if still CANCELED without period → free
    return {
      usePlanEntitlements: false,
      fallBackToFree: true,
      blockNewConsumingActions: true,
      stopRunningApps: false,
    };
  }
  // EXPIRED
  return {
    usePlanEntitlements: false,
    fallBackToFree: true,
    blockNewConsumingActions: true,
    stopRunningApps: false,
  };
}

export function logRetentionLimitation(): string {
  return 'M6 logRetentionDays applies to Deployment history logs accessibility window; no ELK/Loki introduced.';
}
