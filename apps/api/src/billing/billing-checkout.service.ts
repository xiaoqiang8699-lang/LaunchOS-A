import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  decideAlipayCheckout,
  isInternalTestPlan,
  normalizeBillingCycle,
  readAlipayGates,
  resolveCatalogPriceCents,
  userPaymentMessage,
  PAYMENT_TEST_PLAN_CODE,
} from '@launchos/domain';
import { PrismaService } from '../database/prisma.service';
import { AlipayPaymentService } from './alipay-payment.service';
import { FormalPaymentReadinessService } from './formal-payment-readiness.service';

const PENDING_REUSE_MS = 15 * 60 * 1000;

@Injectable()
export class BillingCheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly alipay: AlipayPaymentService,
    private readonly formal: FormalPaymentReadinessService,
  ) {}

  /**
   * User-facing checkout foundation.
   * Server prices only; client amount is ignored/rejected.
   * REAL_PAYMENTS_ENABLED=false → refuse real Alipay redirect (M8-1 default).
   */
  async checkout(
    userId: string,
    body: {
      planCode?: string;
      billingCycle?: string;
      amount?: number;
      amountFen?: number;
      amountCents?: number;
      purchaseIntentId?: string;
    },
  ) {
    if (body.amount != null || body.amountFen != null || body.amountCents != null) {
      throw new BadRequestException({
        code: 'CLIENT_AMOUNT_REJECTED',
        message: '支付金额由服务端根据套餐计算，客户端不能提交金额。',
      });
    }

    const planCode = String(body.planCode ?? '').trim();
    const cycle = normalizeBillingCycle(body.billingCycle);
    if (!planCode) throw new BadRequestException({ code: 'PLAN_REQUIRED', message: '请选择套餐' });
    if (!cycle || cycle === 'ONE_TIME_TEST') {
      throw new BadRequestException({ code: 'BILLING_CYCLE_INVALID', message: '请选择月付或年付' });
    }
    if (isInternalTestPlan(planCode) || planCode === PAYMENT_TEST_PLAN_CODE) {
      throw new ForbiddenException({
        code: 'PAYMENT_TEST_FORBIDDEN',
        message: '该套餐仅供内部支付联调，不能通过普通结账购买。',
      });
    }
    if (planCode.toLowerCase() === 'enterprise') {
      throw new ForbiddenException({ code: 'PAYMENT_NOT_AVAILABLE', message: '企业版请联系销售' });
    }

    const membership = await this.prisma.workspaceMember.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    if (!membership) throw new ForbiddenException('没有可用工作空间');

    const plan = await this.prisma.plan.findUnique({ where: { code: planCode } });
    if (!plan || plan.status !== 'ACTIVE' || plan.contactSales) {
      throw new NotFoundException({ code: 'PLAN_NOT_FOUND', message: '套餐不存在或不可购买' });
    }

    const version = await this.prisma.planVersion.findFirst({
      where: { planId: plan.id, effectiveTo: null },
      orderBy: { version: 'desc' },
    });

    const priced = resolveCatalogPriceCents({
      planCode: plan.code,
      billingCycle: cycle,
      priceMonthly: version?.priceMonthly ?? plan.priceMonthly,
      priceYearly: version?.priceYearly ?? plan.priceYearly,
      priceMonthlyCents: version?.priceMonthlyCents ?? plan.priceMonthlyCents,
      priceYearlyCents: null,
    });
    if (!priced.ok) {
      throw new BadRequestException({ code: priced.code, message: '套餐价格未配置' });
    }

    const gates = readAlipayGates();
    if (!gates.realPaymentsEnabled) {
      return {
        available: false,
        status: 'DISABLED',
        code: 'REAL_PAYMENTS_DISABLED',
        message: userPaymentMessage('REAL_PAYMENTS_DISABLED') || '支付功能即将开放',
        amountFen: priced.amountCents,
        amountCents: priced.amountCents,
        currency: 'CNY',
        planCode: plan.code,
        billingCycle: cycle,
        paymentOrderId: null,
        checkoutUrl: null,
        purchaseConfirmRequired: true,
        confirmPath: `/billing/checkout/confirm?plan=${encodeURIComponent(plan.code)}&cycle=${cycle}`,
      };
    }

    // Formal path: intent required when payments are open
    await this.formal.formalCheckoutGuard(userId, plan.code.toLowerCase(), cycle, body.purchaseIntentId);

    const account = await this.prisma.paymentProviderAccount.findFirst({
      where: { provider: 'ALIPAY', environment: 'PRODUCTION' },
    });
    const decision = decideAlipayCheckout({
      actorIsPlatformAdmin: false,
      environment: 'PRODUCTION',
      providerStatus: account?.status ?? 'UNCONFIGURED',
      gates,
      realCatalogPurchase: true,
    });
    if (!decision.ok) {
      throw new ForbiddenException({ code: decision.code, message: userPaymentMessage(decision.code) });
    }

    const interval = cycle === 'YEARLY' ? 'yearly' : 'monthly';
    const reuseAfter = new Date(Date.now() - PENDING_REUSE_MS);
    const existing = await this.prisma.commercialOrder.findFirst({
      where: {
        workspaceId: membership.workspaceId,
        planId: plan.id,
        billingInterval: interval,
        status: { in: ['DRAFT', 'PENDING_PAYMENT'] },
        createdAt: { gte: reuseAfter },
        createdById: userId,
      },
      include: {
        payments: {
          where: { status: { in: ['PENDING', 'PROCESSING'] }, provider: 'ALIPAY' },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    let orderId = existing?.id ?? null;
    if (!orderId) {
      const orderNumber = `LO-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const yuan = Math.trunc(priced.amountCents / 100);
      const created = await this.prisma.commercialOrder.create({
        data: {
          workspaceId: membership.workspaceId,
          orderNumber,
          type: 'SUBSCRIPTION_NEW',
          status: 'DRAFT',
          planId: plan.id,
          planVersionId: version?.id,
          billingInterval: interval,
          subscriptionFee: yuan,
          cloudCostEstimate: null,
          discountAmount: 0,
          totalAmount: yuan,
          totalAmountCents: priced.amountCents,
          currency: version?.currency || plan.currency || 'CNY',
          createdById: userId,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          termsVersion: 'commercial-terms-2026-10-m83',
          purchaseIntentId: body.purchaseIntentId ?? null,
          priceSnapshot: {
            planCode: plan.code,
            billingCycle: cycle,
            amountFen: priced.amountCents,
            currency: 'CNY',
            planVersionId: version?.id ?? null,
            priceVersion: version?.version ?? null,
          },
        },
      });
      orderId = created.id;
      if (body.purchaseIntentId) {
        await this.prisma.purchaseIntent.update({
          where: { id: body.purchaseIntentId },
          data: { status: 'CONSUMED', consumedAt: new Date() },
        }).catch(() => null);
      }
    }

    // Reuse AlipayPaymentService.checkout — production path requires admin today for sandbox;
    // real catalog uses decideAlipayCheckout(realCatalogPurchase) above. Checkout method still
    // goes through admin require — so we create Alipay session via dedicated internal helper.
    const checkout = await this.alipay.userCatalogCheckout(userId, orderId, {
      amountCents: priced.amountCents,
    });

    return {
      available: true,
      paymentOrderId: checkout.paymentId,
      orderId,
      status: 'PENDING',
      checkoutUrl: checkout.checkoutUrl,
      amountFen: priced.amountCents,
      amountCents: priced.amountCents,
      currency: 'CNY',
      planCode: plan.code,
      billingCycle: cycle,
      ignoredClientAmount: true,
    };
  }

  async paymentTestStatus(adminId: string) {
    await this.alipay.assertPlatformAdmin(adminId);
    const gates = readAlipayGates();
    const plan = await this.prisma.plan.findUnique({
      where: { code: PAYMENT_TEST_PLAN_CODE },
      include: { versions: { where: { effectiveTo: null }, orderBy: { version: 'desc' }, take: 1 } },
    });
    const production = await this.prisma.paymentProviderAccount.findFirst({
      where: { provider: 'ALIPAY', environment: 'PRODUCTION' },
    });
    let sync: Awaited<ReturnType<AlipayPaymentService['syncPaymentTestPendings']>> | null = null;
    if (gates.productionTestWorkspaceId && gates.paymentTestRealEnabled) {
      sync = await this.alipay.syncPaymentTestPendings(gates.productionTestWorkspaceId);
    }
    const reusable = sync?.reusable[0] ?? null;
    return {
      amountFen: 90,
      amountLabel: '¥0.90',
      environment: 'PRODUCTION',
      planCode: PAYMENT_TEST_PLAN_CODE,
      planStatus: plan?.status ?? null,
      hidden: true,
      internalOnly: true,
      gates: {
        REAL_PAYMENTS_ENABLED: gates.realPaymentsEnabled,
        PAYMENT_TEST_REAL_ENABLED: gates.paymentTestRealEnabled,
        ALIPAY_PRODUCTION_TEST_ENABLED: gates.alipayProductionTestEnabled,
      },
      buttonEnabled: gates.paymentTestRealEnabled === true,
      disabledReason: gates.paymentTestRealEnabled
        ? null
        : '真实测试尚未开启。请保持 PAYMENT_TEST_REAL_ENABLED=false，等待人工确认后再打开。',
      warning: '这会产生真实支付宝交易。',
      providerConfigured: Boolean(production?.appId && production.credentialEncrypted && production.publicKey),
      providerStatus: production?.status ?? 'UNCONFIGURED',
      workspaceId: gates.productionTestWorkspaceId,
      reusablePending: reusable
        ? {
            paymentId: reusable.paymentId,
            orderId: reusable.orderId,
            outTradeNo: reusable.outTradeNo,
            amountFen: reusable.amountCents,
            amountLabel: `¥${(reusable.amountCents / 100).toFixed(2)}`,
            status: 'PENDING',
            statusLabel: '待支付',
            createdAt: reusable.createdAt,
            orderNumber: reusable.orderNumber,
            providerNote: null as string | null,
          }
        : null,
      canCreateNew: !reusable,
      emptyPendingLabel: '当前没有待支付测试订单',
      syncSummary: sync
        ? {
            pendingBefore: sync.pendingBefore,
            tradeExists: sync.tradeExists,
            tradeNotExist: sync.tradeNotExist,
            closedOrFailed: sync.closedOrFailed,
            reusableCount: sync.reusable.length,
          }
        : null,
    };
  }
}
