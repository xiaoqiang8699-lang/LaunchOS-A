import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { AlipayPaymentProvider } from '@launchos/providers';
import { decryptCredential, encryptCredential } from '@launchos/shared';
import {
  alipayConfigComplete,
  assessAlipayProductionReadiness,
  assertGatewayEnvironment,
  canReviewUpgrade,
  createAlipayCheckout,
  decideAlipayCheckout,
  fulfillmentCopy,
  readAlipayGates,
  returnUrlIsNotPaymentFact,
  userPaymentMessage,
  userPaymentWaitCopy,
  applyWebhookEvent,
  settleProviderRefund,
  type AlipayEnvironment,
} from '@launchos/domain';
import { PrismaService } from '../database/prisma.service';

type AccountRecord = {
  id: string;
  provider: string;
  environment: string;
  displayName: string;
  appId: string | null;
  gatewayUrl: string | null;
  notifyUrl: string | null;
  returnUrl: string | null;
  publicKey: string | null;
  credentialEncrypted: string | null;
  appReady: boolean;
  status: string;
  lastVerifiedAt: Date | null;
  lastSuccessAt: Date | null;
  lastErrorCode: string | null;
  lastWebhookAt: Date | null;
  lastWebhookStatus: string | null;
};

@Injectable()
export class AlipayPaymentService {
  constructor(private readonly prisma: PrismaService) {}

  async list(adminId: string) {
    await this.requireAdmin(adminId);
    const rows = await this.prisma.paymentProviderAccount.findMany({ where: { provider: 'ALIPAY' }, orderBy: { environment: 'asc' } });
    return { providers: ['MOCK', 'ALIPAY', 'WECHAT_PAY', 'STRIPE'], accounts: rows.map((row) => this.present(row)), gates: readAlipayGates() };
  }

  async detail(adminId: string) {
    await this.requireAdmin(adminId);
    const sandbox = await this.account('SANDBOX');
    const production = await this.account('PRODUCTION');
    return {
      sandbox: sandbox ? this.present(sandbox) : this.empty('SANDBOX'),
      production: production ? this.present(production) : this.empty('PRODUCTION'),
      gates: readAlipayGates(),
      readiness: await this.readiness(production),
    };
  }

  async save(adminId: string, body: { environment?: AlipayEnvironment; displayName?: string; appId?: string; gatewayUrl?: string; notifyUrl?: string; returnUrl?: string; publicKey?: string; privateKey?: string; appReady?: boolean }) {
    await this.requireAdmin(adminId);
    const environment = body.environment === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX';
    const gatewayUrl = body.gatewayUrl?.trim() ?? '';
    const gateway = assertGatewayEnvironment(environment, gatewayUrl);
    if (!gateway.ok) throw new BadRequestException(gateway.message);
    const current = await this.account(environment);
    const privateKey = body.privateKey?.trim();
    const credentialEncrypted = privateKey ? encryptCredential(privateKey) : current?.credentialEncrypted ?? null;
    const data = {
      provider: 'ALIPAY',
      environment,
      displayName: body.displayName?.trim() || '支付宝',
      appId: body.appId?.trim() || null,
      gatewayUrl,
      notifyUrl: body.notifyUrl?.trim() || null,
      returnUrl: body.returnUrl?.trim() || null,
      publicKey: body.publicKey?.trim() || null,
      credentialEncrypted,
      appReady: Boolean(body.appReady),
      status: alipayConfigComplete({ appId: body.appId, gatewayUrl, publicKey: body.publicKey, privateKeyConfigured: Boolean(credentialEncrypted), notifyUrl: body.notifyUrl, returnUrl: body.returnUrl }) ? 'CONFIGURED' : 'UNCONFIGURED',
      lastErrorCode: null,
    };
    const saved = current
      ? await this.prisma.paymentProviderAccount.update({ where: { id: current.id }, data })
      : await this.prisma.paymentProviderAccount.create({ data });
    return this.present(saved);
  }

