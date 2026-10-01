import { Prisma, PrismaClient, SubscriptionStatus } from '@launchos/database';
import { decideActivate } from './subscription-operations';
import { buildInvoiceSnapshot } from './commercial-readiness';
import { fulfillmentSourceForPayment, providerAmountMatches, subscriptionChargeCents, buildMerchantOrderNo } from './alipay-readiness';
import {
  decideVerifiedPayment,
  lockOrderAmount,
  nextInvoiceNumber,
  parseProviderEvent,
  payloadHash,
  safePaymentLog,
  verifyMockWebhook,
  applyRefundDecision,
} from './payment-readiness';

type ApplyResult = { httpStatus: number; status: string; code?: string; orderId?: string; paymentId?: string };

function logPayment(fields: Record<string, unknown>) {
  const safe = safePaymentLog(fields);
  console.log(`payment ${safe.status ?? ''} ${safe.errorCode ?? ''}`.trim());
}

async function audit(prisma: PrismaClient, workspaceId: string, userId: string | null, action: string, metadata: Record<string, string | number | boolean | null>) {
  let actorId = userId;
  if (!actorId) {
    const admin = await prisma.user.findFirst({ where: { platformRole: 'PLATFORM_ADMIN', accountStatus: 'ACTIVE' }, select: { id: true } });
    actorId = admin?.id ?? null;
  }
  if (!actorId) return;
  await prisma.auditLog.create({
    data: { workspaceId, userId: actorId, action, metadata: metadata as Prisma.InputJsonValue },
  });
}

export async function createMockCheckout(prisma: PrismaClient, input: { orderId: string; actorId: string; clientAmount?: number | null; clientCurrency?: string | null }) {
  const order = await prisma.commercialOrder.findUnique({
    where: { id: input.orderId },
    include: { plan: true, planVersion: true, payments: true },
  });
  if (!order || !order.plan) return { ok: false as const, code: 'PAYMENT_NOT_FOUND' };
  if (order.payments.some((payment) => payment.status === 'SUCCEEDED')) return { ok: false as const, code: 'ORDER_ALREADY_PAID' };
  if (order.expiresAt && order.expiresAt.getTime() <= Date.now() && order.status !== 'DRAFT') return { ok: false as const, code: 'ORDER_EXPIRED' };
  if (order.status !== 'DRAFT' && order.status !== 'PAYMENT_FAILED') return { ok: false as const, code: 'LAST_PAYMENT_STATE_INVALID' };
  const fee = order.amountLockedAt
    ? order.subscriptionFee
    : order.billingInterval === 'yearly'
      ? (order.planVersion?.priceYearly ?? order.plan.priceYearly)
      : (order.planVersion?.priceMonthly ?? order.plan.priceMonthly);
  if (fee == null || order.plan.contactSales) return { ok: false as const, code: 'LAST_PAYMENT_STATE_INVALID' };
  const locked = lockOrderAmount({
    subscriptionFee: fee,
    discountAmount: order.discountAmount,
    taxAmount: order.taxAmount,
    currency: order.planVersion?.currency || order.currency,
    clientAmount: input.clientAmount,
    clientCurrency: input.clientCurrency,
  });
  const active = order.payments.find((payment) => payment.status === 'PENDING' || payment.status === 'PROCESSING');
  if (active) return { ok: true as const, payment: active, order, chargedAmount: locked.totalAmount, ignoredClientAmount: locked.ignoredClientAmount };
  const attemptNumber = order.payments.reduce((max, payment) => Math.max(max, payment.attemptNumber), 0) + 1;
  const externalPaymentId = `mock_pay_${order.id.slice(-6)}_${attemptNumber}`;
  const providerCheckoutId = `mock_chk_${order.id.slice(-6)}_${attemptNumber}`;
  const payment = await prisma.payment.create({
    data: {
      workspaceId: order.workspaceId,
      orderId: order.id,
      provider: 'MOCK',
      externalPaymentId,
      providerCheckoutId,
      amount: locked.totalAmount,
      currency: locked.currency,
      status: 'PENDING',
      attemptNumber,
      isTestPayment: true,
    },
  });
  await prisma.commercialOrder.update({
    where: { id: order.id },
    data: {
      status: 'PENDING_PAYMENT',
      subscriptionFee: locked.subscriptionFee,
      discountAmount: locked.discountAmount,
      taxAmount: locked.taxAmount,
      totalAmount: locked.totalAmount,
      currency: locked.currency,
      amountLockedAt: order.amountLockedAt ?? new Date(),
    },
  });
  await audit(prisma, order.workspaceId, input.actorId, 'PAYMENT_CHECKOUT_CREATED', {
    orderId: order.id,
    paymentId: payment.id,
    provider: 'MOCK',
    amount: locked.totalAmount,
    currency: locked.currency,
  });
  return { ok: true as const, payment, chargedAmount: locked.totalAmount, ignoredClientAmount: locked.ignoredClientAmount };
}

