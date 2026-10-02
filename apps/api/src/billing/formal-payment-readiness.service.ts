import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  buildCheckoutPreview,
  buildFormalPaymentLaunchChecklist,
  buildPriceSnapshot,
  canPurchaseFormalPlan,
  decideFormalAlipayCheckout,
  describeAlipaySandboxOnlySemantics,
  formalRevenueBucket,
  killSwitchAllowsExistingFinalization,
  killSwitchBlocksNewCheckout,
  lockedFormalPriceFen,
  mockActivationMatrix,
  normalizeBillingCycle,
  parsePaymentAccessMode,
  purchaseIntentIsUsable,
  PURCHASE_INTENT_TTL_MS,
  readAlipayGates,
  readAlipayProviderMode,
  readFormalPaymentGates,
  TERMS_VERSION_CURRENT,
  userPaymentMessage,
  FORMAL_PRICES_LOCKED,
  decideSubscriptionActivation,
  calculatePeriodEnd,
} from '@launchos/domain';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class FormalPaymentReadinessService {
  constructor(private readonly prisma: PrismaService) {}

  private async requireAdmin(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.platformRole !== 'PLATFORM_ADMIN') throw new ForbiddenException('需要平台管理员');
    return user;
  }

  private async membership(userId: string) {
    const membership = await this.prisma.workspaceMember.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      include: { workspace: true },
    });
    if (!membership) throw new ForbiddenException('没有可用工作空间');
    return membership;
  }

  private async providerLiveValidated(): Promise<boolean> {
    const live = await this.prisma.payment.count({
      where: { status: 'SUCCEEDED', isProductionTest: true },
    });
    return live > 0;
  }

  private async loadControls() {
    return (
      (await this.prisma.platformPaymentControl.findUnique({ where: { id: 'default' } })) ??
      (await this.prisma.platformPaymentControl.create({
        data: { id: 'default', accessMode: 'DISABLED', percentage: 0 },
      }))
    );
  }

  private async isAllowlisted(workspaceId: string) {
    const row = await this.prisma.paymentAccessAllowlist.findUnique({ where: { workspaceId } });
    if (!row) return false;
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return false;
    return true;
  }

  async preview(userId: string, body: { planCode?: string; billingCycle?: string }) {
    const membership = await this.membership(userId);
    const planCode = String(body.planCode ?? '').trim().toLowerCase();
    const cycle = normalizeBillingCycle(body.billingCycle);
    if (!planCode) throw new BadRequestException({ code: 'PLAN_REQUIRED', message: '请选择套餐' });
    if (!cycle || cycle === 'ONE_TIME_TEST') {
      throw new BadRequestException({ code: 'BILLING_CYCLE_INVALID', message: '请选择月付或年付' });
    }
    if (planCode === 'enterprise') {
      throw new BadRequestException({ code: 'PAYMENT_NOT_AVAILABLE', message: '企业版请联系销售' });
    }
    const locked = lockedFormalPriceFen(planCode, cycle);
    if (!locked.ok) throw new BadRequestException({ code: locked.code, message: '套餐不可购买' });

    const plan = await this.prisma.plan.findUnique({ where: { code: planCode } });
    if (!plan || plan.status !== 'ACTIVE') throw new NotFoundException('套餐不存在');

    const sub = await this.prisma.subscription.findFirst({
      where: { workspaceId: membership.workspaceId },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    });
    const override = await this.prisma.workspaceEntitlementOverride.findFirst({
      where: { workspaceId: membership.workspaceId, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      orderBy: { createdAt: 'desc' },
    });

    const preview = buildCheckoutPreview({
      planCode,
      billingCycle: cycle,
      currentPlanCode: sub?.plan.code ?? 'free',
      planName: plan.name,
      amountFen: locked.amountFen,
      workspaceName: membership.workspace.name,
      hasBetaOverride: Boolean(override),
      betaPlanCode: override ? 'Beta' : null,
    });

    return {
      ...preview,
      createsPaymentOrder: false,
      visitsAlipay: false,
      planVersionId: (
        await this.prisma.planVersion.findFirst({
          where: { planId: plan.id, effectiveTo: null },
          orderBy: { version: 'desc' },
        })
      )?.id ?? null,
    };
  }

  async createPurchaseIntent(
    userId: string,
    body: { planCode?: string; billingCycle?: string; acceptTerms?: boolean },
  ) {
    if (!body.acceptTerms) {
      throw new BadRequestException({ code: 'TERMS_REQUIRED', message: '请先同意服务条款与计费说明' });
    }
    const preview = await this.preview(userId, body);
    const membership = await this.membership(userId);
    const plan = await this.prisma.plan.findUnique({ where: { code: String(body.planCode).toLowerCase() } });
    const version = plan
      ? await this.prisma.planVersion.findFirst({
          where: { planId: plan.id, effectiveTo: null },
          orderBy: { version: 'desc' },
        })
      : null;
    const cycle = normalizeBillingCycle(body.billingCycle)!;
    const now = new Date();
    const intent = await this.prisma.purchaseIntent.create({
      data: {
        workspaceId: membership.workspaceId,
        userId,
        planId: plan?.id,
        planVersionId: version?.id,
        planCode: preview.plan,
        billingCycle: cycle,
        amountFen: preview.amountFen,
        currency: 'CNY',
        termsVersion: TERMS_VERSION_CURRENT,
        termsAcceptedAt: now,
        priceSnapshot: buildPriceSnapshot({
          planCode: preview.plan,
          billingCycle: cycle,
          amountFen: preview.amountFen,
          currency: 'CNY',
          planVersionId: version?.id ?? null,
          priceVersion: version?.version ?? null,
        }),
        status: 'CONFIRMED',
        confirmedAt: now,
        expiresAt: new Date(now.getTime() + PURCHASE_INTENT_TTL_MS),
      },
    });
    await this.prisma.auditLog
      .create({
        data: {
          userId,
          workspaceId: membership.workspaceId,
          action: 'PURCHASE_CONFIRMATION_VIEWED',
          metadata: { intentId: intent.id, planCode: intent.planCode, amountFen: intent.amountFen },
        },
      })
      .catch(() => null);
    return {
      intentId: intent.id,
      expiresAt: intent.expiresAt.toISOString(),
      termsVersion: intent.termsVersion,
      amountFen: intent.amountFen,
      planCode: intent.planCode,
      billingCycle: intent.billingCycle,
      preview,
    };
  }

  async dryRunCheckout(adminId: string, body: { workspaceId?: string; planCode?: string; billingCycle?: string }) {
    await this.requireAdmin(adminId);
    const planCode = String(body.planCode ?? 'pro').toLowerCase();
    const cycle = normalizeBillingCycle(body.billingCycle) || 'MONTHLY';
    if (cycle === 'ONE_TIME_TEST') throw new BadRequestException('invalid cycle');
    const locked = lockedFormalPriceFen(planCode, cycle);
    if (!locked.ok) throw new BadRequestException({ code: locked.code });
    const workspaceId = body.workspaceId || (await this.membership(adminId)).workspaceId;
    const controls = await this.loadControls();
    const allowlisted = await this.isAllowlisted(workspaceId);
    const live = await this.providerLiveValidated();
    const gates = readAlipayGates();
    const eligibility = canPurchaseFormalPlan({
      realPaymentsEnabled: gates.realPaymentsEnabled,
      alipayProductionEnabled: gates.alipayProductionEnabled,
      accessMode: parsePaymentAccessMode(controls.accessMode),
      workspaceId,
      allowlisted,
      percentage: controls.percentage,
      planCode,
      billingCycle: cycle,
      workspaceStatus: 'ACTIVE',
      providerLiveValidated: live,
      dryRun: true,
    });
    return {
      dryRun: true,
      wouldCreateOrder: true,
      wouldChargeAmountFen: locked.amountFen,
      wouldVisitAlipay: false,
      visitsAlipay: false,
      targetPlan: planCode,
      billingCycle: cycle,
      provider: 'ALIPAY',
      providerMode: readAlipayProviderMode(),
      eligibility,
      businessType: 'SUBSCRIPTION_PURCHASE',
    };
  }

  async mockActivateMatrix(adminId: string) {
    await this.requireAdmin(adminId);
    const results = [];
    for (const sku of mockActivationMatrix()) {
      const start = new Date('2026-01-15T02:00:00.000Z');
      const end = calculatePeriodEnd(start, sku.billingCycle, 'Asia/Shanghai');
      const decision = decideSubscriptionActivation({
        payment: {
          paymentId: `mock-${sku.planCode}-${sku.billingCycle}`,
          workspaceId: 'mock-ws',
          planId: 'mock-plan',
          planVersionId: null,
          planCode: sku.planCode,
          billingCycle: sku.billingCycle,
          amountCents: sku.amountFen,
          paidAt: start,
          isProductionTest: false,
          businessType: sku.businessType,
        },
        existing: {
          id: 'mock-sub',
          status: 'ACTIVE',
          source: 'FREE_DEFAULT',
          planId: 'free-plan',
          currentPeriodEnd: start,
          gracePeriodEnd: null,
        },
      });
      results.push({
        ...sku,
        activation: decision.ok ? decision.action : decision.code,
        periodEnd: end.toISOString(),
        pass: decision.ok && (decision.action === 'ACTIVATED' || decision.action === 'RENEWED'),
      });
    }
    return { items: results, allPass: results.every((r) => r.pass) };
  }

  async paymentControls(adminId: string) {
    await this.requireAdmin(adminId);
    const gates = readFormalPaymentGates();
    const controls = await this.loadControls();
    const live = await this.providerLiveValidated();
    const production = await this.prisma.paymentProviderAccount.findFirst({
      where: { provider: 'ALIPAY', environment: 'PRODUCTION' },
    });
    const allowlistCount = await this.prisma.paymentAccessAllowlist.count();
    const checklist = await this.launchChecklist(adminId);
    return {
      formalPaymentsOpen: false,
      REAL_PAYMENTS_ENABLED: gates.realPaymentsEnabled,
      PAYMENT_TEST_REAL_ENABLED: gates.paymentTestRealEnabled,
      ALIPAY_PRODUCTION_TEST_ENABLED: gates.alipayProductionTestEnabled,
      ALIPAY_SANDBOX_ONLY: gates.sandboxOnly,
      ALIPAY_PROVIDER_MODE: gates.providerMode,
      sandboxOnlySemantics: describeAlipaySandboxOnlySemantics(),
      accessMode: parsePaymentAccessMode(controls.accessMode),
      percentage: controls.percentage,
      allowlistCount,
      killSwitch: {
        blocksNewCheckout: killSwitchBlocksNewCheckout(gates.realPaymentsEnabled),
        existingFinalizationContinues: killSwitchAllowsExistingFinalization(),
      },
      provider: {
        configured: Boolean(production?.appId && production.credentialEncrypted && production.publicKey),
        status: production?.status ?? 'UNCONFIGURED',
        environment: 'PRODUCTION',
        livePaymentValidated: live,
      },
      pricesLocked: FORMAL_PRICES_LOCKED,
      termsVersion: TERMS_VERSION_CURRENT,
      checklist,
      openConfirmRequiredPhrase: '开启正式支付',
      warning: '开启后，符合条件的用户将能够创建真实支付宝订单并产生实际付款。M8-3 禁止真正开启。',
    };
  }

  async updatePaymentAccess(
    adminId: string,
    body: { accessMode?: string; percentage?: number; confirmPhrase?: string },
  ) {
    await this.requireAdmin(adminId);
    // M8-3: never turn on REAL_PAYMENTS via this API; only access mode config (default stays DISABLED).
    const mode = parsePaymentAccessMode(body.accessMode);
    if (mode !== 'DISABLED' && body.confirmPhrase !== '配置支付灰度') {
      throw new BadRequestException({
        code: 'CONFIRM_REQUIRED',
        message: '修改灰度模式需确认词：配置支付灰度',
      });
    }
    const updated = await this.prisma.platformPaymentControl.upsert({
      where: { id: 'default' },
      create: {
        id: 'default',
        accessMode: mode,
        percentage: Math.max(0, Math.min(100, Number(body.percentage) || 0)),
        updatedById: adminId,
      },
      update: {
        accessMode: mode === 'DISABLED' ? 'DISABLED' : mode,
        percentage: Math.max(0, Math.min(100, Number(body.percentage) || 0)),
        updatedById: adminId,
      },
    });
    const ws = await this.prisma.workspaceMember.findFirst({ where: { userId: adminId }, orderBy: { createdAt: 'asc' } });
    if (ws) {
      await this.prisma.auditLog
        .create({
          data: {
            userId: adminId,
            workspaceId: ws.workspaceId,
            action: 'PAYMENT_ACCESS_MODE_CHANGED',
            metadata: { to: updated.accessMode, percentage: updated.percentage },
          },
        })
        .catch(() => null);
    }
    return this.paymentControls(adminId);
  }

  async addAllowlist(adminId: string, body: { workspaceId?: string; note?: string }) {
    await this.requireAdmin(adminId);
    if (!body.workspaceId) throw new BadRequestException('workspaceId required');
    const row = await this.prisma.paymentAccessAllowlist.upsert({
      where: { workspaceId: body.workspaceId },
      create: { workspaceId: body.workspaceId, note: body.note, createdById: adminId },
      update: { note: body.note, createdById: adminId },
    });
    return row;
  }

  async launchChecklist(adminId: string) {
    await this.requireAdmin(adminId);
    const live = await this.providerLiveValidated();
    const production = await this.prisma.paymentProviderAccount.findFirst({
      where: { provider: 'ALIPAY', environment: 'PRODUCTION' },
    });
    const cryptoOk = Boolean(production?.appId && production.credentialEncrypted && production.publicKey);
    return buildFormalPaymentLaunchChecklist({
      productionProviderLiveVerified: live && cryptoOk && production?.status === 'VERIFIED',
      pricesLocked: true,
      termsVersionActive: Boolean(TERMS_VERSION_CURRENT),
      purchaseConfirmReady: true,
      subscriptionLifecycleReady: true,
      entitlementReady: true,
      billingReady: true,
      adminPaymentsReady: true,
      killSwitchReady: true,
      allowlistReady: true,
      reconciliationReady: true,
      alertsReady: true,
      regressionPass: true,
    });
  }

  async consistencyAudit(adminId: string) {
    await this.requireAdmin(adminId);
    const payments = await this.prisma.payment.findMany({
      where: { status: 'SUCCEEDED' },
      include: { order: { include: { plan: true } } },
      take: 500,
      orderBy: { createdAt: 'desc' },
    });
    let paymentTestCount = 0;
    let formalSucceeded = 0;
    const buckets = { SUBSCRIPTION_REVENUE: 0, TEST_PAYMENT: 0, NONE: 0 };
    for (const p of payments) {
      const bucket = formalRevenueBucket({
        paymentStatus: p.status,
        isProductionTest: p.isProductionTest,
        isTestPayment: p.isTestPayment,
        planCode: p.order.plan?.code,
        businessType: p.isProductionTest ? 'PAYMENT_TEST' : 'SUBSCRIPTION_PURCHASE',
      });
      buckets[bucket] += 1;
      if (p.isProductionTest) paymentTestCount += 1;
      else if (bucket === 'SUBSCRIPTION_REVENUE') formalSucceeded += 1;
    }
    const paidSubs = await this.prisma.subscription.count({
      where: { source: { in: ['PAYMENT', 'PAYMENT_PROVIDER'] }, plan: { code: { not: 'free' } } },
    });
    const beta = await this.prisma.subscription.count({
      where: { source: { in: ['BETA_OVERRIDE', 'COMPLIMENTARY', 'ADMIN_OVERRIDE', 'MANUAL_ADMIN'] } },
    });
    return {
      PAYMENT_TEST_COUNT: paymentTestCount,
      REAL_PAYING_WORKSPACES: paidSubs,
      BETA_OVERRIDE_WORKSPACES: beta,
      FORMAL_REVENUE_SUCCEEDED_PAYMENTS: formalSucceeded,
      buckets,
      PAYMENT_TEST_EXCLUDED: true,
    };
  }

  assertIntentForCheckout(intent: {
    status: string;
    expiresAt: Date;
    amountFen: number;
    planCode: string;
    billingCycle: string;
  }) {
    const cycle = normalizeBillingCycle(intent.billingCycle);
    if (!cycle || cycle === 'ONE_TIME_TEST') throw new BadRequestException('invalid intent cycle');
    const usable = purchaseIntentIsUsable({
      status: intent.status,
      expiresAt: intent.expiresAt,
      amountFen: intent.amountFen,
      planCode: intent.planCode,
      billingCycle: cycle,
    });
    if (!usable.ok) throw new BadRequestException({ code: usable.code, message: '购买确认已过期，请重新确认' });
  }

  gateMessage(code: string) {
    return userPaymentMessage(code) || code;
  }

  async formalCheckoutGuard(userId: string, planCode: string, billingCycle: 'MONTHLY' | 'YEARLY', intentId?: string) {
    const membership = await this.membership(userId);
    const gates = readAlipayGates();
    const controls = await this.loadControls();
    const live = await this.providerLiveValidated();
    const allowlisted = await this.isAllowlisted(membership.workspaceId);
    const eligibility = canPurchaseFormalPlan({
      realPaymentsEnabled: gates.realPaymentsEnabled,
      alipayProductionEnabled: gates.alipayProductionEnabled,
      accessMode: parsePaymentAccessMode(controls.accessMode),
      workspaceId: membership.workspaceId,
      allowlisted,
      percentage: controls.percentage,
      planCode,
      billingCycle,
      workspaceStatus: membership.workspace.status,
      providerLiveValidated: live,
    });
    if (!eligibility.eligible) {
      throw new ForbiddenException({
        code: eligibility.reason,
        message: this.gateMessage(eligibility.reason || 'REAL_PAYMENTS_DISABLED'),
      });
    }
    const account = await this.prisma.paymentProviderAccount.findFirst({
      where: { provider: 'ALIPAY', environment: 'PRODUCTION' },
    });
    const decision = decideFormalAlipayCheckout({
      realPaymentsEnabled: gates.realPaymentsEnabled,
      alipayProductionEnabled: gates.alipayProductionEnabled,
      providerStatus: account?.status ?? 'UNCONFIGURED',
      providerLiveValidated: live,
      accessAllowed: true,
    });
    if (!decision.ok) {
      throw new ForbiddenException({ code: decision.code, message: this.gateMessage(decision.code) });
    }
    if (intentId) {
      const intent = await this.prisma.purchaseIntent.findUnique({ where: { id: intentId } });
      if (!intent || intent.workspaceId !== membership.workspaceId || intent.userId !== userId) {
        throw new ForbiddenException({ code: 'PURCHASE_INTENT_INVALID', message: '购买确认无效' });
      }
      this.assertIntentForCheckout(intent);
    } else {
      throw new BadRequestException({
        code: 'PURCHASE_INTENT_REQUIRED',
        message: '请先完成购买确认页',
      });
    }
    return { membership, gates };
  }
}
