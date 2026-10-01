import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const PAYMENT_ERROR_COPY: Record<string, string> = {
  ORDER_ALREADY_PAID: '这笔订单已经支付',
  ORDER_EXPIRED: '订单已过期，请重新下单',
  PAYMENT_AMOUNT_MISMATCH: '支付金额与订单不一致，已转人工核对',
  PAYMENT_CURRENCY_MISMATCH: '支付币种与订单不一致，已转人工核对',
  WEBHOOK_SIGNATURE_INVALID: '支付通知无法确认',
  WEBHOOK_DUPLICATE: '这笔通知已经处理过',
  PAYMENT_NOT_FOUND: '没有找到对应的支付',
  FULFILLMENT_FAILED: '支付已收到，权益开通将自动重试',
  REFUND_NOT_ALLOWED: '当前支付不能退款',
  SELLER_MISMATCH: '支付信息与订单不一致，已转人工核对',
  ALIPAY_DISABLED: '支付宝已停用，不能发起新的支付',
  ALIPAY_NOT_VERIFIED: '支付宝配置尚未验证',
  ALIPAY_SANDBOX_ADMIN_ONLY: '支付宝暂未向当前账号开放',
  REAL_PAYMENTS_DISABLED: '真实支付尚未开放',
  ALIPAY_PRODUCTION_DISABLED: '真实支付尚未开放',
  ALIPAY_SANDBOX_ONLY: '真实支付尚未开放',
  ALIPAY_PRODUCTION_TEST_DISABLED: '生产小额联调尚未开放',
  ALIPAY_PRODUCTION_TEST_ADMIN_ONLY: '只有平台管理员可以发起生产小额联调',
  ALIPAY_PRODUCTION_TEST_WORKSPACE: '这个工作空间不能用于生产小额联调',
  ALIPAY_PRODUCTION_TEST_PLAN: '只有支付联调测试套餐可以发起生产小额支付',
};

export const INTERNAL_PAYMENT_EVENTS = [
  'PAYMENT_SUCCEEDED',
  'PAYMENT_FAILED',
  'PAYMENT_CANCELED',
  'REFUND_SUCCEEDED',
  'REFUND_FAILED',
] as const;

const PROVIDER_EVENT_MAP: Record<string, (typeof INTERNAL_PAYMENT_EVENTS)[number]> = {
  'payment.succeeded': 'PAYMENT_SUCCEEDED',
  'payment.failed': 'PAYMENT_FAILED',
  'payment.canceled': 'PAYMENT_CANCELED',
  'refund.succeeded': 'REFUND_SUCCEEDED',
  'refund.failed': 'REFUND_FAILED',
};

export function mockPaymentsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== 'production';
}

export function mockWebhookSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.MOCK_WEBHOOK_SECRET) return env.MOCK_WEBHOOK_SECRET;
  if (env.NODE_ENV === 'production') return null;
  return 'dev-mock-webhook-secret';
}

export function lockOrderAmount(input: {
  subscriptionFee: number;
  discountAmount: number;
  taxAmount: number | null;
  currency: string;
  clientAmount?: number | null;
  clientCurrency?: string | null;
}): { subscriptionFee: number; discountAmount: number; taxAmount: number | null; totalAmount: number; currency: string; ignoredClientAmount: boolean } {
  const totalAmount = input.subscriptionFee - input.discountAmount + (input.taxAmount ?? 0);
  const ignoredClientAmount = input.clientAmount != null && (input.clientAmount !== totalAmount || (input.clientCurrency != null && input.clientCurrency !== input.currency));
  return {
    subscriptionFee: input.subscriptionFee,
    discountAmount: input.discountAmount,
    taxAmount: input.taxAmount,
    totalAmount,
    currency: input.currency,
    ignoredClientAmount,
  };
}

export function canEditOrderAmounts(status: string): boolean {
  return status === 'DRAFT';
}

export function canCancelOrder(status: string): boolean {
  return status === 'DRAFT' || status === 'PENDING_PAYMENT';
}

export function signMockWebhook(payload: string, timestamp: string, secret: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
}

export function verifyMockWebhook(input: { payload: string; timestamp: string; signature: string; secret: string; now?: number }): { ok: true } | { ok: false; code: 'WEBHOOK_SIGNATURE_INVALID' } {
  const now = input.now ?? Date.now();
  const stamped = Number(input.timestamp);
  if (!input.secret || !input.signature || !Number.isFinite(stamped) || Math.abs(now - stamped) > 5 * 60 * 1000) {
    return { ok: false, code: 'WEBHOOK_SIGNATURE_INVALID' };
  }
  const expected = signMockWebhook(input.payload, input.timestamp, input.secret);
  const left = Buffer.from(expected);
  const right = Buffer.from(input.signature);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return { ok: false, code: 'WEBHOOK_SIGNATURE_INVALID' };
  return { ok: true };
}

