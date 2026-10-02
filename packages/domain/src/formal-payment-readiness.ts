/**
 * M8-3 Formal Plan Payment Launch Readiness.
 * Keeps REAL_PAYMENTS closed; builds eligibility / preview / intent / access policy / checklist.
 */
import { resolveCatalogPriceCents, normalizeBillingCycle, readAlipayGates, type AlipayGates } from './alipay-readiness';

export const FORMAL_PRICES_LOCKED = {
  free: { monthlyFen: 0, yearlyFen: 0 },
  pro: { monthlyFen: 9900, yearlyFen: 99000 },
  team: { monthlyFen: 29900, yearlyFen: 299000 },
} as const;

export const TERMS_VERSION_CURRENT = 'commercial-terms-2026-10-m83';
export const PURCHASE_INTENT_TTL_MS = 15 * 60 * 1000;

export type AlipayProviderMode = 'SANDBOX' | 'PRODUCTION';

/**
 * Provider environment (which Alipay gateway/account) — independent of business payment gate.
 * ALIPAY_SANDBOX_ONLY is legacy: historically blocked ALL production Path A/B checkouts.
 * Formal Path B now keys off REAL_PAYMENTS_ENABLED only; sandboxOnly must not force Sandbox
 * when REAL_PAYMENTS_ENABLED=true.
 */
export function readAlipayProviderMode(env: NodeJS.ProcessEnv = process.env): AlipayProviderMode {
  const mode = String(env.ALIPAY_PROVIDER_MODE ?? '').trim().toUpperCase();
  if (mode === 'SANDBOX' || mode === 'PRODUCTION') return mode as AlipayProviderMode;
  // Default PRODUCTION config on Alpha (live keys exist); business still gated separately.
  return 'PRODUCTION';
}

export function describeAlipaySandboxOnlySemantics(): {
  legacyMeaning: string;
  blocksFormalCheckoutViaSandboxOnly: false;
  providerModeIndependent: true;
  recommendation: string;
} {
  return {
    legacyMeaning:
      'Historical flag that blocked production Alipay Path A/B checkouts when true (default). It does NOT select the Sandbox provider account.',
    blocksFormalCheckoutViaSandboxOnly: false,
    providerModeIndependent: true,
    recommendation:
      'Use ALIPAY_PROVIDER_MODE=SANDBOX|PRODUCTION for provider environment; use REAL_PAYMENTS_ENABLED for formal Pro/Team business gate.',
  };
}

export type PaymentAccessMode = 'DISABLED' | 'ALLOWLIST' | 'PERCENTAGE' | 'ALL';

export function parsePaymentAccessMode(raw: string | null | undefined): PaymentAccessMode {
  const v = String(raw ?? 'DISABLED').trim().toUpperCase();
  if (v === 'ALLOWLIST' || v === 'PERCENTAGE' || v === 'ALL' || v === 'DISABLED') return v;
  return 'DISABLED';
}

/** Stable 0–99 bucket from workspaceId for percentage rollout. */
export function workspacePercentageBucket(workspaceId: string): number {
  let h = 0;
  for (let i = 0; i < workspaceId.length; i++) h = (h * 31 + workspaceId.charCodeAt(i)) >>> 0;
  return h % 100;
}

export function accessPolicyAllows(input: {
  mode: PaymentAccessMode;
  workspaceId: string;
  allowlisted: boolean;
  percentage?: number | null;
}): { allowed: boolean; reason: string | null } {
  if (input.mode === 'DISABLED') return { allowed: false, reason: 'PAYMENT_ACCESS_DISABLED' };
  if (input.mode === 'ALL') return { allowed: true, reason: null };
  if (input.mode === 'ALLOWLIST') {
    return input.allowlisted
      ? { allowed: true, reason: null }
      : { allowed: false, reason: 'PAYMENT_ACCESS_NOT_ALLOWLISTED' };
  }
  const pct = Math.max(0, Math.min(100, Math.trunc(input.percentage ?? 0)));
  const bucket = workspacePercentageBucket(input.workspaceId);
  return bucket < pct
    ? { allowed: true, reason: null }
    : { allowed: false, reason: 'PAYMENT_ACCESS_PERCENTAGE_EXCLUDED' };
}

export type FormalRevenueBucket = 'SUBSCRIPTION_REVENUE' | 'TEST_PAYMENT' | 'NONE';

