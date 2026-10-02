import { randomBytes } from 'node:crypto';
import { classifyPaymentRevenue } from './payment-readiness';

export const PAYMENT_PROVIDER_TYPES = ['MOCK', 'ALIPAY', 'WECHAT_PAY', 'STRIPE'] as const;
export type PaymentProviderType = (typeof PAYMENT_PROVIDER_TYPES)[number];

export const ALIPAY_PRODUCTION_GATEWAY = 'https://openapi.alipay.com/gateway.do';
export const ALIPAY_SANDBOX_GATEWAY = 'https://openapi-sandbox.dl.alipay.com/gateway.do';

export type AlipayEnvironment = 'SANDBOX' | 'PRODUCTION';

export const PAYMENT_TEST_PLAN_CODE = 'PAYMENT_TEST';
export const PAYMENT_TEST_MONTHLY_CENTS = 90;

export type AlipayGates = {
  realPaymentsEnabled: boolean;
  /** Alias of PAYMENT_TEST_REAL_ENABLED / ALIPAY_PRODUCTION_TEST_ENABLED */
  paymentTestRealEnabled: boolean;
  /** @deprecated prefer paymentTestRealEnabled — kept for existing callers */
  alipayProductionTestEnabled: boolean;
  alipayProductionEnabled: boolean;
  sandboxOnly: boolean;
  productionTestWorkspaceId: string | null;
};

export function readAlipayGates(env: NodeJS.ProcessEnv = process.env): AlipayGates {
  const workspaceId = env.ALIPAY_PRODUCTION_TEST_WORKSPACE_ID?.trim() || null;
  const paymentTestRealEnabled =
    env.PAYMENT_TEST_REAL_ENABLED === 'true' || env.ALIPAY_PRODUCTION_TEST_ENABLED === 'true';
  return {
    realPaymentsEnabled: env.REAL_PAYMENTS_ENABLED === 'true',
    paymentTestRealEnabled,
    alipayProductionTestEnabled: paymentTestRealEnabled,
    alipayProductionEnabled: env.ALIPAY_PRODUCTION_ENABLED === 'true',
    sandboxOnly: env.ALIPAY_SANDBOX_ONLY !== 'false',
    productionTestWorkspaceId: workspaceId,
  };
}

/**
 * PRODUCTION checkout has two mutually gated paths:
 * 1) PAYMENT_TEST (¥0.90) — needs paymentTestRealEnabled only; REAL_PAYMENTS_ENABLED stays false.
 * 2) Real Pro/Team — needs REAL_PAYMENTS_ENABLED (+ production Alipay gates); not opened in M8-1.
 */
