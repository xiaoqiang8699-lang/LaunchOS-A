import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { AlipayPaymentProvider, alipayKeyFingerprints, inspectPagePayUrl, requestSignIncludesSignType } from '@launchos/providers';
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
    const isPaymentTest = order.plan.code === 'PAYMENT_TEST';
    const decision = decideAlipayCheckout({
      actorIsPlatformAdmin: user,
      environment,
      providerStatus: account?.status ?? 'UNCONFIGURED',
      gates,
      productionTest:
        environment === 'PRODUCTION' && isPaymentTest
          ? {
              workspaceId: order.workspaceId,
              allowedWorkspaceId: gates.productionTestWorkspaceId,
              planCode: order.plan.code,
              planStatus: order.plan.status,
              priceMonthlyCents: order.planVersion?.priceMonthlyCents ?? order.plan.priceMonthlyCents,
            }
          : null,
      realCatalogPurchase: environment === 'PRODUCTION' && !isPaymentTest,
    });
    if (!decision.ok) throw new ForbiddenException({ code: decision.code, message: userPaymentMessage(decision.code) });
    const created = await createAlipayCheckout(this.prisma, { orderId, actorId: adminId, environment, isTestPayment: decision.isTestPayment, isProductionTest: decision.isProductionTest, clientAmount: body.amount });
    if (!created.ok) throw new BadRequestException({ code: created.code, message: userPaymentMessage(created.code) });
    const provider = account ? this.providerFor(account) : null;
    if (!provider || !created.merchantOrderNo) throw new BadRequestException({ code: 'ALIPAY_NOT_VERIFIED', message: userPaymentMessage('ALIPAY_NOT_VERIFIED') });
    const checkout = provider.createCheckout({ merchantOrderNo: created.merchantOrderNo, amountCents: created.amountCents, subject: decision.isProductionTest ? 'LaunchOS 支付联调' : 'LaunchOS 套餐' });
    await this.prisma.payment.update({ where: { id: created.payment.id }, data: { providerRequestId: checkout.requestId, providerCheckoutId: created.merchantOrderNo } });
    await this.prisma.paymentProviderAccount.update({ where: { id: account!.id }, data: { lastSuccessAt: new Date(), lastErrorCode: null } });
    try {
      const cfg = this.configFromAccount(account!);
      // Safe diagnostics only — never log private key or full signature
      console.info('[alipay-checkout-safe]', {
        paymentId: created.payment.id,
        merchantOrderNo: created.merchantOrderNo,
        amountCents: created.amountCents,
        environment,
        requestSignIncludesSignType: requestSignIncludesSignType(),
        checkoutInspect: inspectPagePayUrl(checkout.checkoutUrl),
        keyFingerprints: alipayKeyFingerprints(cfg),
      });
    } catch {
      /* ignore diagnostic failures */
    }
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
      reused: created.reused === true,
    };
  }

  /**
   * User catalog checkout (Pro/Team). Caller must already enforce REAL_PAYMENTS_ENABLED.
   * Never used for PAYMENT_TEST.
   */
  async userCatalogCheckout(userId: string, orderId: string, _opts?: { amountCents?: number }) {
    const order = await this.visibleOrder(userId, orderId);
    if (!order.plan || order.plan.code === 'PAYMENT_TEST' || order.plan.status === 'INTERNAL_TEST') {
      throw new ForbiddenException({ code: 'PAYMENT_TEST_FORBIDDEN', message: '该套餐不能通过普通结账购买' });
    }
    const gates = readAlipayGates();
    const account = await this.account('PRODUCTION');
    const decision = decideAlipayCheckout({
      actorIsPlatformAdmin: false,
      environment: 'PRODUCTION',
      providerStatus: account?.status ?? 'UNCONFIGURED',
      gates,
      realCatalogPurchase: true,
    });
    if (!decision.ok) throw new ForbiddenException({ code: decision.code, message: userPaymentMessage(decision.code) });
    const created = await createAlipayCheckout(this.prisma, {
      orderId,
      actorId: userId,
      environment: 'PRODUCTION',
      isTestPayment: false,
      isProductionTest: false,
      clientAmount: null,
    });
    if (!created.ok) throw new BadRequestException({ code: created.code, message: userPaymentMessage(created.code) });
    const provider = account ? this.providerFor(account) : null;
    if (!provider || !created.merchantOrderNo) {
      throw new BadRequestException({ code: 'ALIPAY_NOT_VERIFIED', message: userPaymentMessage('ALIPAY_NOT_VERIFIED') });
    }
    const checkout = provider.createCheckout({
      merchantOrderNo: created.merchantOrderNo,
      amountCents: created.amountCents,
      subject: `LaunchOS ${order.plan.name}`,
    });
    await this.prisma.payment.update({
      where: { id: created.payment.id },
      data: { providerRequestId: checkout.requestId, providerCheckoutId: created.merchantOrderNo },
    });
    return {
      paymentId: created.payment.id,
      orderId,
      checkoutUrl: checkout.checkoutUrl,
      amountCents: created.amountCents,
      merchantOrderNo: created.merchantOrderNo,
    };
  }

  async assertPlatformAdmin(userId: string) {
    return this.requireAdmin(userId);
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
    if (result.state === 'UNKNOWN_PENDING' || result.state === 'TRADE_NOT_EXIST') return result;
    return { ...result, appId: account.appId, eventId: `trade-query:${payment.merchantOrderNo}:${result.state}` };
  }

  /**
   * Query Alipay for workspace PAYMENT_TEST pendings.
   * TRADE_NOT_EXIST → local FAILED (ghost from invalid-signature).
   * WAIT_BUYER_PAY → reusable.
   * Never marks PAID here without applyWebhookEvent.
   */
  async syncPaymentTestPendings(workspaceId: string) {
    const account = await this.account('PRODUCTION');
    const provider = account ? this.providerFor(account) : null;
    const pendings = await this.prisma.payment.findMany({
      where: {
        workspaceId,
        provider: 'ALIPAY',
        isProductionTest: true,
        status: { in: ['PENDING', 'PROCESSING'] },
      },
      include: { order: { include: { plan: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const summary = {
      pendingBefore: pendings.length,
      tradeExists: 0,
      tradeNotExist: 0,
      closedOrFailed: 0,
      reusable: [] as Array<{
        paymentId: string;
        orderId: string;
        outTradeNo: string;
        amountCents: number;
        createdAt: string;
        orderNumber: string | null;
      }>,
      unknown: 0,
      succeededApplied: 0,
    };
    if (!provider) {
      return { ...summary, providerReady: false as const };
    }
    for (const payment of pendings) {
      if (!payment.merchantOrderNo) continue;
      const result = await provider.getCheckoutStatus(payment.merchantOrderNo);
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { lastQueriedAt: new Date(), lastQueryState: result.state },
      });
      if (result.state === 'TRADE_NOT_EXIST') {
        summary.tradeNotExist += 1;
        summary.closedOrFailed += 1;
        await this.prisma.payment.update({
          where: { id: payment.id },
          data: {
            status: 'FAILED',
            failureCode: 'PROVIDER_TRADE_NOT_CREATED_INVALID_SIGNATURE',
            failureMessageSafe: '支付宝侧未创建交易',
            lastQueryState: 'TRADE_NOT_EXIST',
            lastQueriedAt: new Date(),
          },
        });
        await this.prisma.commercialOrder.updateMany({
          where: { id: payment.orderId, status: { in: ['DRAFT', 'PENDING_PAYMENT'] } },
          data: { status: 'PAYMENT_FAILED' },
        });
        continue;
      }
      if (result.state === 'PENDING') {
        summary.tradeExists += 1;
        summary.reusable.push({
          paymentId: payment.id,
          orderId: payment.orderId,
          outTradeNo: payment.merchantOrderNo,
          amountCents: payment.amountCents ?? 90,
          createdAt: payment.createdAt.toISOString(),
          orderNumber: payment.order.orderNumber ?? null,
        });
        continue;
      }
      if (result.state === 'SUCCEEDED' || result.state === 'FAILED' || result.state === 'CANCELED') {
        if (result.state === 'SUCCEEDED') summary.succeededApplied += 1;
        else summary.closedOrFailed += 1;
        const eventName =
          result.state === 'SUCCEEDED' ? 'PAYMENT_SUCCEEDED' : result.state === 'CANCELED' ? 'PAYMENT_CANCELED' : 'PAYMENT_FAILED';
        await applyWebhookEvent(this.prisma, {
          provider: 'ALIPAY',
          rawBody: `trade-query:${payment.merchantOrderNo}:${result.state}`,
          verified: {
            eventName,
            externalEventId: `trade-query:${payment.merchantOrderNo}:${result.state}:${Date.now()}`,
            merchantOrderNo: ('merchantOrderNo' in result && result.merchantOrderNo) || payment.merchantOrderNo,
            amountCents: 'amountCents' in result ? result.amountCents : payment.amountCents ?? 90,
            currency: 'currency' in result ? result.currency : payment.currency,
            providerTradeNo: 'providerTradeNo' in result ? result.providerTradeNo : null,
            actualAppId: account?.appId ?? null,
          },
        });
        continue;
      }
      summary.unknown += 1;
    }
    return { ...summary, providerReady: true as const };
  }

  async continueProductionTestPayment(adminId: string, paymentId: string) {
    await this.requireAdmin(adminId);
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { order: { include: { plan: true } } },
    });
    if (!payment || !payment.isProductionTest || payment.provider !== 'ALIPAY' || !payment.merchantOrderNo) {
      throw new BadRequestException({ code: 'PAYMENT_NOT_FOUND', message: userPaymentMessage('PAYMENT_NOT_FOUND') });
    }
    if (payment.status !== 'PENDING' && payment.status !== 'PROCESSING') {
      throw new BadRequestException({ code: 'LAST_PAYMENT_STATE_INVALID', message: '该测试订单不可继续支付' });
    }
    const gates = readAlipayGates();
    if (payment.workspaceId !== gates.productionTestWorkspaceId) {
      throw new ForbiddenException({ code: 'ALIPAY_PRODUCTION_TEST_WORKSPACE', message: userPaymentMessage('ALIPAY_PRODUCTION_TEST_WORKSPACE') });
    }
    const sync = await this.syncPaymentTestPendings(payment.workspaceId);
    const still = sync.reusable.find((item) => item.paymentId === payment.id);
    if (!still) {
      throw new BadRequestException({ code: 'LAST_PAYMENT_STATE_INVALID', message: '支付宝侧不存在待支付交易，请创建新的测试订单' });
    }
    return this.checkout(adminId, payment.orderId, { environment: 'PRODUCTION' });
  }

  async startProductionTest(adminId: string) {
    await this.requireAdmin(adminId);
    const gates = readAlipayGates();
    const plan = await this.prisma.plan.findUnique({
      where: { code: 'PAYMENT_TEST' },
      include: { versions: { where: { effectiveTo: null }, orderBy: { version: 'desc' }, take: 1 } },
    });
    if (!plan || plan.status !== 'INTERNAL_TEST') {
      throw new ForbiddenException({ code: 'ALIPAY_PRODUCTION_TEST_PLAN', message: userPaymentMessage('ALIPAY_PRODUCTION_TEST_PLAN') });
    }
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
    if (!decision.ok || !workspaceId) {
      throw new ForbiddenException({
        code: decision.ok ? 'ALIPAY_PRODUCTION_TEST_WORKSPACE' : decision.code,
        message: userPaymentMessage(decision.ok ? 'ALIPAY_PRODUCTION_TEST_WORKSPACE' : decision.code),
      });
    }
    const workspace = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } });
    if (!workspace) {
      throw new ForbiddenException({ code: 'ALIPAY_PRODUCTION_TEST_WORKSPACE', message: userPaymentMessage('ALIPAY_PRODUCTION_TEST_WORKSPACE') });
    }

    const sync = await this.syncPaymentTestPendings(workspaceId);
    if (sync.reusable.length > 0) {
      const latest = sync.reusable[0]!;
      const reused = await this.checkout(adminId, latest.orderId, { environment: 'PRODUCTION' });
      return { ...reused, reused: true as const };
    }

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
    const created = await this.checkout(adminId, order.id, { environment: 'PRODUCTION', amount: 99 });
    return { ...created, reused: false as const };
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

  private configFromAccount(account: AccountRecord) {
    const privateKey = decryptCredential(account.credentialEncrypted!);
    return {
      appId: account.appId!,
      gatewayUrl: account.gatewayUrl!,
      privateKey,
      alipayPublicKey: account.publicKey!,
      notifyUrl: account.notifyUrl!,
      returnUrl: account.returnUrl!,
    };
  }

  private providerFor(account: AccountRecord): AlipayPaymentProvider | null {
    if (!account.appId || !account.gatewayUrl || !account.publicKey || !account.credentialEncrypted || !account.notifyUrl || !account.returnUrl) return null;
    try {
      return new AlipayPaymentProvider(this.configFromAccount(account));
    } catch {
      return null;
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