export function formalRevenueBucket(input: {
  paymentStatus: string;
  isProductionTest?: boolean;
  isTestPayment?: boolean;
  businessType?: string | null;
  planCode?: string | null;
}): FormalRevenueBucket {
  if (input.paymentStatus !== 'SUCCEEDED') return 'NONE';
  if (input.isProductionTest || input.businessType === 'PAYMENT_TEST' || input.planCode === 'PAYMENT_TEST') {
    return 'TEST_PAYMENT';
  }
  if (input.isTestPayment) return 'TEST_PAYMENT';
  if (
    input.businessType === 'SUBSCRIPTION_PURCHASE' ||
    input.businessType === 'SUBSCRIPTION_RENEWAL' ||
    input.businessType === 'SUBSCRIPTION_UPGRADE'
  ) {
    return 'SUBSCRIPTION_REVENUE';
  }
  const code = String(input.planCode ?? '').toLowerCase();
  if (code === 'pro' || code === 'team') return 'SUBSCRIPTION_REVENUE';
  return 'NONE';
}

export function lockedFormalPriceFen(
  planCode: string,
  billingCycle: 'MONTHLY' | 'YEARLY',
): { ok: true; amountFen: number } | { ok: false; code: string } {
  const code = planCode.trim().toLowerCase();
  if (code === 'enterprise') return { ok: false, code: 'PAYMENT_NOT_AVAILABLE' };
  if (code === 'free') return { ok: true, amountFen: 0 };
  const row = (FORMAL_PRICES_LOCKED as Record<string, { monthlyFen: number; yearlyFen: number }>)[code];
  if (!row) return { ok: false, code: 'PLAN_NOT_FOUND' };
  return { ok: true, amountFen: billingCycle === 'YEARLY' ? row.yearlyFen : row.monthlyFen };
}

export function assertPricesMatchLocked(input: {
  planCode: string;
  billingCycle: 'MONTHLY' | 'YEARLY';
  amountFen: number;
}): { ok: true } | { ok: false; code: 'PRICE_DRIFT' } {
  const locked = lockedFormalPriceFen(input.planCode, input.billingCycle);
  if (!locked.ok) return { ok: false, code: 'PRICE_DRIFT' };
  return locked.amountFen === input.amountFen ? { ok: true } : { ok: false, code: 'PRICE_DRIFT' };
}

export type EffectiveChangeRule = 'IMMEDIATE' | 'AT_PERIOD_END' | 'NONE';

export function describeSubscriptionChangeRule(input: {
  currentPlanCode: string;
  targetPlanCode: string;
}): { effectiveRule: EffectiveChangeRule; summaryZh: string } {
  const from = input.currentPlanCode.toLowerCase();
  const to = input.targetPlanCode.toLowerCase();
  if (from === to) {
    return { effectiveRule: 'NONE', summaryZh: '当前已是该套餐；续费将延长有效期。' };
  }
  const rank: Record<string, number> = { free: 0, pro: 1, team: 2, enterprise: 3 };
  const a = rank[from] ?? 0;
  const b = rank[to] ?? 0;
  if (b > a) {
    return { effectiveRule: 'IMMEDIATE', summaryZh: '支付成功后立即升级到目标套餐。' };
  }
  return { effectiveRule: 'AT_PERIOD_END', summaryZh: '当前周期结束后降级到目标套餐；现有数据不会自动删除。' };
}