export function decideAlipayCheckout(input: {
  actorIsPlatformAdmin: boolean;
  environment: AlipayEnvironment;
  providerStatus: string;
  gates: Pick<
    AlipayGates,
    'realPaymentsEnabled' | 'alipayProductionEnabled' | 'alipayProductionTestEnabled' | 'paymentTestRealEnabled' | 'sandboxOnly'
  > & { paymentTestRealEnabled?: boolean };
  productionTest?: {
    workspaceId: string;
    allowedWorkspaceId: string | null;
    planCode: string;
    planStatus: string;
    priceMonthlyCents: number | null;
  } | null;
  /** When true, this is a real catalog purchase (pro/team), not PAYMENT_TEST. */
  realCatalogPurchase?: boolean;
}): { ok: true; isTestPayment: boolean; isProductionTest: boolean } | { ok: false; code: string } {
  if (input.providerStatus === 'DISABLED') return { ok: false, code: 'ALIPAY_DISABLED' };
  if (input.providerStatus !== 'VERIFIED') return { ok: false, code: 'ALIPAY_NOT_VERIFIED' };
  if (input.environment === 'SANDBOX') {
    if (!input.actorIsPlatformAdmin) return { ok: false, code: 'ALIPAY_SANDBOX_ADMIN_ONLY' };
    return { ok: true, isTestPayment: true, isProductionTest: false };
  }

  const testGate =
    input.gates.paymentTestRealEnabled === true || input.gates.alipayProductionTestEnabled === true;
  const test = input.productionTest;

  // Path A: hidden PAYMENT_TEST production small-amount verification
  if (test) {
    if (input.gates.sandboxOnly) return { ok: false, code: 'ALIPAY_SANDBOX_ONLY' };
    if (!testGate) return { ok: false, code: 'ALIPAY_PRODUCTION_TEST_DISABLED' };
    if (!input.actorIsPlatformAdmin) return { ok: false, code: 'ALIPAY_PRODUCTION_TEST_ADMIN_ONLY' };
    if (!test.allowedWorkspaceId || test.workspaceId !== test.allowedWorkspaceId) {
      return { ok: false, code: 'ALIPAY_PRODUCTION_TEST_WORKSPACE' };
    }
    if (
      test.planCode !== PAYMENT_TEST_PLAN_CODE ||
      test.planStatus !== 'INTERNAL_TEST' ||
      test.priceMonthlyCents !== PAYMENT_TEST_MONTHLY_CENTS
    ) {
      return { ok: false, code: 'ALIPAY_PRODUCTION_TEST_PLAN' };
    }
    // Intentionally does NOT require REAL_PAYMENTS_ENABLED.
    return { ok: true, isTestPayment: false, isProductionTest: true };
  }

  // Path B: real catalog purchase (Pro / Team) — closed unless REAL_PAYMENTS_ENABLED.
  // M8-3: do NOT gate Path B on ALIPAY_SANDBOX_ONLY (legacy business blocker).
  // Provider environment is selected via ALIPAY_PROVIDER_MODE / account environment separately.
  if (input.realCatalogPurchase) {
    if (!input.gates.realPaymentsEnabled) return { ok: false, code: 'REAL_PAYMENTS_DISABLED' };
    if (!input.gates.alipayProductionEnabled) return { ok: false, code: 'ALIPAY_PRODUCTION_DISABLED' };
    return { ok: true, isTestPayment: false, isProductionTest: false };
  }

  return { ok: false, code: 'REAL_PAYMENTS_DISABLED' };
}

/** Server-authoritative catalog price in fen/cents. Client amount is never trusted. */
export function resolveCatalogPriceCents(input: {
  planCode: string;
  billingCycle: 'MONTHLY' | 'YEARLY' | 'ONE_TIME_TEST';
  priceMonthly?: number | null;
  priceYearly?: number | null;
  priceMonthlyCents?: number | null;
  priceYearlyCents?: number | null;
}): { ok: true; amountCents: number } | { ok: false; code: string } {
  const code = input.planCode.trim().toLowerCase() === 'payment_test' ? PAYMENT_TEST_PLAN_CODE : input.planCode;
  if (code === PAYMENT_TEST_PLAN_CODE || input.billingCycle === 'ONE_TIME_TEST') {
    return { ok: true, amountCents: PAYMENT_TEST_MONTHLY_CENTS };
  }
  if (input.billingCycle === 'MONTHLY') {
    if (input.priceMonthlyCents != null && Number.isFinite(input.priceMonthlyCents)) {
      return { ok: true, amountCents: Math.trunc(input.priceMonthlyCents) };
    }
    if (input.priceMonthly != null && Number.isFinite(input.priceMonthly)) {
      return { ok: true, amountCents: Math.trunc(input.priceMonthly) * 100 };
    }
    return { ok: false, code: 'PLAN_PRICE_MISSING' };
  }
  if (input.billingCycle === 'YEARLY') {
    if (input.priceYearlyCents != null && Number.isFinite(input.priceYearlyCents)) {
      return { ok: true, amountCents: Math.trunc(input.priceYearlyCents) };
    }
    if (input.priceYearly != null && Number.isFinite(input.priceYearly)) {
      return { ok: true, amountCents: Math.trunc(input.priceYearly) * 100 };
    }
    return { ok: false, code: 'PLAN_PRICE_MISSING' };
  }
  return { ok: false, code: 'BILLING_CYCLE_INVALID' };
}