export async function createAlipayCheckout(prisma: PrismaClient, input: { orderId: string; actorId: string; environment: 'SANDBOX' | 'PRODUCTION'; isTestPayment: boolean; isProductionTest?: boolean; clientAmount?: number | null }) {
  const order = await prisma.commercialOrder.findUnique({ where: { id: input.orderId }, include: { plan: true, planVersion: true, payments: true } });
  if (!order || !order.plan) return { ok: false as const, code: 'PAYMENT_NOT_FOUND' };
  if (order.payments.some((payment) => payment.status === 'SUCCEEDED')) return { ok: false as const, code: 'ORDER_ALREADY_PAID' };
  if (order.expiresAt && order.expiresAt.getTime() <= Date.now() && order.status !== 'DRAFT') return { ok: false as const, code: 'ORDER_EXPIRED' };
  if (order.status !== 'DRAFT' && order.status !== 'PAYMENT_FAILED') return { ok: false as const, code: 'LAST_PAYMENT_STATE_INVALID' };
  const active = order.payments.find((payment) => (payment.status === 'PENDING' || payment.status === 'PROCESSING') && payment.provider === 'ALIPAY');
  if (active?.merchantOrderNo) return { ok: true as const, payment: active, chargedAmount: active.amountCents != null ? active.amountCents / 100 : active.amount, amountCents: active.amountCents ?? active.amount * 100, merchantOrderNo: active.merchantOrderNo, ignoredClientAmount: false };
  const productionTest = input.isProductionTest === true;
  if (productionTest && (order.plan.code !== 'PAYMENT_TEST' || order.plan.status !== 'INTERNAL_TEST')) return { ok: false as const, code: 'ALIPAY_PRODUCTION_TEST_PLAN' };
  if (!productionTest && order.plan.code === 'PAYMENT_TEST') return { ok: false as const, code: 'ALIPAY_PRODUCTION_TEST_DISABLED' };
  const testCents = productionTest ? (order.planVersion?.priceMonthlyCents ?? order.plan.priceMonthlyCents) : null;
  const fee = order.amountLockedAt ? order.subscriptionFee : order.billingInterval === 'yearly' ? (order.planVersion?.priceYearly ?? order.plan.priceYearly) : (order.planVersion?.priceMonthly ?? order.plan.priceMonthly);
  if (!productionTest && (fee == null || order.plan.contactSales)) return { ok: false as const, code: 'LAST_PAYMENT_STATE_INVALID' };
  if (productionTest && testCents !== 90) return { ok: false as const, code: 'ALIPAY_PRODUCTION_TEST_PLAN' };
  const charge = productionTest
    ? { cents: 90, yuan: 0, ignoredClientAmount: input.clientAmount != null && Math.round(input.clientAmount * 100) !== 90, includesCloudCost: false as const }
    : subscriptionChargeCents({ subscriptionFee: fee ?? 0, discountAmount: order.discountAmount, taxAmount: order.taxAmount, cloudCostEstimate: order.cloudCostEstimate, clientAmount: input.clientAmount });
  const attemptNumber = order.payments.reduce((max, payment) => Math.max(max, payment.attemptNumber), 0) + 1;
  let merchantOrderNo = buildMerchantOrderNo(new Date());
  const taken = await prisma.payment.findUnique({ where: { merchantOrderNo } });
  if (taken) merchantOrderNo = buildMerchantOrderNo(new Date());
  const payment = await prisma.payment.create({
    data: {
      workspaceId: order.workspaceId,
      orderId: order.id,
      provider: 'ALIPAY',
      merchantOrderNo,
      providerCheckoutId: merchantOrderNo,
      amount: productionTest ? 0 : charge.yuan,
      amountCents: productionTest ? charge.cents : null,
      currency: order.planVersion?.currency || order.currency,
      status: 'PENDING',
      attemptNumber,
      isTestPayment: input.isTestPayment,
      isProductionTest: productionTest,
      environment: input.environment,
    },
  });
  await prisma.commercialOrder.update({
    where: { id: order.id },
    data: {
      status: 'PENDING_PAYMENT',
      subscriptionFee: productionTest ? 0 : fee,
      discountAmount: order.discountAmount,
      taxAmount: order.taxAmount,
      totalAmount: productionTest ? 0 : charge.yuan,
      totalAmountCents: productionTest ? charge.cents : null,
      currency: order.planVersion?.currency || order.currency,
      amountLockedAt: order.amountLockedAt ?? new Date(),
    },
  });
  await audit(prisma, order.workspaceId, input.actorId, 'ALIPAY_CHECKOUT_CREATED', { orderId: order.id, paymentId: payment.id, provider: 'ALIPAY', amount: productionTest ? charge.cents : charge.yuan, currency: payment.currency, productionTest });
  return { ok: true as const, payment, chargedAmount: productionTest ? charge.cents / 100 : charge.yuan, amountCents: productionTest ? charge.cents : charge.yuan * 100, merchantOrderNo, ignoredClientAmount: charge.ignoredClientAmount };
}

