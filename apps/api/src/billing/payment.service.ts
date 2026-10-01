import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import {
  canReviewUpgrade,
  createMockCheckout,
  applyWebhookEvent,
  mockPaymentsEnabled,
  mockWebhookSecret,
  reconcilePayments,
  recordRefund,
  signMockWebhook,
  userPaymentMessage,
  classifyPaymentRevenue,
} from '@launchos/domain';
import { PrismaService } from '../database/prisma.service';
import { SubscriptionService } from './subscription.service';
import { AlipayPaymentService } from './alipay-payment.service';

const STATUS_LABEL: Record<string, string> = {
  DRAFT: '草稿',
  PENDING_PAYMENT: '待支付',
  PAID: '已付款',
  FULFILLING: '开通中',
  FULFILLED: '已完成',
  PAYMENT_FAILED: '支付失败',
  CANCELED: '已取消',
  EXPIRED: '已过期',
  REFUNDED: '已退款',
  PARTIALLY_REFUNDED: '部分退款',
  PENDING: '待支付',
  PROCESSING: '处理中',
  SUCCEEDED: '支付成功',
  FAILED: '支付失败',
  REQUIRES_REVIEW: '待核对',
};

@Injectable()
export class PaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionService,
    private readonly alipay: AlipayPaymentService,
  ) {}

  async checkout(adminId: string, orderId: string, body: { amount?: number; currency?: string }) {
    await this.requireAdmin(adminId);
    this.ensureMock();
    const result = await createMockCheckout(this.prisma, {
      orderId,
      actorId: adminId,
      clientAmount: body.amount,
      clientCurrency: body.currency,
    });
    if (!result.ok)
      throw new BadRequestException({
        code: result.code,
        message: userPaymentMessage(result.code),
      });
    return {
      paymentId: result.payment.id,
      orderId,
      provider: 'MOCK',
      checkoutId: result.payment.providerCheckoutId,
      status: 'PENDING',
      orderStatus: 'PENDING_PAYMENT',
      amount: result.chargedAmount,
      currency: result.payment.currency,
      isTestPayment: true,
    };
  }

  async webhook(provider: string, rawBody: string, timestamp: string, signature: string) {
    if (provider === 'alipay')
      return this.alipay.notification(JSON.parse(rawBody) as Record<string, unknown>);
    if (provider !== 'mock')
      throw new BadRequestException({
        code: 'PAYMENT_NOT_FOUND',
        message: userPaymentMessage('PAYMENT_NOT_FOUND'),
      });
    const secret = mockWebhookSecret();
    if (!secret)
      throw new ForbiddenException({
        code: 'WEBHOOK_SIGNATURE_INVALID',
        message: userPaymentMessage('WEBHOOK_SIGNATURE_INVALID'),
      });
    const result = await applyWebhookEvent(this.prisma, {
      provider: 'MOCK',
      rawBody,
      timestamp,
      signature,
      secret,
    });
    return result;
  }

  async mockAction(adminId: string, paymentId: string, action: string) {
    await this.requireAdmin(adminId);
    this.ensureMock();
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { order: true },
    });
    if (!payment || !payment.externalPaymentId)
      throw new BadRequestException({
        code: 'PAYMENT_NOT_FOUND',
        message: userPaymentMessage('PAYMENT_NOT_FOUND'),
      });
    if (action === 'arm-failure') {
      await this.prisma.commercialOrder.update({
        where: { id: payment.orderId },
        data: { fulfillmentFailOnce: true },
      });
      return { ok: true };
    }
    if (action === 'refund' || action === 'partial-refund') {
      const refunded = await recordRefund(this.prisma, {
        paymentId,
        actorId: adminId,
        amount:
          action === 'partial-refund' ? Math.max(1, Math.floor(payment.amount / 2)) : undefined,
        reason: '模拟退款',
      });
      if (!refunded.ok)
        throw new BadRequestException({
          code: refunded.code,
          message: userPaymentMessage(refunded.code),
        });
      return {
        ok: true,
        stopsService: refunded.stopsService,
        invoiceAmount: refunded.invoiceAmount,
      };
    }
    if (action === 'expire') {
      await this.prisma.commercialOrder.update({
        where: { id: payment.orderId },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
    }
    const eventType =
      action === 'fail'
        ? 'payment.failed'
        : action === 'cancel'
          ? 'payment.canceled'
          : 'payment.succeeded';
    const amount = action === 'mismatch' ? payment.amount + 1 : payment.amount;
    const currency = action === 'currency-mismatch' ? 'USD' : payment.currency;
    const externalEventId =
      action === 'duplicate'
        ? `evt_${payment.id}_dup`
        : `evt_${payment.id}_${action}_${Date.now()}`;
    const send = async (eventId: string) => {
      const raw = JSON.stringify({
        externalEventId: eventId,
        eventType,
        externalPaymentId: payment.externalPaymentId,
        amount,
        currency,
      });
      const timestamp = String(Date.now());
      const secret = mockWebhookSecret() ?? '';
      return applyWebhookEvent(this.prisma, {
        provider: 'MOCK',
        rawBody: raw,
        timestamp,
        signature: signMockWebhook(raw, timestamp, secret),
        secret,
      });
    };
    const first = await send(externalEventId);
    if (action === 'duplicate') {
      const second = await send(externalEventId);
      return { first, second };
    }
    return first;
  }

  async retry(adminId: string, paymentId: string) {
    await this.requireAdmin(adminId);
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment)
      throw new BadRequestException({
        code: 'PAYMENT_NOT_FOUND',
        message: userPaymentMessage('PAYMENT_NOT_FOUND'),
      });
    if (payment.status !== 'SUCCEEDED')
      throw new BadRequestException({
        code: 'LAST_PAYMENT_STATE_INVALID',
        message: userPaymentMessage('LAST_PAYMENT_STATE_INVALID'),
      });
    return this.subscriptions.fulfillPaidOrder(payment.orderId);
  }

  async retryWebhook(adminId: string, paymentId: string) {
    await this.requireAdmin(adminId);
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { webhooks: true },
    });
    if (!payment)
      throw new BadRequestException({
        code: 'PAYMENT_NOT_FOUND',
        message: userPaymentMessage('PAYMENT_NOT_FOUND'),
      });
    if (
      payment.status !== 'SUCCEEDED' ||
      !payment.webhooks.some((event) => event.status === 'FAILED')
    ) {
      throw new BadRequestException({
        code: 'LAST_PAYMENT_STATE_INVALID',
        message: userPaymentMessage('LAST_PAYMENT_STATE_INVALID'),
      });
    }
    return this.subscriptions.fulfillPaidOrder(payment.orderId);
  }

  async list(adminId: string, query: { q?: string; status?: string; page?: string }) {
    await this.requireAdmin(adminId);
    const page = Math.max(1, Number(query.page || 1));
    const where = {
      ...(query.status ? { status: query.status as 'PENDING' } : {}),
      ...(query.q
        ? {
            OR: [
              { externalPaymentId: { contains: query.q } },
              { order: { orderNumber: { contains: query.q } } },
              { workspace: { name: { contains: query.q } } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.payment.count({ where }),
      this.prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * 20,
        take: 20,
        include: {
          order: { select: { orderNumber: true } },
          workspace: { select: { name: true } },
        },
      }),
    ]);
    return {
      page,
      total,
      items: rows.map((row) => ({
        id: row.id,
        orderNumber: row.order.orderNumber,
        workspaceName: row.workspace.name,
        provider: row.provider,
        providerLabel: row.provider === 'ALIPAY' ? '支付宝' : row.provider,
        amount: row.amount,
        currency: row.currency,
        status: row.status,
        statusLabel: STATUS_LABEL[row.status] ?? row.status,
        attemptNumber: row.attemptNumber,
        paidAt: row.paidAt,
        createdAt: row.createdAt,
        isTestPayment: row.isTestPayment,
      })),
    };
  }

  async detail(adminId: string, paymentId: string) {
    await this.requireAdmin(adminId);
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        order: { include: { invoices: true, workspace: { include: { owner: true } } } },
        webhooks: { orderBy: { receivedAt: 'desc' } },
        refunds: true,
        workspace: true,
      },
    });
    if (!payment)
      throw new BadRequestException({
        code: 'PAYMENT_NOT_FOUND',
        message: userPaymentMessage('PAYMENT_NOT_FOUND'),
      });
    const subscription = await this.prisma.subscription.findFirst({
      where: { workspaceId: payment.workspaceId },
      orderBy: { createdAt: 'desc' },
      include: { plan: true },
    });
    const revenue = classifyPaymentRevenue({
      provider: payment.provider,
      isTestPayment: payment.isTestPayment,
      isProductionTest: payment.isProductionTest,
      paymentStatus: payment.status,
      orderStatus: payment.order.status,
      amount: payment.amount,
    });
    const shown = payment.amountCents == null ? payment.amount : payment.amountCents / 100;
    return {
      payment: {
        id: payment.id,
        provider: payment.provider,
        providerLabel: payment.provider === 'ALIPAY' ? '支付宝' : payment.provider,
        amount: shown,
        currency: payment.currency,
        status: payment.status,
        statusLabel: STATUS_LABEL[payment.status] ?? payment.status,
        attemptNumber: payment.attemptNumber,
        paidAt: payment.paidAt,
        createdAt: payment.createdAt,
        failureMessageSafe: payment.failureMessageSafe,
        isTestPayment: payment.isTestPayment,
        isProductionTest: payment.isProductionTest,
        merchantOrderNo: payment.merchantOrderNo,
        providerTradeNo: payment.providerTradeNo,
        environment: payment.environment,
        lastQueryState: payment.lastQueryState,
      },
      order: {
        id: payment.order.id,
        orderNumber: payment.order.orderNumber,
        status: payment.order.status,
        statusLabel: STATUS_LABEL[payment.order.status] ?? payment.order.status,
        totalAmount: payment.order.totalAmount,
      },
      workspace: { name: payment.workspace.name },
      invoice: payment.order.invoices[0]
        ? {
            invoiceNumber: payment.order.invoices[0].invoiceNumber,
            amount: payment.order.invoices[0].amount,
          }
        : null,
      subscription: subscription
        ? { status: subscription.status, plan: subscription.plan.code, source: subscription.source }
        : null,
      webhooks: payment.webhooks.map((event) => ({
        id: event.id,
        eventType: event.eventType,
        status: event.status,
        errorCode: event.errorCode,
        receivedAt: event.receivedAt,
      })),
      refunds: payment.refunds.map((refund) => ({
        amount: refund.amount,
        status: refund.status,
        createdAt: refund.createdAt,
      })),
      reconciliation: payment.isProductionTest
        ? '生产联调，不计入正式收入'
        : revenue.bucket === 'none' && payment.status === 'SUCCEEDED'
          ? '需要重试开通'
          : '已核对',
      revenueBucket: revenue.bucket,
    };
  }

  async summary(adminId: string) {
    await this.requireAdmin(adminId);
    const rows = await this.prisma.payment.findMany({
      where: { status: 'SUCCEEDED' },
      include: { order: true },
    });
    let testRevenue = 0;
    let realRevenue = 0;
    for (const row of rows) {
      const bucket = classifyPaymentRevenue({
        provider: row.provider,
        isTestPayment: row.isTestPayment,
        isProductionTest: row.isProductionTest,
        paymentStatus: row.status,
        orderStatus: row.order.status,
        amount: row.amount,
      });
      if (bucket.bucket === 'test') testRevenue += bucket.amount;
      if (bucket.bucket === 'real') realRevenue += bucket.amount;
    }
    return { testRevenue, realRevenue };
  }

  async reconcile(adminId: string) {
    await this.requireAdmin(adminId);
    const report = await reconcilePayments(this.prisma, new Date(), (payment) =>
      this.alipay.lookup(payment),
    );
    return report;
  }

  async historyForWorkspace(workspaceId: string) {
    const orders = await this.prisma.commercialOrder.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { payments: true, invoices: true, refunds: true, plan: { select: { name: true } } },
    });
    return orders.map((order) => ({
      orderNumber: order.orderNumber,
      status: order.status,
      statusLabel: STATUS_LABEL[order.status] ?? order.status,
      totalAmount: order.totalAmount,
      totalAmountCents: order.totalAmountCents,
      currency: order.currency,
      createdAt: order.createdAt,
      billingInterval: order.billingInterval,
      planName: order.plan?.name ?? null,
      payments: order.payments.map((payment) => ({
        status: payment.status,
        statusLabel: STATUS_LABEL[payment.status] ?? payment.status,
        paidAt: payment.paidAt,
        attemptNumber: payment.attemptNumber,
      })),
      invoiceNumber: order.invoices[0]?.invoiceNumber ?? null,
      refunds: order.refunds.map((refund) => ({
        amount: refund.amount,
        statusLabel: STATUS_LABEL[refund.status] ?? refund.status,
      })),
    }));
  }

  private ensureMock() {
    if (!mockPaymentsEnabled()) throw new ForbiddenException('当前环境不能使用模拟支付');
  }

  private async requireAdmin(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { platformRole: true },
    });
    if (!canReviewUpgrade(user?.platformRole ?? 'USER'))
      throw new ForbiddenException('需要平台管理员权限');
  }
}