export function buildCheckoutPreview(input: {
  planCode: string;
  billingCycle: 'MONTHLY' | 'YEARLY';
  currentPlanCode: string;
  planName: string;
  amountFen: number;
  currency?: string;
  workspaceName: string;
  hasBetaOverride?: boolean;
  betaPlanCode?: string | null;
}): {
  plan: string;
  billingCycle: string;
  amountFen: number;
  amountDisplay: string;
  currentPlan: string;
  targetPlan: string;
  effectiveRule: EffectiveChangeRule;
  effectiveRuleSummary: string;
  autoRenew: false;
  autoRenewImplemented: false;
  refundPolicySummary: string;
  cancelPolicySummary: string;
  workspaceName: string;
  realPaymentWarning: string;
  betaNotice: string | null;
  termsVersion: string;
} {
  const rule = describeSubscriptionChangeRule({
    currentPlanCode: input.currentPlanCode,
    targetPlanCode: input.planCode,
  });
  const yuan = (input.amountFen / 100).toFixed(input.amountFen % 100 === 0 ? 0 : 2);
  let betaNotice: string | null = null;
  if (input.hasBetaOverride && input.betaPlanCode) {
    betaNotice = `你当前仍享有 Beta ${input.betaPlanCode} 权益；正式 ${input.planName} 订阅将按付费记录保存，有效权益以更高优先级解析。`;
  }
  return {
    plan: input.planCode,
    billingCycle: input.billingCycle,
    amountFen: input.amountFen,
    amountDisplay: `¥${yuan}`,
    currentPlan: input.currentPlanCode,
    targetPlan: input.planCode,
    effectiveRule: rule.effectiveRule,
    effectiveRuleSummary: rule.summaryZh,
    autoRenew: false,
    autoRenewImplemented: false,
    refundPolicySummary: '系统暂不支持在线自动退款；如需协助请联系支持。',
    cancelPolicySummary: '可随时设置到期后不再续用付费套餐；当前未开启自动扣款。',
    workspaceName: input.workspaceName,
    realPaymentWarning: '点击后将创建真实支付宝订单并产生实际付款。',
    betaNotice,
    termsVersion: TERMS_VERSION_CURRENT,
  };
}

export function evaluatePaymentEligibility(input: {
  gates: Pick<AlipayGates, 'realPaymentsEnabled' | 'alipayProductionEnabled'>;
  accessMode: PaymentAccessMode;
  allowlisted: boolean;
  percentage?: number | null;
  planCode: string;
  billingCycle: string;
  workspaceStatus: string;
  providerLiveValidated: boolean;
  providerMode: AlipayProviderMode;
  outstandingPendingCount?: number;
  actorIsPlatformAdmin?: boolean;
  dryRun?: boolean;
}): {
  eligible: boolean;
  reason: string | null;
  currentBlockers: string[];
} {
  const blockers: string[] = [];
  const cycle = normalizeBillingCycle(input.billingCycle);
  if (!cycle || cycle === 'ONE_TIME_TEST') blockers.push('BILLING_CYCLE_INVALID');
  const code = input.planCode.trim().toLowerCase();
  if (code === 'enterprise') blockers.push('PAYMENT_NOT_AVAILABLE');
  if (code === 'payment_test') blockers.push('PAYMENT_TEST_FORBIDDEN');
  if (code !== 'pro' && code !== 'team') {
    if (code !== 'enterprise') blockers.push('PLAN_NOT_PURCHASABLE');
  }
  if (input.workspaceStatus === 'SUSPENDED' || input.workspaceStatus === 'ARCHIVED') {
    blockers.push('WORKSPACE_NOT_ACTIVE');
  }
  if (!input.dryRun) {
    if (!input.gates.realPaymentsEnabled) blockers.push('REAL_PAYMENTS_DISABLED');
    if (!input.gates.alipayProductionEnabled && input.providerMode === 'PRODUCTION') {
      blockers.push('ALIPAY_PRODUCTION_DISABLED');
    }
    if (!input.providerLiveValidated) blockers.push('PROVIDER_LIVE_PAYMENT_NOT_VALIDATED');
  }
  // Re-evaluate access with workspace — callers must pass workspaceId via allowlisted/percentage already computed
  if (!input.dryRun) {
    if (input.accessMode === 'DISABLED') blockers.push('PAYMENT_ACCESS_DISABLED');
    else if (input.accessMode === 'ALLOWLIST' && !input.allowlisted) blockers.push('PAYMENT_ACCESS_NOT_ALLOWLISTED');
  }
  if ((input.outstandingPendingCount ?? 0) > 3) blockers.push('TOO_MANY_PENDING_ORDERS');

  const unique = [...new Set(blockers)];
  return {
    eligible: unique.length === 0,
    reason: unique[0] ?? null,
    currentBlockers: unique,
  };
}