export async function applyWebhookEvent(prisma: PrismaClient, input: {
  provider: string;
  rawBody: string;
  timestamp?: string;
  signature?: string;
  secret?: string;
  now?: Date;
  verified?: {
    eventName: 'PAYMENT_SUCCEEDED' | 'PAYMENT_FAILED' | 'PAYMENT_CANCELED' | 'REFUND_SUCCEEDED' | 'REFUND_FAILED';
    externalEventId: string;
    externalPaymentId?: string | null;
    merchantOrderNo?: string | null;
    amountCents: number;
    currency: string;
    providerTradeNo?: string | null;
    expectedAppId?: string | null;
    actualAppId?: string | null;
  };
}): Promise<ApplyResult> {
  if (input.verified) return applyNormalizedNotification(prisma, input.provider, input.rawBody, input.verified, input.now);
  const verified = verifyMockWebhook({ payload: input.rawBody, timestamp: input.timestamp ?? '', signature: input.signature ?? '', secret: input.secret ?? '', now: input.now?.getTime() });
  if (!verified.ok) return { httpStatus: 400, status: 'FAILED', code: verified.code };
  let body: { externalEventId?: string; eventType?: string; type?: string; externalPaymentId?: string; amount?: number; currency?: string };
  try {
    body = JSON.parse(input.rawBody) as typeof body;
  } catch {
    return { httpStatus: 400, status: 'FAILED', code: 'WEBHOOK_SIGNATURE_INVALID' };
  }
  const eventName = parseProviderEvent(String(body.eventType || body.type || ''));
  const externalEventId = String(body.externalEventId || '');
  if (!eventName || !externalEventId) return { httpStatus: 400, status: 'FAILED', code: 'WEBHOOK_SIGNATURE_INVALID' };
  try {
    await prisma.paymentWebhookEvent.create({
      data: {
        provider: input.provider,
        externalEventId,
        eventType: eventName,
        payloadHash: payloadHash(input.rawBody),
        status: 'RECEIVED',
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return { httpStatus: 200, status: 'IGNORED_DUPLICATE', code: 'WEBHOOK_DUPLICATE' };
    }
    throw error;
  }
  const payment = body.externalPaymentId
    ? await prisma.payment.findFirst({ where: { provider: input.provider, externalPaymentId: body.externalPaymentId }, include: { order: { include: { payments: true } } } })
    : null;
  if (!payment) {
    await prisma.paymentWebhookEvent.update({ where: { provider_externalEventId: { provider: input.provider, externalEventId } }, data: { status: 'FAILED', errorCode: 'PAYMENT_NOT_FOUND', processedAt: new Date() } });
    return { httpStatus: 200, status: 'FAILED', code: 'PAYMENT_NOT_FOUND' };
  }
  logPayment({ provider: input.provider, eventId: externalEventId, orderId: payment.orderId, paymentId: payment.id, status: 'RECEIVED' });
  if (eventName === 'REFUND_SUCCEEDED' || eventName === 'REFUND_FAILED') {
    await prisma.paymentWebhookEvent.update({ where: { provider_externalEventId: { provider: input.provider, externalEventId } }, data: { status: 'PROCESSED', paymentId: payment.id, processedAt: new Date() } });
    return { httpStatus: 200, status: 'PROCESSED', paymentId: payment.id, orderId: payment.orderId };
  }
  const decision = decideVerifiedPayment({
    event: eventName,
    paymentStatus: payment.status,
    orderStatus: payment.order.status,
    orderAmount: payment.order.totalAmount ?? payment.amount,
    orderCurrency: payment.order.currency,
    providerAmount: Number(body.amount),
    providerCurrency: String(body.currency || ''),
    expiresAt: payment.order.expiresAt?.toISOString() ?? null,
    now: (input.now ?? new Date()).toISOString(),
    hasSucceededPayment: payment.order.payments.some((item) => item.status === 'SUCCEEDED'),
  });
  if (decision.action === 'ignore_paid') {
    await prisma.paymentWebhookEvent.update({ where: { provider_externalEventId: { provider: input.provider, externalEventId } }, data: { status: 'IGNORED', errorCode: decision.code, paymentId: payment.id, processedAt: new Date() } });
    return { httpStatus: 200, status: 'IGNORED_DUPLICATE', code: decision.code, paymentId: payment.id, orderId: payment.orderId };
  }
  if (decision.action === 'review') {
    await prisma.payment.update({ where: { id: payment.id }, data: { status: 'REQUIRES_REVIEW', failureCode: decision.code, failureMessageSafe: decision.code === 'PAYMENT_AMOUNT_MISMATCH' ? '金额不一致' : decision.code === 'PAYMENT_CURRENCY_MISMATCH' ? '币种不一致' : '订单已过期' } });
    await audit(prisma, payment.workspaceId, null, 'PAYMENT_REQUIRES_REVIEW', { paymentId: payment.id, orderId: payment.orderId, errorCode: decision.code ?? '' });
    await prisma.paymentWebhookEvent.update({ where: { provider_externalEventId: { provider: input.provider, externalEventId } }, data: { status: 'PROCESSED', errorCode: decision.code, paymentId: payment.id, processedAt: new Date() } });
    return { httpStatus: 200, status: 'REQUIRES_REVIEW', code: decision.code, paymentId: payment.id, orderId: payment.orderId };
  }
  if (decision.action === 'fail' || decision.action === 'cancel') {
    await prisma.payment.update({ where: { id: payment.id }, data: { status: decision.paymentStatus as 'FAILED' | 'CANCELED', failedAt: new Date(), failureCode: decision.action === 'fail' ? 'PAYMENT_FAILED' : 'PAYMENT_CANCELED' } });
    await prisma.commercialOrder.update({ where: { id: payment.orderId }, data: { status: decision.orderStatus as 'PAYMENT_FAILED' | 'CANCELED' } });
    await audit(prisma, payment.workspaceId, null, decision.action === 'fail' ? 'PAYMENT_FAILED' : 'PAYMENT_CHECKOUT_CREATED', { paymentId: payment.id, orderId: payment.orderId, status: decision.paymentStatus ?? '' });
    await prisma.paymentWebhookEvent.update({ where: { provider_externalEventId: { provider: input.provider, externalEventId } }, data: { status: 'PROCESSED', paymentId: payment.id, processedAt: new Date() } });
    return { httpStatus: 200, status: 'PROCESSED', code: decision.action === 'fail' ? 'PAYMENT_FAILED' : 'PAYMENT_CANCELED', paymentId: payment.id, orderId: payment.orderId };
  }
  await prisma.payment.update({ where: { id: payment.id }, data: { status: 'SUCCEEDED', paidAt: new Date(), failureCode: null } });
  await prisma.commercialOrder.update({ where: { id: payment.orderId }, data: { status: 'PAID' } });
  await audit(prisma, payment.workspaceId, null, 'PAYMENT_SUCCEEDED', { paymentId: payment.id, orderId: payment.orderId, provider: 'MOCK' });
  const fulfilled = await fulfillCommercialOrder(prisma, payment.orderId, null);
  await prisma.paymentWebhookEvent.update({
    where: { provider_externalEventId: { provider: input.provider, externalEventId } },
    data: { status: fulfilled.ok ? 'PROCESSED' : 'FAILED', errorCode: fulfilled.ok ? null : fulfilled.code, paymentId: payment.id, processedAt: new Date() },
  });
  return { httpStatus: 200, status: fulfilled.ok ? 'PROCESSED' : 'FULFILLMENT_FAILED', code: fulfilled.ok ? undefined : fulfilled.code, paymentId: payment.id, orderId: payment.orderId };
}

async function applyNormalizedNotification(prisma: PrismaClient, provider: string, rawBody: string, verified: NonNullable<Parameters<typeof applyWebhookEvent>[1]['verified']>, now?: Date): Promise<ApplyResult> {
  const eventName = verified.eventName;
  const externalEventId = verified.externalEventId;
  try {
    await prisma.paymentWebhookEvent.create({
      data: { provider, externalEventId, eventType: eventName, payloadHash: payloadHash(rawBody), status: 'RECEIVED' },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return { httpStatus: 200, status: 'IGNORED_DUPLICATE', code: 'WEBHOOK_DUPLICATE' };
    }
    throw error;
  }
  const payment = verified.merchantOrderNo
    ? await prisma.payment.findFirst({ where: { merchantOrderNo: verified.merchantOrderNo }, include: { order: { include: { payments: true } } } })
    : verified.externalPaymentId
      ? await prisma.payment.findFirst({ where: { provider, externalPaymentId: verified.externalPaymentId }, include: { order: { include: { payments: true } } } })
      : null;
  if (!payment) {
    await prisma.paymentWebhookEvent.update({ where: { provider_externalEventId: { provider, externalEventId } }, data: { status: 'FAILED', errorCode: 'PAYMENT_NOT_FOUND', processedAt: new Date() } });
    return { httpStatus: 200, status: 'FAILED', code: 'PAYMENT_NOT_FOUND' };
  }
  logPayment({ provider, eventId: externalEventId, orderId: payment.orderId, paymentId: payment.id, status: 'RECEIVED' });
  if (eventName === 'REFUND_SUCCEEDED' || eventName === 'REFUND_FAILED') {
    await prisma.paymentWebhookEvent.update({ where: { provider_externalEventId: { provider, externalEventId } }, data: { status: 'PROCESSED', paymentId: payment.id, processedAt: new Date() } });
    return { httpStatus: 200, status: 'PROCESSED', paymentId: payment.id, orderId: payment.orderId };
  }
  const orderAmount = payment.order.totalAmount ?? payment.amount;
  const expectedCents = payment.amountCents ?? payment.order.totalAmountCents;
  const amountMatches = providerAmountMatches(orderAmount, verified.amountCents, expectedCents);
  const sellerMismatch = Boolean(verified.expectedAppId && verified.actualAppId && verified.expectedAppId !== verified.actualAppId);
  const decision = decideVerifiedPayment({
    event: eventName,
    paymentStatus: payment.status,
    orderStatus: payment.order.status,
    orderAmount,
    orderCurrency: payment.order.currency,
    providerAmount: sellerMismatch || !amountMatches ? orderAmount + 1 : orderAmount,
    providerCurrency: verified.currency || payment.currency,
    expiresAt: payment.order.expiresAt?.toISOString() ?? null,
    now: (now ?? new Date()).toISOString(),
    hasSucceededPayment: payment.order.payments.some((item) => item.status === 'SUCCEEDED'),
  });
  const reviewCode = sellerMismatch ? 'SELLER_MISMATCH' : decision.code;
  if (decision.action === 'ignore_paid') {
    await prisma.paymentWebhookEvent.update({ where: { provider_externalEventId: { provider, externalEventId } }, data: { status: 'IGNORED', errorCode: decision.code, paymentId: payment.id, processedAt: new Date() } });
    return { httpStatus: 200, status: 'IGNORED_DUPLICATE', code: decision.code, paymentId: payment.id, orderId: payment.orderId };
  }
  if (decision.action === 'review' || sellerMismatch) {
    await prisma.payment.update({ where: { id: payment.id }, data: { status: 'REQUIRES_REVIEW', failureCode: reviewCode, failureMessageSafe: '支付信息与订单不一致，已转人工核对', providerTradeNo: verified.providerTradeNo ?? payment.providerTradeNo } });
    await audit(prisma, payment.workspaceId, null, provider === 'ALIPAY' ? 'ALIPAY_NOTIFICATION_REJECTED' : 'PAYMENT_REQUIRES_REVIEW', { paymentId: payment.id, orderId: payment.orderId, errorCode: reviewCode ?? '' });
    await prisma.paymentWebhookEvent.update({ where: { provider_externalEventId: { provider, externalEventId } }, data: { status: 'PROCESSED', errorCode: reviewCode, paymentId: payment.id, processedAt: new Date() } });
    return { httpStatus: 200, status: 'REQUIRES_REVIEW', code: reviewCode, paymentId: payment.id, orderId: payment.orderId };
  }
  if (decision.action === 'fail' || decision.action === 'cancel') {
    await prisma.payment.update({ where: { id: payment.id }, data: { status: decision.paymentStatus as 'FAILED' | 'CANCELED', failedAt: new Date(), failureCode: decision.action === 'fail' ? 'PAYMENT_FAILED' : 'PAYMENT_CANCELED' } });
    await prisma.commercialOrder.update({ where: { id: payment.orderId }, data: { status: decision.orderStatus as 'PAYMENT_FAILED' | 'CANCELED' } });
    await audit(prisma, payment.workspaceId, null, decision.action === 'fail' ? 'PAYMENT_FAILED' : 'PAYMENT_CHECKOUT_CREATED', { paymentId: payment.id, orderId: payment.orderId, status: decision.paymentStatus ?? '' });
    await prisma.paymentWebhookEvent.update({ where: { provider_externalEventId: { provider, externalEventId } }, data: { status: 'PROCESSED', paymentId: payment.id, processedAt: new Date() } });
    return { httpStatus: 200, status: 'PROCESSED', code: decision.action === 'fail' ? 'PAYMENT_FAILED' : 'PAYMENT_CANCELED', paymentId: payment.id, orderId: payment.orderId };
  }
  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      status: 'SUCCEEDED',
      paidAt: new Date(),
      failureCode: null,
      providerTradeNo: verified.providerTradeNo ?? payment.providerTradeNo,
      externalPaymentId: verified.providerTradeNo ?? payment.externalPaymentId,
      lastQueryState: 'SUCCEEDED',
    },
  });
  await prisma.commercialOrder.update({ where: { id: payment.orderId }, data: { status: 'PAID' } });
  await audit(prisma, payment.workspaceId, null, provider === 'ALIPAY' ? 'ALIPAY_NOTIFICATION_VERIFIED' : 'PAYMENT_SUCCEEDED', { paymentId: payment.id, orderId: payment.orderId, provider });
  const fulfilled = await fulfillCommercialOrder(prisma, payment.orderId, null);
  await prisma.paymentWebhookEvent.update({
    where: { provider_externalEventId: { provider, externalEventId } },
    data: { status: fulfilled.ok ? 'PROCESSED' : 'FAILED', errorCode: fulfilled.ok ? null : fulfilled.code, paymentId: payment.id, processedAt: new Date() },
  });
  return { httpStatus: 200, status: fulfilled.ok ? 'PROCESSED' : 'FULFILLMENT_FAILED', code: fulfilled.ok ? undefined : fulfilled.code, paymentId: payment.id, orderId: payment.orderId };
}