export function normalizeBillingCycle(raw: string | undefined | null): 'MONTHLY' | 'YEARLY' | 'ONE_TIME_TEST' | null {
  const value = String(raw ?? '')
    .trim()
    .toUpperCase();
  if (value === 'MONTHLY' || value === 'MONTH') return 'MONTHLY';
  if (value === 'YEARLY' || value === 'YEAR' || value === 'ANNUAL') return 'YEARLY';
  if (value === 'ONE_TIME_TEST' || value === 'TEST') return 'ONE_TIME_TEST';
  return null;
}

export function canProcessExistingAlipayPayment(status: string): boolean {
  return status === 'VERIFIED' || status === 'DISABLED' || status === 'ERROR' || status === 'CONFIGURED';
}

export function assertGatewayEnvironment(environment: AlipayEnvironment, gatewayUrl: string): { ok: true } | { ok: false; message: string } {
  if (environment === 'PRODUCTION') {
    if (gatewayUrl !== ALIPAY_PRODUCTION_GATEWAY) return { ok: false, message: '生产网关必须使用支付宝正式地址' };
    return { ok: true };
  }
  if (gatewayUrl === ALIPAY_PRODUCTION_GATEWAY) return { ok: false, message: '沙箱不能使用生产网关' };
  const local = gatewayUrl.startsWith('http://127.0.0.1') || gatewayUrl.startsWith('http://localhost');
  if (gatewayUrl !== ALIPAY_SANDBOX_GATEWAY && !local) return { ok: false, message: '沙箱网关只能是支付宝沙箱或本机联调地址' };
  return { ok: true };
}

export function buildMerchantOrderNo(now: Date, entropy = randomBytes(4).toString('hex')): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const suffix = entropy.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase().padEnd(8, '0');
  return `LOS-${year}${month}${day}-${suffix}`;
}

export function subscriptionChargeCents(input: {
  subscriptionFee: number;
  discountAmount: number;
  taxAmount: number | null;
  cloudCostEstimate: number | null;
  clientAmount?: number | null;
}): { cents: number; yuan: number; ignoredClientAmount: boolean; includesCloudCost: false } {
  const yuan = input.subscriptionFee - input.discountAmount + (input.taxAmount ?? 0);
  const clientCents = input.clientAmount == null ? null : Math.round(input.clientAmount * 100);
  return {
    cents: yuan * 100,
    yuan,
    ignoredClientAmount: clientCents != null && clientCents !== yuan * 100,
    includesCloudCost: false,
  };
}

export function providerAmountMatches(orderYuan: number, providerCents: number, orderCents?: number | null): boolean {
  if (orderCents != null) return orderCents === providerCents;
  return Number.isInteger(orderYuan) && orderYuan * 100 === providerCents;
}

export function returnUrlIsNotPaymentFact(): { trusted: false; pendingCopy: string } {
  return { trusted: false, pendingCopy: '正在确认支付结果' };
}

export function providerTimeoutState(): { status: 'PROCESSING'; queryState: 'UNKNOWN_PENDING'; markFailed: false } {
  return { status: 'PROCESSING', queryState: 'UNKNOWN_PENDING', markFailed: false };
}

export function userPaymentWaitCopy(input: { orderStatus: string; paymentStatus: string; queryState?: string | null }): string {
  if (input.orderStatus === 'FULFILLED') return '开通完成';
  if (input.paymentStatus === 'SUCCEEDED' || input.orderStatus === 'PAID' || input.orderStatus === 'FULFILLING') return '支付成功，正在开通';
  if (input.paymentStatus === 'REQUIRES_REVIEW' || input.orderStatus === 'REQUIRES_REVIEW') return '需要人工核对';
  if (input.paymentStatus === 'FAILED' || input.paymentStatus === 'CANCELED' || input.orderStatus === 'PAYMENT_FAILED' || input.orderStatus === 'CANCELED' || input.orderStatus === 'EXPIRED') return '支付未完成';
  if (input.queryState === 'UNKNOWN_PENDING' || input.paymentStatus === 'PROCESSING') return '正在确认';
  return '等待支付';
}