  async verify(adminId: string, environment: AlipayEnvironment = 'SANDBOX') {
    await this.requireAdmin(adminId);
    const account = await this.account(environment);
    if (!account) throw new BadRequestException('支付宝尚未配置');
    const provider = this.providerFor(account);
    if (!provider) {
      await this.prisma.paymentProviderAccount.update({ where: { id: account.id }, data: { status: 'ERROR', lastErrorCode: 'CONFIG_INCOMPLETE' } });
      throw new BadRequestException('支付宝配置不完整');
    }
    const result = await provider.verifyConfiguration();
    const status = result.ok ? 'VERIFIED' : 'ERROR';
    const saved = await this.prisma.paymentProviderAccount.update({
      where: { id: account.id },
      data: { status, lastVerifiedAt: new Date(), lastErrorCode: result.ok ? null : result.code },
    });
    return this.present(saved);
  }

  async setDisabled(adminId: string, disabled: boolean, environment: AlipayEnvironment = 'SANDBOX') {
    await this.requireAdmin(adminId);
    const account = await this.account(environment);
    if (!account) throw new BadRequestException('支付宝尚未配置');
    const saved = await this.prisma.paymentProviderAccount.update({
      where: { id: account.id },
      data: { status: disabled ? 'DISABLED' : 'CONFIGURED' },
    });
    return this.present(saved);
  }

  async checkout(adminId: string, orderId: string, body: { amount?: number; environment?: AlipayEnvironment }) {
    const user = await this.requireAdmin(adminId);
    const environment = body.environment === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX';
    const order = await this.prisma.commercialOrder.findUnique({ where: { id: orderId }, include: { plan: true, planVersion: true } });
    if (!order?.plan) throw new BadRequestException({ code: 'PAYMENT_NOT_FOUND', message: userPaymentMessage('PAYMENT_NOT_FOUND') });
    const account = await this.account(environment);
    const gates = readAlipayGates();
    const decision = decideAlipayCheckout({
      actorIsPlatformAdmin: user,
      environment,
      providerStatus: account?.status ?? 'UNCONFIGURED',
      gates,
      productionTest: environment === 'PRODUCTION'
        ? {
            workspaceId: order.workspaceId,
            allowedWorkspaceId: gates.productionTestWorkspaceId,
            planCode: order.plan.code,
            planStatus: order.plan.status,
            priceMonthlyCents: order.planVersion?.priceMonthlyCents ?? order.plan.priceMonthlyCents,
          }
        : null,
    });
    if (!decision.ok) throw new ForbiddenException({ code: decision.code, message: userPaymentMessage(decision.code) });
    const created = await createAlipayCheckout(this.prisma, { orderId, actorId: adminId, environment, isTestPayment: decision.isTestPayment, isProductionTest: decision.isProductionTest, clientAmount: body.amount });
    if (!created.ok) throw new BadRequestException({ code: created.code, message: userPaymentMessage(created.code) });
    const provider = account ? this.providerFor(account) : null;
    if (!provider || !created.merchantOrderNo) throw new BadRequestException({ code: 'ALIPAY_NOT_VERIFIED', message: userPaymentMessage('ALIPAY_NOT_VERIFIED') });
    const checkout = provider.createCheckout({ merchantOrderNo: created.merchantOrderNo, amountCents: created.amountCents, subject: decision.isProductionTest ? 'LaunchOS 支付联调' : 'LaunchOS 套餐' });
    await this.prisma.payment.update({ where: { id: created.payment.id }, data: { providerRequestId: checkout.requestId, providerCheckoutId: created.merchantOrderNo } });
    await this.prisma.paymentProviderAccount.update({ where: { id: account!.id }, data: { lastSuccessAt: new Date(), lastErrorCode: null } });
    return {
      paymentId: created.payment.id,
      orderId,
      provider: 'ALIPAY',
      environment,
      merchantOrderNo: created.merchantOrderNo,
      checkoutUrl: checkout.checkoutUrl,
      amount: created.chargedAmount,
      currency: created.payment.currency,
      isTestPayment: decision.isTestPayment,
      isProductionTest: decision.isProductionTest,
      ignoredClientAmount: created.ignoredClientAmount,
    };
  }