export async function fulfillCommercialOrder(prisma: PrismaClient, orderId: string, actorId: string | null): Promise<{ ok: true; status: string; invoiceId?: string; idempotent?: boolean } | { ok: false; code: string; paymentStatus?: string; orderStatus?: string }> {
  const order = await prisma.commercialOrder.findUnique({
    where: { id: orderId },
    include: { payments: true, planVersion: true, workspace: { include: { billingProfile: true } } },
  });
  if (!order) return { ok: false, code: 'PAYMENT_NOT_FOUND' };
  const existingInvoice = await prisma.invoice.findFirst({ where: { commercialOrderId: order.id } });
  if (order.status === 'FULFILLED') {
    if (existingInvoice) return { ok: true, status: 'FULFILLED', invoiceId: existingInvoice.id, idempotent: true };
    await prisma.commercialOrder.update({ where: { id: order.id }, data: { status: 'FULFILLING', fulfillmentLockedAt: null } });
  }
  const payment = order.payments.find((item) => item.status === 'SUCCEEDED');
  if (!payment) return { ok: false, code: 'PAYMENT_NOT_FOUND' };
  if (order.fulfillmentFailOnce) {
    await prisma.commercialOrder.update({ where: { id: order.id }, data: { status: 'FULFILLING', fulfillmentFailOnce: false, fulfillmentLockedAt: null } });
    await audit(prisma, order.workspaceId, actorId, 'ORDER_FULFILLMENT_FAILED', { orderId: order.id, paymentId: payment.id, errorCode: 'FULFILLMENT_FAILED' });
    return { ok: false, code: 'FULFILLMENT_FAILED', paymentStatus: 'SUCCEEDED', orderStatus: 'FULFILLING' };
  }
  const stale = new Date(Date.now() - 2 * 60 * 1000);
  const locked = await prisma.commercialOrder.updateMany({
    where: { id: order.id, status: { in: ['PAID', 'FULFILLING'] }, OR: [{ fulfillmentLockedAt: null }, { fulfillmentLockedAt: { lt: stale } }] },
    data: { status: 'FULFILLING', fulfillmentLockedAt: new Date() },
  });
  if (locked.count === 0 && order.status !== 'FULFILLED') {
    const current = await prisma.commercialOrder.findUnique({ where: { id: order.id } });
    if (current?.status === 'FULFILLED') return fulfillCommercialOrder(prisma, orderId, actorId);
    return { ok: true, status: current?.status ?? 'FULFILLING' };
  }
  await audit(prisma, order.workspaceId, actorId, 'ORDER_FULFILLMENT_STARTED', { orderId: order.id, paymentId: payment.id });
  try {
    const invoiceId = await prisma.$transaction(async (tx) => {
      const subscription = await tx.subscription.findFirst({ where: { workspaceId: order.workspaceId }, orderBy: { createdAt: 'desc' }, include: { workspace: true } });
      if (!subscription || !order.planId) throw new Error('FULFILLMENT_FAILED');
      const key = `order-fulfill:${order.id}`;
      const seen = await tx.subscriptionEvent.findUnique({ where: { idempotencyKey: key } });
      const source = fulfillmentSourceForPayment(payment);
      if (!seen) {
        const decision = decideActivate({ actorIsAdmin: true, now: new Date(), timeZone: subscription.workspace.timezone || 'Asia/Shanghai' });
        if (!decision.ok) throw new Error('FULFILLMENT_FAILED');
        await tx.subscription.update({
          where: { id: subscription.id },
          data: {
            planId: order.planId,
            planVersionId: order.planVersionId,
            status: SubscriptionStatus.ACTIVE,
            source: source.source,
            activationSource: source.activationSource,
            paymentStatus: source.paymentStatus,
            currentPeriodStart: new Date(decision.value.currentPeriodStart),
            currentPeriodEnd: new Date(decision.value.currentPeriodEnd),
            manualAutoExtension: false,
            cancelAtPeriodEnd: false,
            pendingPlanId: null,
            planChangeEffectiveAt: null,
          },
        });
        await tx.subscriptionEvent.create({
          data: {
            workspaceId: order.workspaceId,
            subscriptionId: subscription.id,
            eventType: 'SUBSCRIPTION_ACTIVATED',
            fromPlanId: subscription.planId,
            toPlanId: order.planId,
            effectiveAt: new Date(),
            actorUserId: actorId,
            source: source.source,
            metadataSafe: { orderId: order.id, paymentId: payment.id },
            idempotencyKey: key,
          },
        });
      }
      const already = await tx.invoice.findFirst({ where: { commercialOrderId: order.id } });
      if (already) {
        await tx.commercialOrder.update({ where: { id: order.id }, data: { status: 'FULFILLED', fulfilledAt: new Date(), fulfillmentLockedAt: null } });
        return already.id;
      }
      const numbers = await tx.invoice.findMany({ where: { invoiceNumber: { not: null } }, select: { invoiceNumber: true } });
      const invoiceNumber = nextInvoiceNumber(numbers.map((item) => item.invoiceNumber || ''), new Date());
      const profile = order.workspace.billingProfile;
      const snapshot = buildInvoiceSnapshot({
        billingProfile: {
          billingName: profile?.billingName ?? null,
          billingEmail: profile?.billingEmail ?? null,
          companyName: profile?.companyName ?? null,
          taxId: profile?.taxId ?? null,
        },
        planVersion: {
          id: order.planVersion?.id ?? order.planVersionId ?? order.planId,
          version: order.planVersion?.version ?? 0,
          priceMonthly: order.planVersion?.priceMonthly ?? order.subscriptionFee ?? 0,
          priceYearly: order.planVersion?.priceYearly ?? null,
          limitsJson: order.planVersion?.limitsJson ?? {},
          featuresJson: order.planVersion?.featuresJson ?? {},
        },
        subscriptionAmount: order.subscriptionFee,
        cloudResourceAmount: null,
        discountAmount: order.discountAmount,
        taxAmount: order.taxAmount,
        currency: order.currency,
      });
      const periodStart = subscription.currentPeriodStart;
      const periodEnd = subscription.currentPeriodEnd;
      const invoice = await tx.invoice.create({
        data: {
          workspaceId: order.workspaceId,
          subscriptionId: subscription.id,
          amount: order.totalAmount ?? order.subscriptionFee ?? 0,
          currency: order.currency,
          status: 'PAID',
          periodStart,
          periodEnd,
          source: source.invoiceSource,
          planId: order.planId,
          planVersionId: order.planVersionId,
          invoiceNumber,
          billingProfileSnapshot: snapshot.billingProfileSnapshot as Prisma.InputJsonValue,
          planVersionSnapshot: snapshot.planVersionSnapshot as Prisma.InputJsonValue,
          subscriptionAmount: snapshot.subscriptionAmount,
          cloudResourceAmount: snapshot.cloudResourceAmount,
          discountAmount: snapshot.discountAmount,
          taxAmount: snapshot.taxAmount,
          totalAmount: order.totalAmount,
          amountCents: payment.amountCents,
          productionTest: payment.isProductionTest,
          commercialOrderId: order.id,
        },
      });
      await tx.commercialOrder.update({ where: { id: order.id }, data: { status: 'FULFILLED', fulfilledAt: new Date(), fulfillmentLockedAt: null } });
      return invoice.id;
    });
    await audit(prisma, order.workspaceId, actorId, 'ORDER_FULFILLED', { orderId: order.id, paymentId: payment.id });
    return { ok: true, status: 'FULFILLED', invoiceId };
  } catch {
    await prisma.commercialOrder.update({ where: { id: order.id }, data: { status: 'FULFILLING', fulfillmentLockedAt: null } });
    await audit(prisma, order.workspaceId, actorId, 'ORDER_FULFILLMENT_FAILED', { orderId: order.id, paymentId: payment.id, errorCode: 'FULFILLMENT_FAILED' });
    logPayment({ provider: 'MOCK', orderId: order.id, paymentId: payment.id, status: 'FULFILLMENT_FAILED', errorCode: 'FULFILLMENT_FAILED' });
    return { ok: false, code: 'FULFILLMENT_FAILED', paymentStatus: payment.status, orderStatus: 'FULFILLING' };
  }
}