/** Corrected eligibility with workspaceId for percentage mode. */
export function canPurchaseFormalPlan(input: {
  realPaymentsEnabled: boolean;
  alipayProductionEnabled: boolean;
  accessMode: PaymentAccessMode;
  workspaceId: string;
  allowlisted: boolean;
  percentage?: number | null;
  planCode: string;
  billingCycle: 'MONTHLY' | 'YEARLY';
  workspaceStatus: string;
  providerLiveValidated: boolean;
  dryRun?: boolean;
}): { eligible: boolean; reason: string | null; currentPlanHint?: string } {
  const code = input.planCode.trim().toLowerCase();
  if (code === 'enterprise') return { eligible: false, reason: 'PAYMENT_NOT_AVAILABLE' };
  if (code !== 'pro' && code !== 'team') return { eligible: false, reason: 'PLAN_NOT_PURCHASABLE' };
  if (input.workspaceStatus === 'SUSPENDED' || input.workspaceStatus === 'ARCHIVED') {
    return { eligible: false, reason: 'WORKSPACE_NOT_ACTIVE' };
  }
  if (input.dryRun) return { eligible: true, reason: null };
  if (!input.realPaymentsEnabled) return { eligible: false, reason: 'REAL_PAYMENTS_DISABLED' };
  if (!input.alipayProductionEnabled) return { eligible: false, reason: 'ALIPAY_PRODUCTION_DISABLED' };
  if (!input.providerLiveValidated) return { eligible: false, reason: 'PROVIDER_LIVE_PAYMENT_NOT_VALIDATED' };
  const access = accessPolicyAllows({
    mode: input.accessMode,
    workspaceId: input.workspaceId,
    allowlisted: input.allowlisted,
    percentage: input.percentage,
  });
  if (!access.allowed) return { eligible: false, reason: access.reason };
  return { eligible: true, reason: null };
}

export function killSwitchBlocksNewCheckout(realPaymentsEnabled: boolean): boolean {
  return !realPaymentsEnabled;
}

export function killSwitchAllowsExistingFinalization(): true {
  return true;
}

export function purchaseIntentIsUsable(input: {
  status: string;
  expiresAt: Date | string;
  amountFen: number;
  planCode: string;
  billingCycle: 'MONTHLY' | 'YEARLY';
  now?: Date;
}): { ok: true } | { ok: false; code: string } {
  const now = input.now ?? new Date();
  if (input.status !== 'CONFIRMED' && input.status !== 'CREATED') {
    return { ok: false, code: 'PURCHASE_INTENT_NOT_USABLE' };
  }
  if (new Date(input.expiresAt).getTime() <= now.getTime()) {
    return { ok: false, code: 'PURCHASE_INTENT_EXPIRED' };
  }
  const locked = assertPricesMatchLocked({
    planCode: input.planCode,
    billingCycle: input.billingCycle,
    amountFen: input.amountFen,
  });
  if (!locked.ok) return { ok: false, code: 'PRICE_DRIFT' };
  return { ok: true };
}

export function buildPriceSnapshot(input: {
  planCode: string;
  billingCycle: string;
  amountFen: number;
  currency: string;
  planVersionId: string | null;
  priceVersion?: number | null;
}): Record<string, string | number | null> {
  return {
    planCode: input.planCode,
    billingCycle: input.billingCycle,
    amountFen: input.amountFen,
    currency: input.currency,
    planVersionId: input.planVersionId,
    priceVersion: input.priceVersion ?? null,
    capturedAt: new Date().toISOString(),
  };
}

export type LaunchChecklistItem = {
  key: string;
  label: string;
  pass: boolean;
};

export function buildFormalPaymentLaunchChecklist(flags: {
  productionProviderLiveVerified: boolean;
  pricesLocked: boolean;
  termsVersionActive: boolean;
  purchaseConfirmReady: boolean;
  subscriptionLifecycleReady: boolean;
  entitlementReady: boolean;
  billingReady: boolean;
  adminPaymentsReady: boolean;
  killSwitchReady: boolean;
  allowlistReady: boolean;
  reconciliationReady: boolean;
  alertsReady: boolean;
  regressionPass: boolean;
}): { items: LaunchChecklistItem[]; formalPaymentLaunchReady: boolean; formalPlanPaymentOpened: false } {
  const items: LaunchChecklistItem[] = [
    { key: 'ProductionProvider', label: 'Production Provider Live Verified', pass: flags.productionProviderLiveVerified },
    { key: 'Pricing', label: 'Prices Locked', pass: flags.pricesLocked },
    { key: 'Terms', label: 'Terms Version Active', pass: flags.termsVersionActive },
    { key: 'PurchaseConfirm', label: 'Purchase Confirm Ready', pass: flags.purchaseConfirmReady },
    { key: 'SubscriptionLifecycle', label: 'Subscription Lifecycle Ready', pass: flags.subscriptionLifecycleReady },
    { key: 'Entitlement', label: 'Entitlement Ready', pass: flags.entitlementReady },
    { key: 'Billing', label: 'Billing Ready', pass: flags.billingReady },
    { key: 'Admin', label: 'Admin Payments Ready', pass: flags.adminPaymentsReady },
    { key: 'KillSwitch', label: 'Kill Switch Ready', pass: flags.killSwitchReady },
    { key: 'Allowlist', label: 'Allowlist Ready', pass: flags.allowlistReady },
    { key: 'Reconciliation', label: 'Reconciliation Ready', pass: flags.reconciliationReady },
    { key: 'Alerts', label: 'Alerts Ready', pass: flags.alertsReady },
    { key: 'Regression', label: 'Regression PASS', pass: flags.regressionPass },
  ];
  return {
    items,
    formalPaymentLaunchReady: items.every((i) => i.pass),
    formalPlanPaymentOpened: false,
  };
}