export function fulfillmentCopy(input: { paymentStatus: string; orderStatus: string }): string {
  if (input.paymentStatus === 'SUCCEEDED' && input.orderStatus === 'FULFILLING') return '支付已成功，服务正在处理中';
  return userPaymentWaitCopy(input);
}

export function fulfillmentSourceForPayment(payment: { provider: string | null; environment: string | null; isTestPayment: boolean; isProductionTest?: boolean }): { source: string; activationSource: string; paymentStatus: string; invoiceSource: string } {
  if (payment.isProductionTest) {
    return { source: 'ALIPAY_PRODUCTION_TEST', activationSource: 'ALIPAY_PRODUCTION_TEST', paymentStatus: 'TEST', invoiceSource: 'ALIPAY_PRODUCTION_TEST' };
  }
  if (payment.provider === 'ALIPAY' && payment.environment === 'PRODUCTION' && !payment.isTestPayment) {
    return { source: 'PAYMENT_PROVIDER', activationSource: 'PAYMENT_PROVIDER', paymentStatus: 'PAID', invoiceSource: 'ALIPAY' };
  }
  if (payment.provider === 'ALIPAY') {
    return { source: 'ALIPAY_SANDBOX', activationSource: 'ALIPAY_SANDBOX', paymentStatus: 'TEST', invoiceSource: 'ALIPAY_SANDBOX' };
  }
  return { source: 'MOCK_PAYMENT', activationSource: 'MOCK_PAYMENT', paymentStatus: 'TEST', invoiceSource: 'MOCK' };
}

export function alipayRevenueBucket(input: { isTestPayment: boolean; isProductionTest?: boolean; paymentStatus: string; orderStatus: string; amount: number }): { bucket: 'test' | 'real' | 'none'; amount: number } {
  return classifyPaymentRevenue({ provider: 'ALIPAY', isTestPayment: input.isTestPayment, isProductionTest: input.isProductionTest, paymentStatus: input.paymentStatus, orderStatus: input.orderStatus, amount: input.amount });
}

export function assessAlipayProductionReadiness(input: {
  appReady: boolean;
  appId: string | null;
  gatewayUrl: string | null;
  privateKeyConfigured: boolean;
  publicKeyConfigured: boolean;
  notifyUrl: string | null;
  signatureVerified: boolean;
  clockOk: boolean;
  callbackReachable: boolean;
}): { ready: boolean; blockers: string[] } {
  const blockers: string[] = [];
  if (!input.appReady) blockers.push('支付宝应用尚未标记为可用');
  if (!input.appId) blockers.push('缺少 AppID');
  if (input.gatewayUrl !== ALIPAY_PRODUCTION_GATEWAY) blockers.push('生产网关不正确');
  if (!input.privateKeyConfigured) blockers.push('缺少应用私钥');
  if (!input.publicKeyConfigured) blockers.push('缺少支付宝公钥');
  if (!input.notifyUrl || !input.notifyUrl.startsWith('https://') || /localhost|127\.0\.0\.1/i.test(input.notifyUrl)) blockers.push('异步通知地址必须是可公网访问的 HTTPS');
  if (!input.signatureVerified) blockers.push('签名校验未通过');
  if (!input.clockOk) blockers.push('服务器时间不可用');
  if (!input.callbackReachable) blockers.push('异步通知地址当前不可达');
  return { ready: blockers.length === 0, blockers };
}

export function alipayConfigComplete(input: { appId?: string | null; gatewayUrl?: string | null; publicKey?: string | null; privateKeyConfigured: boolean; notifyUrl?: string | null; returnUrl?: string | null }): boolean {
  return Boolean(input.appId && input.gatewayUrl && input.publicKey && input.privateKeyConfigured && input.notifyUrl && input.returnUrl);
}