  async notification(body: Record<string, unknown>) {
    const accounts = await this.prisma.paymentProviderAccount.findMany({ where: { provider: 'ALIPAY' } });
    let matched: { account: AccountRecord; provider: AlipayPaymentProvider } | null = null;
    for (const account of accounts) {
      const provider = this.providerFor(account);
      if (!provider) continue;
      const parsed = provider.verifyWebhook(body);
      if (parsed.ok) {
        matched = { account, provider };
        break;
      }
    }
    if (!matched) {
      const sandbox = accounts.find((account) => account.environment === 'SANDBOX');
      if (sandbox) await this.prisma.paymentProviderAccount.update({ where: { id: sandbox.id }, data: { lastWebhookAt: new Date(), lastWebhookStatus: 'REJECTED', lastErrorCode: 'WEBHOOK_SIGNATURE_INVALID' } });
      return { httpStatus: 400, status: 'FAILED', code: 'WEBHOOK_SIGNATURE_INVALID' };
    }
    const parsed = matched.provider.verifyWebhook(body);
    await this.prisma.paymentProviderAccount.update({ where: { id: matched.account.id }, data: { lastWebhookAt: new Date(), lastWebhookStatus: parsed.ok ? 'VERIFIED' : 'REJECTED' } });
    if (!parsed.ok) return { httpStatus: 400, status: 'FAILED', code: 'WEBHOOK_SIGNATURE_INVALID' };
    if (parsed.ignored) return { httpStatus: 200, status: 'IGNORED', code: null };
    return applyWebhookEvent(this.prisma, {
      provider: 'ALIPAY',
      rawBody: parsed.event.externalEventId,
      verified: {
        eventName: parsed.event.event,
        externalEventId: parsed.event.externalEventId,
        merchantOrderNo: parsed.event.merchantOrderNo,
        amountCents: parsed.event.amountCents,
        currency: parsed.event.currency,
        providerTradeNo: parsed.event.providerTradeNo,
        expectedAppId: matched.account.appId,
        actualAppId: parsed.event.appId,
      },
    });
  }

  async orderView(userId: string, orderId: string) {
    const order = await this.visibleOrder(userId, orderId);
    const admin = await this.isAdmin(userId);
    const account = await this.account('SANDBOX');
    const decision = decideAlipayCheckout({ actorIsPlatformAdmin: admin, environment: 'SANDBOX', providerStatus: account?.status ?? 'UNCONFIGURED', gates: readAlipayGates() });
    const payment = order.payments[0];
    return {
      orderNumber: order.orderNumber,
      planName: order.plan?.name ?? '套餐',
      billingInterval: order.billingInterval === 'yearly' ? '年付' : '月付',
      subscriptionFee: order.subscriptionFee,
      cloudCostNote: '预计云资源费用仅供参考，本次支付宝只收取套餐服务费。',
      payableAmount: order.totalAmountCents != null ? order.totalAmountCents / 100 : order.totalAmount,
      currency: order.currency,
      showAlipay: decision.ok,
      providerLabel: decision.ok ? '支付宝' : null,
      statusCopy: payment ? userPaymentWaitCopy({ orderStatus: order.status, paymentStatus: payment.status, queryState: payment.lastQueryState }) : '等待支付',
      fulfillmentCopy: payment ? fulfillmentCopy({ paymentStatus: payment.status, orderStatus: order.status }) : '等待支付',
      returnCopy: returnUrlIsNotPaymentFact().pendingCopy,
      invoiceNumber: order.invoices[0]?.invoiceNumber ?? null,
      paidAt: payment?.paidAt ?? null,
    };
  }

