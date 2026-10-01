import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SubscriptionStatus } from '@launchos/database';
import {
  decideActivate,
  assertFeatureFlags,
  decideComplimentary,
  decideImmediateCancel,
  decidePlanChange,
  decideResume,
  decideScheduleCancellation,
  decideStartTrial,
  describeNextChange,
  formatInTimeZone,
  fulfillCommercialOrder,
  isRevenueGenerating,
  presentCommercialSummary,
  estimateGrossMargin,
  notificationIntents,
  processSubscriptionLifecycle,
  requireReason,
  resolveWorkspaceEntitlements,
  sanitizeAdminAuditMetadata,
  subscriptionStatusLabel,
} from '@launchos/domain';
import { PrismaService } from '../database/prisma.service';
import { SubscriptionEngineService } from './subscription-engine.service';

const SOURCE_LABELS: Record<string, string> = {
  DEFAULT_FREE: '默认免费',
  TRIAL: '试用',
  MANUAL_ADMIN: '管理员开通',
  COMPLIMENTARY: '平台赠送',
  PAYMENT_PROVIDER: '支付渠道',
  MOCK_PAYMENT: '测试开通',
};

@Injectable()
export class SubscriptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: SubscriptionEngineService,
  ) {}

  async userSubscription(userId: string) {
    const membership = await this.currentWorkspace(userId);
    const view = await this.engine.subscriptionView(userId);
    const row = await this.prisma.subscription.findFirst({
      where: { workspaceId: membership.workspaceId },
      orderBy: { createdAt: 'desc' },
      include: { plan: true, pendingPlan: true, workspace: true, planVersion: true },
    });
    const timeZone = row?.workspace.timezone || 'Asia/Shanghai';
    const nextChange = row
      ? describeNextChange({
          status: row.status,
          pendingPlanName: row.pendingPlan?.name ?? null,
          planChangeEffectiveAt: row.planChangeEffectiveAt?.toISOString() ?? (row.status === 'CANCEL_AT_PERIOD_END' ? row.currentPeriodEnd.toISOString() : null),
          trialEndsAt: row.trialEndsAt?.toISOString() ?? null,
          timeZone,
        })
      : null;
    if (row && view.overallStatus !== 'WITHIN_LIMIT') {
      await this.saveIntent(row.workspaceId, 'QUOTA_NEAR_LIMIT', row.currentPeriodEnd.toISOString());
    }
    return {
      ...view,
      source: row?.source ?? 'DEFAULT_FREE',
      sourceLabel: SOURCE_LABELS[row?.source ?? 'DEFAULT_FREE'] ?? row?.source ?? '默认免费',
      isRevenueGenerating: isRevenueGenerating(row?.source ?? 'DEFAULT_FREE'),
      trialEndsAt: row?.trialEndsAt ?? null,
      trialEndsLabel: row?.trialEndsAt ? formatInTimeZone(row.trialEndsAt, timeZone) : null,
      nextChange,
      pendingPlan: row?.pendingPlan ? { code: row.pendingPlan.code, name: row.pendingPlan.name } : null,
      periodStartLabel: row ? formatInTimeZone(row.currentPeriodStart, timeZone) : null,
      periodEndLabel: row ? formatInTimeZone(row.currentPeriodEnd, timeZone) : null,
      canResume: row?.status === 'CANCEL_AT_PERIOD_END',
      canCancel: Boolean(view.canCancel && row?.status !== 'CANCEL_AT_PERIOD_END'),
      grandfathered: row?.planVersion?.grandfathered ?? false,
      commercial: presentCommercialSummary({
        planName: view.effectivePlan.name,
        priceMonthly: view.effectivePlan.priceMonthly,
        contactSales: row?.plan.contactSales ?? false,
        currency: view.effectivePlan.currency,
        estimatedCloudCost: view.usage.estimatedCloudCost,
      }),
    };
  }

  async startTrialForUser(userId: string, planCode: string, days: number) {
    const membership = await this.currentWorkspace(userId);
    const admin = await this.isAdmin(userId);
    return this.startTrial({
      actorId: userId,
      workspaceId: membership.workspaceId,
      planCode,
      days,
      adminRegrant: false,
      actorIsAdmin: admin,
    });
  }

  async scheduleCancelForUser(userId: string) {
    const membership = await this.currentWorkspace(userId);
    return this.scheduleCancellation({ actorId: userId, workspaceId: membership.workspaceId, requireAdminReason: false });
  }

  async resumeForUser(userId: string) {
    const membership = await this.currentWorkspace(userId);
    return this.resume({ actorId: userId, workspaceId: membership.workspaceId, requireAdminReason: false });
  }

  async startTrial(input: { actorId: string; workspaceId?: string; subscriptionId?: string; planCode: string; days: number; reason?: string; adminRegrant: boolean; actorIsAdmin?: boolean }) {
    if (input.adminRegrant) await this.requireAdmin(input.actorId);
    const row = await this.load(input);
    const plan = await this.planByCode(input.planCode);
    const decision = decideStartTrial({
      trialDays: input.days,
      trialConsumedAt: row.workspace.trialConsumedAt?.toISOString() ?? null,
      adminRegrant: input.adminRegrant,
      reason: input.reason,
      now: new Date(),
      planCode: plan.code,
    });
    if (!decision.ok) throw new BadRequestException(decision.message);
    if (input.adminRegrant) this.reasonOrThrow(input.reason);
    await this.prisma.workspace.update({ where: { id: row.workspaceId }, data: { trialConsumedAt: new Date(decision.value.trialConsumedAt) } });
    await this.prisma.subscription.update({
      where: { id: row.id },
      data: {
        planId: plan.id,
        planVersionId: (await this.openVersion(plan.id))?.id,
        status: SubscriptionStatus.TRIALING,
        source: 'TRIAL',
        trialStartedAt: new Date(decision.value.trialStartedAt),
        trialEndsAt: new Date(decision.value.trialEndsAt),
        cancelAtPeriodEnd: false,
      },
    });
    await this.record(row, input.actorId, 'TRIAL_STARTED', row.planId, plan.id, 'TRIAL', input.reason ?? '首次试用', decision.value.trialEndsAt);
    return { ok: true, status: 'TRIALING', trialEndsAt: decision.value.trialEndsAt };
  }

  async activate(input: { actorId: string; subscriptionId: string; planCode: string; reason?: string }) {
    await this.requireAdmin(input.actorId);
    const reason = this.reasonOrThrow(input.reason);
    const row = await this.load(input);
    const plan = await this.planByCode(input.planCode);
    const decision = decideActivate({ actorIsAdmin: true, now: new Date(), timeZone: row.workspace.timezone || 'Asia/Shanghai' });
    if (!decision.ok) throw new BadRequestException(decision.message);
    await this.prisma.subscription.update({
      where: { id: row.id },
      data: {
        planId: plan.id,
        planVersionId: (await this.openVersion(plan.id))?.id,
        status: SubscriptionStatus.ACTIVE,
        source: 'MANUAL_ADMIN',
        activationSource: 'MANUAL_ADMIN',
        paymentStatus: 'NOT_APPLICABLE',
        currentPeriodStart: new Date(decision.value.currentPeriodStart),
        currentPeriodEnd: new Date(decision.value.currentPeriodEnd),
        manualAutoExtension: false,
        cancelAtPeriodEnd: false,
        pendingPlanId: null,
        planChangeEffectiveAt: null,
      },
    });
    await this.record(row, input.actorId, 'SUBSCRIPTION_ACTIVATED', row.planId, plan.id, 'MANUAL_ADMIN', reason, decision.value.currentPeriodStart);
    await this.prisma.auditLog.create({
      data: {
        workspaceId: row.workspaceId,
        userId: input.actorId,
        action: 'MANUAL_SUBSCRIPTION_ACTIVATED',
        metadata: sanitizeAdminAuditMetadata({ activationSource: 'MANUAL_ADMIN', paymentStatus: 'NOT_APPLICABLE', reason }),
      },
    });
    return { ok: true, status: 'ACTIVE', source: 'MANUAL_ADMIN', paymentStatus: 'NOT_APPLICABLE', isRevenueGenerating: false };
  }

  async fulfillPaidOrder(orderId: string) {
    return fulfillCommercialOrder(this.prisma, orderId, null);
  }

  async changePlan(input: { actorId: string; subscriptionId: string; planCode: string; reason?: string }) {
    await this.requireAdmin(input.actorId);
    const reason = this.reasonOrThrow(input.reason);
    const row = await this.load(input);
    const plan = await this.planByCode(input.planCode);
    const quota = await this.engine.evaluateWorkspaceQuota(row.workspaceId, { audit: false });
    const decision = decidePlanChange({
      fromCode: row.plan.code,
      toCode: plan.code,
      fromPlanId: row.planId,
      toPlanId: plan.id,
      currentPeriodEnd: row.currentPeriodEnd.toISOString(),
      usage: {
        projects: quota.usage.projectCount,
        members: quota.usage.memberCount,
        deployments: quota.usage.deploymentCount,
        servers: quota.usage.serverCount,
        databases: quota.usage.databaseCount,
        redis: quota.usage.redisCount,
      },
      targetLimits: {
        projects: plan.maxProjects,
        members: plan.maxMembers,
        deployments: plan.maxDeploymentsPerMonth,
        servers: plan.maxServers,
        databases: plan.maxDatabases,
        redis: plan.maxRedisInstances,
      },
    });
    if (!decision.ok) throw new BadRequestException(decision.message);
    if (decision.value.mode === 'immediate') {
      await this.prisma.subscription.update({
        where: { id: row.id },
        data: { planId: plan.id, planVersionId: (await this.openVersion(plan.id))?.id, pendingPlanId: null, planChangeEffectiveAt: null, source: row.source === 'DEFAULT_FREE' ? 'MANUAL_ADMIN' : row.source },
      });
    } else {
      await this.prisma.subscription.update({
        where: { id: row.id },
        data: { pendingPlanId: plan.id, planChangeEffectiveAt: new Date(decision.value.planChangeEffectiveAt ?? row.currentPeriodEnd) },
      });
    }
    await this.record(row, input.actorId, decision.value.eventType, row.planId, plan.id, row.source, reason, decision.value.planChangeEffectiveAt ?? new Date().toISOString(), {
      warning: decision.value.warning,
    });
    return { ok: true, mode: decision.value.mode, warning: decision.value.warning, pendingPlanId: decision.value.pendingPlanId };
  }

  async scheduleCancellation(input: { actorId: string; workspaceId?: string; subscriptionId?: string; reason?: string; requireAdminReason: boolean }) {
    if (input.requireAdminReason) {
      await this.requireAdmin(input.actorId);
      this.reasonOrThrow(input.reason);
    }
    const row = await this.load(input);
    const decision = decideScheduleCancellation({ planCode: row.plan.code, currentPeriodEnd: row.currentPeriodEnd.toISOString() });
    if (!decision.ok) throw new BadRequestException(decision.message);
    await this.prisma.subscription.update({
      where: { id: row.id },
      data: { status: SubscriptionStatus.CANCEL_AT_PERIOD_END, cancelAtPeriodEnd: true },
    });
    await this.record(row, input.actorId, 'SUBSCRIPTION_CANCEL_SCHEDULED', row.planId, row.planId, row.source, input.reason ?? '用户预约取消', row.currentPeriodEnd.toISOString());
    await this.saveIntent(row.workspaceId, 'SUBSCRIPTION_ENDING', row.currentPeriodEnd.toISOString());
    return { ok: true, status: 'CANCEL_AT_PERIOD_END', statusLabel: subscriptionStatusLabel('CANCEL_AT_PERIOD_END') };
  }

  async cancelNow(input: { actorId: string; subscriptionId: string; confirmation: string; reason?: string }) {
    await this.requireAdmin(input.actorId);
    const reason = this.reasonOrThrow(input.reason);
    const decision = decideImmediateCancel({ actorIsAdmin: true, confirmation: input.confirmation, reason });
    if (!decision.ok) throw new BadRequestException(decision.message);
    const row = await this.load(input);
    const free = await this.planByCode('free');
    const workspaceBefore = row.workspace.status;
    await this.prisma.subscription.update({
      where: { id: row.id },
      data: {
        planId: free.id,
        planVersionId: (await this.openVersion(free.id))?.id,
        status: SubscriptionStatus.CANCELED,
        source: 'DEFAULT_FREE',
        cancelAtPeriodEnd: false,
        pendingPlanId: null,
        planChangeEffectiveAt: null,
      },
    });
    const workspaceAfter = await this.prisma.workspace.findUnique({ where: { id: row.workspaceId }, select: { status: true } });
    await this.record(row, input.actorId, 'SUBSCRIPTION_CANCELED', row.planId, free.id, 'DEFAULT_FREE', reason, new Date().toISOString(), {
      keepsRunningServices: true,
      workspaceStatus: workspaceBefore,
    });
    return { ok: true, status: 'CANCELED', workspaceStatus: workspaceAfter?.status ?? workspaceBefore, keepsRunningServices: true };
  }

  async resume(input: { actorId: string; workspaceId?: string; subscriptionId?: string; reason?: string; requireAdminReason: boolean }) {
    if (input.requireAdminReason) {
      await this.requireAdmin(input.actorId);
      this.reasonOrThrow(input.reason);
    }
    const row = await this.load(input);
    const decision = decideResume({ status: row.status, currentPeriodEnd: row.currentPeriodEnd.toISOString(), now: new Date() });
    if (!decision.ok) throw new BadRequestException(decision.message);
    await this.prisma.subscription.update({
      where: { id: row.id },
      data: { status: SubscriptionStatus.ACTIVE, cancelAtPeriodEnd: false },
    });
    await this.record(row, input.actorId, 'SUBSCRIPTION_RESUMED', row.planId, row.planId, row.source, input.reason ?? '用户取消预约', new Date().toISOString());
    return { ok: true, status: 'ACTIVE' };
  }

  async extendPeriod(input: { actorId: string; subscriptionId: string; days: number; reason?: string }) {
    await this.requireAdmin(input.actorId);
    const reason = this.reasonOrThrow(input.reason);
    if (input.days <= 0) throw new BadRequestException('延长天数无效');
    const row = await this.load(input);
    const end = new Date(row.currentPeriodEnd.getTime() + input.days * 24 * 60 * 60 * 1000);
    await this.prisma.subscription.update({ where: { id: row.id }, data: { currentPeriodEnd: end } });
    await this.record(row, input.actorId, 'SUBSCRIPTION_PERIOD_EXTENDED', row.planId, row.planId, row.source, reason, end.toISOString());
    return { ok: true, currentPeriodEnd: end.toISOString() };
  }

  async grantComplimentary(input: { actorId: string; subscriptionId: string; planCode: string; days: number; reason?: string }) {
    await this.requireAdmin(input.actorId);
    const reason = this.reasonOrThrow(input.reason);
    const row = await this.load(input);
    const plan = await this.planByCode(input.planCode);
    const decision = decideComplimentary({ actorIsAdmin: true, days: input.days, reason, now: new Date(), planCode: plan.code });
    if (!decision.ok) throw new BadRequestException(decision.message);
    await this.prisma.subscription.update({
      where: { id: row.id },
      data: {
        planId: plan.id,
        planVersionId: (await this.openVersion(plan.id))?.id,
        fallbackPlanId: row.planId,
        status: SubscriptionStatus.ACTIVE,
        source: 'COMPLIMENTARY',
        complimentaryUntil: new Date(decision.value.complimentaryUntil),
        complimentaryReason: reason,
        grantedById: input.actorId,
        cancelAtPeriodEnd: false,
      },
    });
    await this.record(row, input.actorId, 'COMPLIMENTARY_GRANTED', row.planId, plan.id, 'COMPLIMENTARY', reason, decision.value.complimentaryUntil);
    return { ok: true, source: 'COMPLIMENTARY', isRevenueGenerating: false, complimentaryUntil: decision.value.complimentaryUntil };
  }

  async detail(adminId: string, subscriptionId: string) {
    await this.requireAdmin(adminId);
    const row = await this.load({ subscriptionId });
    const quota = await this.engine.evaluateWorkspaceQuota(row.workspaceId, { audit: false });
    const entitlements = await this.entitlementsFor(row.workspaceId);
    const [events, invoices] = await Promise.all([
      this.prisma.subscriptionEvent.findMany({ where: { subscriptionId: row.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
      this.prisma.invoice.findMany({ where: { workspaceId: row.workspaceId }, orderBy: { createdAt: 'desc' }, take: 20 }),
    ]);
    return {
      id: row.id,
      workspace: { id: row.workspace.id, name: row.workspace.name, status: row.workspace.status, timezone: row.workspace.timezone },
      owner: { name: row.workspace.owner.name, email: row.workspace.owner.email },
      currentPlan: { id: row.plan.id, code: row.plan.code, name: row.plan.name },
      pendingPlan: row.pendingPlan ? { id: row.pendingPlan.id, code: row.pendingPlan.code, name: row.pendingPlan.name, effectiveAt: row.planChangeEffectiveAt } : null,
      status: row.status,
      statusLabel: subscriptionStatusLabel(row.status),
      source: row.source,
      sourceLabel: SOURCE_LABELS[row.source] ?? row.source,
      isRevenueGenerating: isRevenueGenerating(row.source),
      activationSource: row.activationSource,
      trialStartedAt: row.trialStartedAt,
      trialEndsAt: row.trialEndsAt,
      complimentaryUntil: row.complimentaryUntil,
      complimentaryReason: row.complimentaryReason,
      currentPeriodStart: row.currentPeriodStart,
      currentPeriodEnd: row.currentPeriodEnd,
      cancelAtPeriodEnd: row.cancelAtPeriodEnd,
      manualAutoExtension: row.manualAutoExtension,
      externalCustomerId: row.externalCustomerId,
      externalSubscriptionId: row.externalSubscriptionId,
      externalPriceId: row.externalPriceId,
      usage: quota.usage,
      quota: quota.quota,
      overallStatus: quota.overallStatus,
      entitlements,
      commercial: presentCommercialSummary({
        planName: row.plan.name,
        priceMonthly: row.planVersion?.priceMonthly ?? row.plan.priceMonthly,
        contactSales: row.plan.contactSales,
        currency: row.plan.currency,
        estimatedCloudCost: quota.usage.estimatedCloudCost,
      }),
      margin: estimateGrossMargin({
        isRevenueGenerating: isRevenueGenerating(row.source),
        priceMonthly: row.planVersion?.priceMonthly ?? row.plan.priceMonthly,
        estimatedCloudCost: quota.usage.estimatedCloudCost,
      }),
      events,
      invoices,
    };
  }

  async entitlements(workspaceId: string) {
    return this.entitlementsFor(workspaceId);
  }

  async processDue(now = new Date()) {
    return processSubscriptionLifecycle(this.prisma, now);
  }

  private async entitlementsFor(workspaceId: string) {
    const row = await this.prisma.subscription.findFirst({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      include: { plan: true, planVersion: true },
    });
    const free = await this.planByCode('free');
    const features = assertFeatureFlags(row?.planVersion?.featuresJson ?? row?.plan.featuresJson ?? {});
    const freeFeatures = assertFeatureFlags(free.featuresJson ?? {});
    const limits = row?.planVersion?.limitsJson && typeof row.planVersion.limitsJson === 'object' && !Array.isArray(row.planVersion.limitsJson)
      ? this.limits({
          maxProjects: this.jsonLimit(row.planVersion.limitsJson, 'maxProjects', row.plan.maxProjects),
          maxMembers: this.jsonLimit(row.planVersion.limitsJson, 'maxMembers', row.plan.maxMembers),
          maxDeploymentsPerMonth: this.jsonLimit(row.planVersion.limitsJson, 'maxDeploymentsPerMonth', row.plan.maxDeploymentsPerMonth),
          maxBuildMinutesPerMonth: this.jsonLimit(row.planVersion.limitsJson, 'maxBuildMinutesPerMonth', row.plan.maxBuildMinutesPerMonth),
          maxServers: this.jsonLimit(row.planVersion.limitsJson, 'maxServers', row.plan.maxServers),
          maxDatabases: this.jsonLimit(row.planVersion.limitsJson, 'maxDatabases', row.plan.maxDatabases),
          maxRedisInstances: this.jsonLimit(row.planVersion.limitsJson, 'maxRedisInstances', row.plan.maxRedisInstances),
        })
      : row ? this.limits(row.plan) : this.limits(free);
    return resolveWorkspaceEntitlements({
      status: row?.status ?? 'ACTIVE',
      source: row?.source ?? 'DEFAULT_FREE',
      features: features.ok ? features.flags : {},
      limits,
      freeFeatures: freeFeatures.ok ? freeFeatures.flags : {},
      freeLimits: this.limits(free),
    });
  }

  private jsonLimit(value: unknown, key: string, fallback: number | null) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !(key in value)) return fallback;
    const item = (value as Record<string, unknown>)[key];
    if (item == null) return null;
    const parsed = Number(item);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private limits(plan: { maxProjects: number | null; maxMembers: number | null; maxDeploymentsPerMonth: number | null; maxBuildMinutesPerMonth: number | null; maxServers: number | null; maxDatabases: number | null; maxRedisInstances: number | null }) {
    return {
      maxProjects: plan.maxProjects,
      maxMembers: plan.maxMembers,
      maxDeploymentsPerMonth: plan.maxDeploymentsPerMonth,
      maxBuildMinutesPerMonth: plan.maxBuildMinutesPerMonth,
      maxServers: plan.maxServers,
      maxDatabases: plan.maxDatabases,
      maxRedisInstances: plan.maxRedisInstances,
    };
  }

  private async load(input: { workspaceId?: string; subscriptionId?: string }) {
    const row = input.subscriptionId
      ? await this.prisma.subscription.findUnique({
          where: { id: input.subscriptionId },
          include: { plan: true, pendingPlan: true, planVersion: true, workspace: { include: { owner: true } } },
        })
      : await this.prisma.subscription.findFirst({
          where: { workspaceId: input.workspaceId },
          orderBy: { createdAt: 'desc' },
          include: { plan: true, pendingPlan: true, planVersion: true, workspace: { include: { owner: true } } },
        });
    if (!row) throw new NotFoundException('订阅不存在');
    return row;
  }

  private async planByCode(code: string) {
    const plan = await this.prisma.plan.findUnique({ where: { code } });
    if (!plan || plan.status !== 'ACTIVE') throw new NotFoundException('套餐不存在');
    return plan;
  }

  private async record(
    row: { id: string; workspaceId: string },
    actorId: string,
    eventType: string,
    fromPlanId: string,
    toPlanId: string,
    source: string,
    reason: string,
    effectiveAt: string,
    extra: Record<string, string | number | boolean | null> = {},
  ) {
    const metadata = sanitizeAdminAuditMetadata({ reason, ...extra });
    await this.prisma.subscriptionEvent.create({
      data: {
        workspaceId: row.workspaceId,
        subscriptionId: row.id,
        eventType,
        fromPlanId,
        toPlanId,
        effectiveAt: new Date(effectiveAt),
        actorUserId: actorId,
        source,
        metadataSafe: metadata as Prisma.InputJsonValue,
        idempotencyKey: `${row.id}:${eventType}:${effectiveAt}:${actorId}`,
      },
    });
    await this.prisma.auditLog.create({
      data: { workspaceId: row.workspaceId, userId: actorId, action: eventType, metadata: metadata as Prisma.InputJsonValue },
    });
    const intents = notificationIntents({
      now: new Date(),
      trialEndsAt: eventType === 'TRIAL_STARTED' ? effectiveAt : null,
      status: eventType === 'SUBSCRIPTION_CANCEL_SCHEDULED' ? 'CANCEL_AT_PERIOD_END' : 'ACTIVE',
      currentPeriodEnd: effectiveAt,
      pendingPlanCode: eventType === 'SUBSCRIPTION_DOWNGRADE_SCHEDULED' ? 'pending' : null,
      quotaNear: false,
    });
    for (const intent of intents) await this.saveIntent(row.workspaceId, intent.type, intent.periodKey);
  }

  private async saveIntent(workspaceId: string, type: string, periodKey: string) {
    try {
      await this.prisma.notificationIntent.create({ data: { workspaceId, type, periodKey } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return;
      throw error;
    }
  }

  private reasonOrThrow(reason: string | undefined) {
    const parsed = requireReason(reason);
    if (!parsed.ok) throw new BadRequestException(parsed.message);
    return parsed.value;
  }

  private async requireAdmin(userId: string) {
    if (!(await this.isAdmin(userId))) throw new ForbiddenException('需要平台管理员权限');
  }

  private async currentWorkspace(userId: string) {
    const membership = await this.prisma.workspaceMember.findFirst({ where: { userId }, orderBy: { createdAt: 'asc' } });
    if (!membership) throw new ForbiddenException('没有可用的工作空间');
    return membership;
  }

  private openVersion(planId: string) {
    return this.prisma.planVersion.findFirst({ where: { planId, effectiveTo: null }, orderBy: { version: 'desc' } });
  }

  private async isAdmin(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { platformRole: true } });
    return user?.platformRole === 'PLATFORM_ADMIN';
  }
}