export async function recordRefund(prisma: PrismaClient, input: { paymentId: string; actorId: string; amount?: number; reason?: string }) {
  const payment = await prisma.payment.findUnique({ where: { id: input.paymentId }, include: { refunds: true, order: { include: { invoices: true } } } });
  if (!payment) return { ok: false as const, code: 'PAYMENT_NOT_FOUND' };
  const already = payment.refunds.filter((refund) => refund.status === 'SUCCEEDED').reduce((sum, refund) => sum + refund.amount, 0);
  const amount = input.amount ?? payment.amount - already;
  const invoiceAmount = payment.order.invoices[0]?.amount ?? payment.amount;
  const decision = applyRefundDecision({ paymentStatus: payment.status, paymentAmount: payment.amount, alreadyRefunded: already, refundAmount: amount, invoiceAmount });
  if (!decision.ok) return { ok: false as const, code: decision.code, invoiceAmount: decision.invoiceAmount };
  const refund = await prisma.refund.create({
    data: {
      paymentId: payment.id,
      orderId: payment.orderId,
      amount,
      currency: payment.currency,
      status: 'SUCCEEDED',
      reason: input.reason ?? '模拟退款',
      providerRefundId: `mock_ref_${payment.id.slice(-6)}_${already + 1}`,
      createdById: input.actorId,
      refundedAt: new Date(),
    },
  });
  await prisma.payment.update({ where: { id: payment.id }, data: { status: decision.paymentStatus as 'REFUNDED' | 'PARTIALLY_REFUNDED' } });
  await prisma.commercialOrder.update({ where: { id: payment.orderId }, data: { status: decision.orderStatus as 'REFUNDED' | 'PARTIALLY_REFUNDED' } });
  await audit(prisma, payment.workspaceId, input.actorId, 'REFUND_SUCCEEDED', { paymentId: payment.id, orderId: payment.orderId, amount, invoiceAmount });
  return { ok: true as const, refund, invoiceAmount: decision.invoiceAmount, stopsService: decision.stopsService };
}