export function decideFormalAlipayCheckout(input: {
  realPaymentsEnabled: boolean;
  alipayProductionEnabled: boolean;
  providerStatus: string;
  providerLiveValidated: boolean;
  accessAllowed: boolean;
  accessReason?: string | null;
}): { ok: true } | { ok: false; code: string } {
  if (input.providerStatus === 'DISABLED') return { ok: false, code: 'ALIPAY_DISABLED' };
  if (input.providerStatus !== 'VERIFIED') return { ok: false, code: 'ALIPAY_NOT_VERIFIED' };
  if (!input.providerLiveValidated) return { ok: false, code: 'PROVIDER_LIVE_PAYMENT_NOT_VALIDATED' };
  if (!input.realPaymentsEnabled) return { ok: false, code: 'REAL_PAYMENTS_DISABLED' };
  if (!input.alipayProductionEnabled) return { ok: false, code: 'ALIPAY_PRODUCTION_DISABLED' };
  if (!input.accessAllowed) return { ok: false, code: input.accessReason || 'PAYMENT_ACCESS_DISABLED' };
  return { ok: true };
}

/** Path B formal catalog: do not use ALIPAY_SANDBOX_ONLY — provider mode is separate. */
export function formalPathIgnoresSandboxOnlyFlag(): true {
  return true;
}

export function mockActivationMatrix(): Array<{
  planCode: 'pro' | 'team';
  billingCycle: 'MONTHLY' | 'YEARLY';
  amountFen: number;
  businessType: 'SUBSCRIPTION_PURCHASE';
}> {
  return [
    { planCode: 'pro', billingCycle: 'MONTHLY', amountFen: 9900, businessType: 'SUBSCRIPTION_PURCHASE' },
    { planCode: 'pro', billingCycle: 'YEARLY', amountFen: 99000, businessType: 'SUBSCRIPTION_PURCHASE' },
    { planCode: 'team', billingCycle: 'MONTHLY', amountFen: 29900, businessType: 'SUBSCRIPTION_PURCHASE' },
    { planCode: 'team', billingCycle: 'YEARLY', amountFen: 299000, businessType: 'SUBSCRIPTION_PURCHASE' },
  ];
}

export function fulfillmentPendingEventType(): 'PAYMENT_SUCCEEDED_FULFILLMENT_PENDING' {
  return 'PAYMENT_SUCCEEDED_FULFILLMENT_PENDING';
}

// Keep resolveCatalogPriceCents import used for parity checks in tests
export function serverPriceMatchesLocked(
  planCode: string,
  billingCycle: 'MONTHLY' | 'YEARLY',
  priceMonthly: number,
  priceYearly: number | null,
): boolean {
  const resolved = resolveCatalogPriceCents({
    planCode,
    billingCycle,
    priceMonthly,
    priceYearly,
  });
  if (!resolved.ok) return false;
  const locked = lockedFormalPriceFen(planCode, billingCycle);
  return locked.ok && locked.amountFen === resolved.amountCents;
}

export function readFormalPaymentGates(env: NodeJS.ProcessEnv = process.env) {
  const gates = readAlipayGates(env);
  return {
    ...gates,
    providerMode: readAlipayProviderMode(env),
    sandboxOnlySemantics: describeAlipaySandboxOnlySemantics(),
  };
}