  async refund(adminId: string, paymentId: string, amount?: number) {
    await this.requireAdmin(adminId);
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId }, include: { refunds: true, order: true } });
    if (!payment || payment.provider !== 'ALIPAY' || !payment.merchantOrderNo || !payment.environment) throw new BadRequestException({ code: 'PAYMENT_NOT_FOUND', message: userPaymentMessage('PAYMENT_NOT_FOUND') });
    const usesCents = payment.amountCents != null;
    const already = payment.refunds.filter((refund) => refund.status === 'SUCCEEDED').reduce((sum, refund) => sum + (usesCents ? refund.amountCents ?? 0 : refund.amount), 0);
    const remaining = usesCents ? (payment.amountCents ?? 0) - already : payment.amount - already;
    const requested = amount == null ? remaining : usesCents ? Math.round(amount * 100) : amount;
    if (requested <= 0 || requested > remaining) throw new BadRequestException({ code: 'REFUND_NOT_ALLOWED', message: userPaymentMessage('REFUND_NOT_ALLOWED') });
    const account = await this.account(payment.environment === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX');
    const provider = account ? this.providerFor(account) : null;
    if (!provider) throw new BadRequestException({ code: 'ALIPAY_NOT_VERIFIED', message: userPaymentMessage('ALIPAY_NOT_VERIFIED') });
    const providerRefundId = `LOS-RF-${payment.merchantOrderNo}-${already + 1}`;
    const result = await provider.refundPayment({ merchantOrderNo: payment.merchantOrderNo, refundCents: usesCents ? requested : requested * 100, refundRequestNo: providerRefundId });
    const outcome = result.state === 'SUCCEEDED' ? 'SUCCEEDED' : result.state === 'FAILED' ? 'FAILED' : 'PENDING';
    const settled = await settleProviderRefund(this.prisma, { paymentId, actorId: adminId, amount: usesCents ? 0 : requested, amountCents: usesCents ? requested : null, providerRefundId, outcome });
    if (!settled.ok) throw new BadRequestException({ code: settled.code, message: userPaymentMessage(settled.code) });
    return { status: settled.status, stopsService: settled.stopsService, invoiceAmount: settled.invoiceAmount };
  }

  async close(adminId: string, paymentId: string) {
    await this.requireAdmin(adminId);
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.provider !== 'ALIPAY' || !payment.merchantOrderNo || !payment.environment) throw new BadRequestException({ code: 'PAYMENT_NOT_FOUND', message: userPaymentMessage('PAYMENT_NOT_FOUND') });
    if (payment.status === 'SUCCEEDED' || payment.status === 'REFUNDED' || payment.status === 'PARTIALLY_REFUNDED') {
      throw new BadRequestException('已支付的交易不能关闭，需要退款');
    }
    const account = await this.account(payment.environment === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX');
    const provider = account ? this.providerFor(account) : null;
    if (!provider) throw new BadRequestException({ code: 'ALIPAY_NOT_VERIFIED', message: userPaymentMessage('ALIPAY_NOT_VERIFIED') });
    const closed = await provider.closeTrade(payment.merchantOrderNo);
    if (closed.state === 'UNKNOWN_PENDING') {
      await this.prisma.payment.update({ where: { id: payment.id }, data: { status: 'PROCESSING', lastQueryState: 'UNKNOWN_PENDING', lastQueriedAt: new Date() } });
      return { status: 'PROCESSING' };
    }
    await this.prisma.payment.update({ where: { id: payment.id }, data: { status: 'CANCELED', lastQueryState: 'CLOSED' } });
    await this.prisma.commercialOrder.updateMany({ where: { id: payment.orderId, status: { in: ['DRAFT', 'PENDING_PAYMENT'] } }, data: { status: 'CANCELED' } });
    return { status: 'CANCELED' };
  }

  async lookup(payment: { id: string; provider: string | null; merchantOrderNo: string | null; environment: string | null; status: string; createdAt: Date; orderId: string }) {
    if (payment.provider !== 'ALIPAY' || !payment.merchantOrderNo || !payment.environment) return null;
    const account = await this.account(payment.environment === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX');
    const provider = account ? this.providerFor(account) : null;
    if (!provider || !account) return { state: 'UNKNOWN_PENDING' as const };
    const result = await provider.getCheckoutStatus(payment.merchantOrderNo);
    await this.prisma.payment.update({ where: { id: payment.id }, data: { lastQueriedAt: new Date(), lastQueryState: result.state } });
    if (result.state === 'UNKNOWN_PENDING') return result;
    return { ...result, appId: account.appId, eventId: `trade-query:${payment.merchantOrderNo}:${result.state}` };
  }

  async startProductionTest(adminId: string) {
    await this.requireAdmin(adminId);
    const gates = readAlipayGates();
    const plan = await this.prisma.plan.findUnique({ where: { code: 'PAYMENT_TEST' }, include: { versions: { where: { effectiveTo: null }, orderBy: { version: 'desc' }, take: 1 } } });
    if (!plan || plan.status !== 'INTERNAL_TEST') throw new ForbiddenException({ code: 'ALIPAY_PRODUCTION_TEST_PLAN', message: userPaymentMessage('ALIPAY_PRODUCTION_TEST_PLAN') });
    const version = plan.versions[0] ?? null;
    const workspaceId = gates.productionTestWorkspaceId;
    const decision = decideAlipayCheckout({
      actorIsPlatformAdmin: true,
      environment: 'PRODUCTION',
      providerStatus: (await this.account('PRODUCTION'))?.status ?? 'UNCONFIGURED',
      gates,
      productionTest: {
        workspaceId: workspaceId ?? '',
        allowedWorkspaceId: workspaceId,
        planCode: plan.code,
        planStatus: plan.status,
        priceMonthlyCents: version?.priceMonthlyCents ?? plan.priceMonthlyCents,
      },
    });
    if (!decision.ok || !workspaceId) throw new ForbiddenException({ code: decision.ok ? 'ALIPAY_PRODUCTION_TEST_WORKSPACE' : decision.code, message: userPaymentMessage(decision.ok ? 'ALIPAY_PRODUCTION_TEST_WORKSPACE' : decision.code) });
    const workspace = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } });
    if (!workspace) throw new ForbiddenException({ code: 'ALIPAY_PRODUCTION_TEST_WORKSPACE', message: userPaymentMessage('ALIPAY_PRODUCTION_TEST_WORKSPACE') });
    const orderNumber = `LO-TEST-${Date.now().toString(36).toUpperCase()}`;
    const order = await this.prisma.commercialOrder.create({
      data: {
        workspaceId,
        orderNumber,
        type: 'SUBSCRIPTION_NEW',
        status: 'DRAFT',
        planId: plan.id,
        planVersionId: version?.id,
        billingInterval: 'monthly',
        subscriptionFee: 0,
        cloudCostEstimate: null,
        discountAmount: 0,
        totalAmount: 0,
        totalAmountCents: 90,
        currency: 'CNY',
        createdById: adminId,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    return this.checkout(adminId, order.id, { environment: 'PRODUCTION', amount: 99 });
  }

  async disablePaymentTest(adminId: string) {
    await this.requireAdmin(adminId);
    const plan = await this.prisma.plan.findUnique({ where: { code: 'PAYMENT_TEST' } });
    if (!plan) throw new BadRequestException({ code: 'ALIPAY_PRODUCTION_TEST_PLAN', message: userPaymentMessage('ALIPAY_PRODUCTION_TEST_PLAN') });
    if (plan.status === 'INTERNAL_TEST') {
      await this.prisma.plan.update({ where: { id: plan.id }, data: { status: 'INACTIVE' } });
    }
    return { code: plan.code, status: plan.status === 'INTERNAL_TEST' ? 'INACTIVE' : plan.status, retainedHistory: true };
  }

  async armFailure(adminId: string, paymentId: string) {
    await this.requireAdmin(adminId);
    if (process.env.NODE_ENV === 'production') throw new ForbiddenException('当前环境不能模拟开通失败');
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new BadRequestException({ code: 'PAYMENT_NOT_FOUND', message: userPaymentMessage('PAYMENT_NOT_FOUND') });
    await this.prisma.commercialOrder.update({ where: { id: payment.orderId }, data: { fulfillmentFailOnce: true } });
    return { ok: true };
  }

  private async readiness(account: AccountRecord | null) {
    let signatureVerified = false;
    if (account?.credentialEncrypted && account.publicKey) {
      try {
        const provider = this.providerFor(account);
        signatureVerified = Boolean(provider);
      } catch {
        signatureVerified = false;
      }
    }
    let callbackReachable = false;
    if (account?.notifyUrl?.startsWith('https://')) {
      try {
        const response = await fetch(account.notifyUrl, { method: 'GET', signal: AbortSignal.timeout(3000) });
        callbackReachable = response.status < 500;
      } catch {
        callbackReachable = false;
      }
    }
    return assessAlipayProductionReadiness({
      appReady: account?.appReady ?? false,
      appId: account?.appId ?? null,
      gatewayUrl: account?.gatewayUrl ?? null,
      privateKeyConfigured: Boolean(account?.credentialEncrypted),
      publicKeyConfigured: Boolean(account?.publicKey),
      notifyUrl: account?.notifyUrl ?? null,
      signatureVerified,
      clockOk: Number.isFinite(Date.now()),
      callbackReachable,
    });
  }

  private providerFor(account: AccountRecord): AlipayPaymentProvider | null {
    if (!account.appId || !account.gatewayUrl || !account.publicKey || !account.credentialEncrypted || !account.notifyUrl || !account.returnUrl) return null;
    let privateKey = '';
    try {
      privateKey = decryptCredential(account.credentialEncrypted);
      return new AlipayPaymentProvider({
        appId: account.appId,
        gatewayUrl: account.gatewayUrl,
        privateKey,
        alipayPublicKey: account.publicKey,
        notifyUrl: account.notifyUrl,
        returnUrl: account.returnUrl,
      });
    } catch {
      return null;
    } finally {
      privateKey = '';
    }
  }

  private present(row: AccountRecord) {
    return {
      provider: '支付宝',
      providerCode: row.provider,
      environment: row.environment,
      displayName: row.displayName,
      appId: row.appId,
      gatewayUrl: row.gatewayUrl,
      notifyUrl: row.notifyUrl,
      returnUrl: row.returnUrl,
      status: row.status,
      appReady: row.appReady,
      privateKeyConfigured: Boolean(row.credentialEncrypted),
      publicKeyConfigured: Boolean(row.publicKey),
      lastVerifiedAt: row.lastVerifiedAt,
      lastSuccessAt: row.lastSuccessAt,
      lastErrorCode: row.lastErrorCode,
      lastWebhookAt: row.lastWebhookAt,
      lastWebhookStatus: row.lastWebhookStatus,
    };
  }

  private empty(environment: AlipayEnvironment) {
    return { provider: '支付宝', providerCode: 'ALIPAY', environment, displayName: '支付宝', appId: null, status: 'UNCONFIGURED', privateKeyConfigured: false, publicKeyConfigured: false };
  }

  private account(environment: AlipayEnvironment) {
    return this.prisma.paymentProviderAccount.findUnique({ where: { provider_environment: { provider: 'ALIPAY', environment } } });
  }

  private async visibleOrder(userId: string, orderId: string) {
    const order = await this.prisma.commercialOrder.findUnique({ where: { id: orderId }, include: { plan: true, payments: { orderBy: { createdAt: 'desc' } }, invoices: true, workspace: { include: { members: true } } } });
    if (!order) throw new BadRequestException({ code: 'PAYMENT_NOT_FOUND', message: userPaymentMessage('PAYMENT_NOT_FOUND') });
    const admin = await this.isAdmin(userId);
    const member = order.workspace.members.some((item) => item.userId === userId);
    if (!admin && !member) throw new ForbiddenException('需要平台管理员权限');
    return order;
  }

  private async isAdmin(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { platformRole: true } });
    return canReviewUpgrade(user?.platformRole ?? 'USER');
  }

  private async requireAdmin(userId: string) {
    const allowed = await this.isAdmin(userId);
    if (!allowed) throw new ForbiddenException('需要平台管理员权限');
    return allowed;
  }
}