export async function settleProviderRefund(prisma: PrismaClient, input: { paymentId: string; actorId: string | null; amount: number; amountCents?: number | null; providerRefundId: string; outcome: 'PENDING' | 'SUCCEEDED' | 'FAILED' }) {
  const payment = await prisma.payment.findUnique({ where: { id: input.paymentId }, include: { refunds: true, order: { include: { invoices: true } } } });
  if (!payment) return { ok: false as const, code: 'PAYMENT_NOT_FOUND' };
  const existing = payment.refunds.find((refund) => refund.providerRefundId === input.providerRefundId);
  const usesCents = payment.amountCents != null;
  const storedAmount = usesCents ? 0 : input.amount;
  const storedCents = usesCents ? (input.amountCents ?? 0) : null;
  if (input.outcome !== 'SUCCEEDED') {
    if (!existing) {
      await prisma.refund.create({
        data: {
          paymentId: payment.id,
          orderId: payment.orderId,
          amount: storedAmount,
          amountCents: storedCents,
          currency: payment.currency,
          status: input.outcome === 'FAILED' ? 'FAILED' : 'PENDING',
          providerRefundId: input.providerRefundId,
          createdById: input.actorId ?? undefined,
          reason: '支付宝退款',
        },
      });
    }
    await audit(prisma, payment.workspaceId, input.actorId, 'ALIPAY_REFUND_REQUESTED', { paymentId: payment.id, orderId: payment.orderId, amount: storedCents ?? input.amount, status: input.outcome });
    return { ok: true as const, status: input.outcome, stopsService: false as const, invoiceAmount: payment.order.invoices[0]?.amount ?? payment.amount };
  }
  const already = payment.refunds.filter((refund) => refund.status === 'SUCCEEDED').reduce((sum, refund) => sum + (usesCents ? refund.amountCents ?? 0 : refund.amount), 0);
  const invoiceAmount = payment.order.invoices[0]?.amount ?? payment.amount;
  const decision = applyRefundDecision({
    paymentStatus: payment.status,
    paymentAmount: usesCents ? payment.amountCents ?? 0 : payment.amount,
    alreadyRefunded: already,
    refundAmount: usesCents ? storedCents ?? 0 : input.amount,
    invoiceAmount,
  });
  if (!decision.ok) return { ok: false as const, code: decision.code, invoiceAmount };
  if (existing) {
    await prisma.refund.update({ where: { id: existing.id }, data: { status: 'SUCCEEDED', refundedAt: new Date(), amount: storedAmount, amountCents: storedCents } });
  } else {
    await prisma.refund.create({
      data: {
        paymentId: payment.id,
        orderId: payment.orderId,
        amount: storedAmount,
        amountCents: storedCents,
        currency: payment.currency,
        status: 'SUCCEEDED',
        providerRefundId: input.providerRefundId,
        createdById: input.actorId ?? undefined,
        refundedAt: new Date(),
        reason: '支付宝退款',
      },
    });
  }
  await prisma.payment.update({ where: { id: payment.id }, data: { status: decision.paymentStatus as 'REFUNDED' | 'PARTIALLY_REFUNDED' } });
  await prisma.commercialOrder.update({ where: { id: payment.orderId }, data: { status: decision.orderStatus as 'REFUNDED' | 'PARTIALLY_REFUNDED' } });
  await audit(prisma, payment.workspaceId, input.actorId, 'ALIPAY_REFUND_CONFIRMED', { paymentId: payment.id, orderId: payment.orderId, amount: input.amount, invoiceAmount });
  return { ok: true as const, status: 'SUCCEEDED' as const, stopsService: false as const, invoiceAmount: decision.invoiceAmount };
}