export function payloadHash(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

export function parseProviderEvent(eventType: string): (typeof INTERNAL_PAYMENT_EVENTS)[number] | null {
  if (INTERNAL_PAYMENT_EVENTS.includes(eventType as (typeof INTERNAL_PAYMENT_EVENTS)[number])) {
    return eventType as (typeof INTERNAL_PAYMENT_EVENTS)[number];
  }
  return PROVIDER_EVENT_MAP[eventType] ?? null;
}

export function decideVerifiedPayment(input: {
  event: 'PAYMENT_SUCCEEDED' | 'PAYMENT_FAILED' | 'PAYMENT_CANCELED';
  paymentStatus: string;
  orderStatus: string;
  orderAmount: number;
  orderCurrency: string;
  providerAmount: number;
  providerCurrency: string;
  expiresAt: string | null;
  now: string;
  hasSucceededPayment: boolean;
}): { action: 'ignore_paid' | 'fail' | 'cancel' | 'review' | 'succeed'; code?: string; paymentStatus?: string; orderStatus?: string } {
  if (input.hasSucceededPayment || input.paymentStatus === 'SUCCEEDED' || input.orderStatus === 'FULFILLED' || input.orderStatus === 'PAID') {
    return { action: 'ignore_paid', code: 'ORDER_ALREADY_PAID' };
  }
  if (input.paymentStatus === 'FAILED' || input.paymentStatus === 'CANCELED' || input.paymentStatus === 'REFUNDED') {
    return { action: 'ignore_paid', code: 'LAST_PAYMENT_STATE_INVALID' };
  }
  if (input.event === 'PAYMENT_FAILED') return { action: 'fail', paymentStatus: 'FAILED', orderStatus: 'PAYMENT_FAILED' };
  if (input.event === 'PAYMENT_CANCELED') return { action: 'cancel', paymentStatus: 'CANCELED', orderStatus: 'CANCELED' };
  if (input.expiresAt && input.expiresAt <= input.now) return { action: 'review', code: 'ORDER_EXPIRED', paymentStatus: 'REQUIRES_REVIEW', orderStatus: input.orderStatus };
  if (input.providerAmount !== input.orderAmount) return { action: 'review', code: 'PAYMENT_AMOUNT_MISMATCH', paymentStatus: 'REQUIRES_REVIEW', orderStatus: input.orderStatus };
  if (input.providerCurrency !== input.orderCurrency) return { action: 'review', code: 'PAYMENT_CURRENCY_MISMATCH', paymentStatus: 'REQUIRES_REVIEW', orderStatus: input.orderStatus };
  return { action: 'succeed', paymentStatus: 'SUCCEEDED', orderStatus: 'PAID' };
}

export function applyRefundDecision(input: { paymentStatus: string; paymentAmount: number; alreadyRefunded: number; refundAmount: number; invoiceAmount: number }): { ok: true; paymentStatus: string; orderStatus: string; invoiceAmount: number; stopsService: false } | { ok: false; code: 'REFUND_NOT_ALLOWED'; invoiceAmount: number } {
  const allowed = input.paymentStatus === 'SUCCEEDED' || input.paymentStatus === 'PARTIALLY_REFUNDED';
  if (!allowed || input.refundAmount <= 0 || input.alreadyRefunded + input.refundAmount > input.paymentAmount) {
    return { ok: false, code: 'REFUND_NOT_ALLOWED', invoiceAmount: input.invoiceAmount };
  }
  const full = input.alreadyRefunded + input.refundAmount === input.paymentAmount;
  return {
    ok: true,
    paymentStatus: full ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
    orderStatus: full ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
    invoiceAmount: input.invoiceAmount,
    stopsService: false,
  };
}

export function classifyPaymentRevenue(input: { provider: string | null; isTestPayment: boolean; isProductionTest?: boolean; paymentStatus: string; orderStatus: string; amount: number }): { bucket: 'test' | 'real' | 'none'; amount: number } {
  const settled = input.paymentStatus === 'SUCCEEDED' && input.orderStatus === 'FULFILLED';
  if (!settled || input.isProductionTest) return { bucket: 'none', amount: 0 };
  if (input.isTestPayment || input.provider === 'MOCK') return { bucket: 'test', amount: input.amount };
  return { bucket: 'real', amount: input.amount };
}

export function safePaymentLog(input: Record<string, unknown>): Record<string, string> {
  const allow = ['provider', 'eventId', 'orderId', 'paymentId', 'status', 'errorCode'];
  const out: Record<string, string> = {};
  for (const key of allow) {
    const value = input[key];
    if (typeof value === 'string' && value && !/secret|password|token/i.test(value)) out[key] = value;
  }
  return out;
}

export function userPaymentMessage(code: string): string {
  return PAYMENT_ERROR_COPY[code] ?? '支付没有完成，请稍后查看账单';
}

export function nextInvoiceNumber(existing: string[], now: Date): string {
  const prefix = `INV-${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}-`;
  const seq = existing.filter((value) => value.startsWith(prefix)).length + 1;
  return `${prefix}${String(seq).padStart(6, '0')}`;
}