export async function reconcilePayments(
  prisma: PrismaClient,
  now = new Date(),
  query?: (payment: { id: string; provider: string | null; merchantOrderNo: string | null; environment: string | null; status: string; createdAt: Date; orderId: string }) => Promise<
    | null
    | { state: 'UNKNOWN_PENDING' }
    | { state: 'SUCCEEDED' | 'FAILED' | 'CANCELED' | 'PENDING'; amountCents: number; currency: string; providerTradeNo: string | null; appId: string | null; merchantOrderNo: string | null; eventId: string }
  >,
  minAgeMs = 120_000,
): Promise<{ expired: number; retried: number; repaired: number; queried: number }> {
  let queried = 0;
  if (query) {
    const staleBefore = new Date(now.getTime() - minAgeMs);
    const candidates = await prisma.payment.findMany({
      where: {
        provider: 'ALIPAY',
        OR: [
          { status: { in: ['PENDING', 'PROCESSING'] }, createdAt: { lt: staleBefore } },
          { webhooks: { some: { status: 'FAILED' } }, status: { in: ['PENDING', 'PROCESSING', 'REQUIRES_REVIEW'] } },
        ],
      },
    });
    for (const payment of candidates) {
      const result = await query(payment);
      queried += 1;
      if (!result || result.state === 'UNKNOWN_PENDING' || result.state === 'PENDING') {
        await prisma.payment.update({ where: { id: payment.id }, data: { status: payment.status === 'SUCCEEDED' ? payment.status : 'PROCESSING', lastQueryState: 'UNKNOWN_PENDING', lastQueriedAt: now } });
        continue;
      }
      const eventName = result.state === 'SUCCEEDED' ? 'PAYMENT_SUCCEEDED' : result.state === 'CANCELED' ? 'PAYMENT_CANCELED' : 'PAYMENT_FAILED';
      await applyWebhookEvent(prisma, {
        provider: 'ALIPAY',
        rawBody: result.eventId,
        verified: {
          eventName,
          externalEventId: result.eventId,
          merchantOrderNo: result.merchantOrderNo ?? payment.merchantOrderNo,
          amountCents: result.amountCents,
          currency: result.currency,
          providerTradeNo: result.providerTradeNo,
          actualAppId: result.appId,
        },
      });
      await audit(prisma, payment.workspaceId, null, 'ALIPAY_RECONCILED', { paymentId: payment.id, orderId: payment.orderId, status: result.state });
    }
  }
  const pending = await prisma.commercialOrder.findMany({ where: { status: 'PENDING_PAYMENT', expiresAt: { lt: now } }, include: { payments: true } });
  for (const order of pending) {
    const hasAlipay = order.payments.some((payment) => payment.provider === 'ALIPAY' && (payment.status === 'PENDING' || payment.status === 'PROCESSING'));
    if (hasAlipay) continue;
    await prisma.commercialOrder.update({ where: { id: order.id }, data: { status: 'EXPIRED' } });
    await prisma.payment.updateMany({ where: { orderId: order.id, status: { in: ['PENDING', 'PROCESSING'] } }, data: { status: 'CANCELED' } });
  }
  const stuck = await prisma.commercialOrder.findMany({ where: { status: { in: ['PAID', 'FULFILLING'] }, payments: { some: { status: 'SUCCEEDED' } } } });
  let retried = 0;
  for (const order of stuck) {
    const result = await fulfillCommercialOrder(prisma, order.id, null);
    if (result.ok) retried += 1;
  }
  const fulfilled = await prisma.commercialOrder.findMany({ where: { status: 'FULFILLED' }, include: { invoices: true, payments: true } });
  let repaired = 0;
  for (const order of fulfilled) {
    if (order.invoices.length === 0 && order.payments.some((payment) => payment.status === 'SUCCEEDED')) {
      const result = await fulfillCommercialOrder(prisma, order.id, null);
      if (result.ok) repaired += 1;
    }
  }
  const expired = pending.filter((order) => !order.payments.some((payment) => payment.provider === 'ALIPAY' && (payment.status === 'PENDING' || payment.status === 'PROCESSING'))).length;
  if (retried || repaired || expired || queried) {
    const sample = stuck[0] ?? fulfilled[0] ?? pending[0];
    if (sample) await audit(prisma, sample.workspaceId, null, 'PAYMENT_RECONCILED', { expired, retried, repaired, queried });
  }
  return { expired, retried, repaired, queried };
}
