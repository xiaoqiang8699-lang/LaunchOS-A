import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PlanStatus, Prisma, SubscriptionStatus } from '@launchos/database';
import {
  EFFECTIVE_SUBSCRIPTION_STATUSES,
  assertFeatureFlags,
  assertPlanCodeChange,
  buildMinutesFromMilliseconds,
  countsAsDeployment,
  evaluateUsageAgainstPlan,
  isBuildStep,
  memberLimitDecision,
  nearLimitCopy,
  projectCountsTowardQuota,
  projectLimitDecision,
  resolveEffectivePlan,
  resolveUsagePeriod,
  sanitizeAdminAuditMetadata,
  shanghaiNaturalMonth,
  subscriptionStatusLabel,
  sumMeasuredBuildMilliseconds,
  unavailablePaymentProvider,
  usageWarning,
  assertPlanReferences,
  canAssignPlan,
  formatUpgradeReason,
  recommendBestPlan,
  type PlanLimits,
  type UsageCounts,
} from '@launchos/domain';
import { PrismaService } from '../database/prisma.service';

type PlanRecord = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  priceMonthly: number;
  currency: string;
  status: string;
  maxProjects: number | null;
  maxMembers: number | null;
  maxDeploymentsPerMonth: number | null;
  maxBuildMinutesPerMonth: number | null;
  maxServers: number | null;
  maxDatabases: number | null;
  maxRedisInstances: number | null;
  featuresJson: Prisma.JsonValue;
  priceYearly?: number | null;
  contactSales?: boolean;
  audience?: string | null;
  marketingDescription?: string | null;
  highlighted?: boolean;
  displayOrder?: number;
  grandfathered?: boolean;
};

@Injectable()
export class SubscriptionEngineService {
  constructor(private readonly prisma: PrismaService) {}

  async ensureDefaultFree(workspaceId: string, actorId: string | null) {
    const resolved = await this.resolveEffectivePlan(workspaceId, actorId);
    return resolved;
  }

  async resolveEffectivePlan(workspaceId: string, actorId: string | null = null) {
    const freePlan = await this.requirePlan('free');
    const subscription = await this.prisma.subscription.findFirst({
      where: { workspaceId },
      include: { plan: true, planVersion: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!subscription) {
      const period = shanghaiNaturalMonth(new Date());
      const version = await this.openVersion(freePlan.id);
      const created = await this.prisma.subscription.create({
        data: {
          workspaceId,
          planId: freePlan.id,
          planVersionId: version?.id,
          status: SubscriptionStatus.ACTIVE,
          currentPeriodStart: period.start,
          currentPeriodEnd: period.end,
        },
        include: { plan: true, planVersion: true },
      });
      if (actorId) await this.audit(actorId, workspaceId, 'SUBSCRIPTION_CREATED', { planCode: 'free', source: 'DEFAULT_FREE' });
      return resolveEffectivePlan({ freePlan: this.withVersion(freePlan, created.planVersion), subscription: { ...created, plan: this.withVersion(created.plan, created.planVersion) } });
    }
    return resolveEffectivePlan({
      freePlan: this.withVersion(freePlan, subscription.plan.code === 'free' ? subscription.planVersion : await this.openVersion(freePlan.id)),
      subscription: { ...subscription, plan: this.withVersion(subscription.plan, subscription.planVersion) },
    });
  }

  async aggregateWorkspaceUsage(workspaceId: string, period: { start: Date; end: Date }) {
    const [projects, members, deployments, steps, artifacts, activeServices, servers, databases, redis] = await Promise.all([
      this.prisma.project.findMany({ where: { workspaceId }, select: { status: true, isDemo: true } }),
      this.prisma.workspaceMember.findMany({ where: { workspaceId }, select: { id: true } }),
      this.prisma.deployment.findMany({
        where: { project: { workspaceId }, createdAt: { gte: period.start, lt: period.end } },
        select: { status: true, usageClass: true },
      }),
      this.prisma.deploymentStep.findMany({
        where: {
          deployment: {
            project: { workspaceId },
            usageClass: 'REAL_EXECUTION',
            createdAt: { gte: period.start, lt: period.end },
          },
        },
        select: { stepKey: true, duration: true },
      }),
      this.prisma.artifact.count({
        where: {
          type: 'BUILD_OUTPUT',
          deployment: { project: { workspaceId }, usageClass: 'REAL_EXECUTION', createdAt: { gte: period.start, lt: period.end } },
        },
      }),
      this.prisma.serviceInstance.count({ where: { project: { workspaceId }, status: 'RUNNING' } }),
      this.prisma.serverInstance.count({ where: { workspaceId } }),
      this.prisma.databaseConnection.count({ where: { workspaceId } }),
      this.prisma.redisConnection.count({ where: { workspaceId } }),
    ]);
    const counted = deployments.filter((row) => countsAsDeployment(row));
    const buildDurations = steps.filter((step) => isBuildStep(step.stepKey)).map((step) => step.duration);
    const buildMilliseconds = sumMeasuredBuildMilliseconds(buildDurations);
    return {
      projectCount: projects.filter((project) => projectCountsTowardQuota(project)).length,
      memberCount: members.length,
      deploymentCount: counted.length,
      successfulDeploymentCount: counted.filter((row) => row.status === 'SUCCESS').length,
      failedDeploymentCount: counted.filter((row) => row.status === 'FAILED').length,
      buildCount: artifacts,
      buildDurationSeconds: buildMilliseconds == null ? null : Math.ceil(buildMilliseconds / 1000),
      buildMinutes: buildMinutesFromMilliseconds(buildMilliseconds),
      activeServiceCount: activeServices,
      serverCount: servers,
      databaseCount: databases,
      redisCount: redis,
      bandwidthBytes: null as number | null,
      storageBytes: null as number | null,
      estimatedCloudCost: null as number | null,
      estimated: true as const,
    };
  }

  async evaluateWorkspaceQuota(workspaceId: string, options?: { audit?: boolean; actorId?: string | null }) {
    const resolved = await this.resolveEffectivePlan(workspaceId, options?.actorId ?? null);
    const period = resolveUsagePeriod({
      planCode: resolved.plan.code,
      currentPeriodStart: resolved.subscription?.currentPeriodStart,
      currentPeriodEnd: resolved.subscription?.currentPeriodEnd,
    });
    const usage = await this.aggregateWorkspaceUsage(workspaceId, period);
    const limits = this.limitsOf(resolved.plan);
    const counts: UsageCounts = {
      projects: usage.projectCount,
      members: usage.memberCount,
      deployments: usage.deploymentCount,
      buildMinutes: usage.buildMinutes,
      servers: usage.serverCount,
      databases: usage.databaseCount,
      redis: usage.redisCount,
    };
    const evaluated = evaluateUsageAgainstPlan({ limits, usage: counts });
    const deploymentWarning = usageWarning({ kind: 'deployments', used: counts.deployments, limit: limits.deployments });
    const buildWarning = usageWarning({ kind: 'buildMinutes', used: counts.buildMinutes, limit: limits.buildMinutes });
    const quotaExceeded = Boolean(resolved.subscription?.quotaExceeded) || deploymentWarning.quotaExceeded || buildWarning.quotaExceeded;
    if (options?.audit !== false && resolved.subscription && quotaExceeded) {
      await this.prisma.subscription.update({ where: { id: resolved.subscription.id }, data: { quotaExceeded: true } });
    }
    if (options?.audit !== false && options?.actorId) {
      await this.recordQuotaSignal(options.actorId, workspaceId, evaluated.overallStatus, period.start);
    }
    const sellable = await this.prisma.plan.findMany({
      where: { code: { in: ['pro', 'team', 'enterprise'] } },
      select: { code: true, maxProjects: true, maxMembers: true },
    });
    const recommendationResult = recommendBestPlan({
      currentPlan: resolved.plan.code,
      usage: {
        projects: counts.projects,
        members: counts.members,
        deployments: counts.deployments,
        buildMinutes: counts.buildMinutes,
        servers: counts.servers,
        databases: counts.databases,
        redis: counts.redis,
      },
      limits,
      catalog: Object.fromEntries(sellable.map((plan) => [plan.code, { projects: plan.maxProjects, members: plan.maxMembers }])),
    });
    const recommendation = {
      currentPlan: recommendationResult.currentPlan,
      recommendedPlan: recommendationResult.recommendedPlan,
      reason: recommendationResult.reasons[0] ?? null,
      reasons: recommendationResult.reasons,
    };
    return {
      effectivePlan: this.presentPlan(resolved.plan),
      subscription: resolved.subscription ? { ...this.presentSubscription(resolved.subscription), quotaExceeded } : null,
      source: resolved.source,
      period,
      usage,
      quota: evaluated.quota,
      overallStatus: evaluated.overallStatus,
      recommendation,
      blocksService: false as const,
    };
  }

  async recommendPlanUpgrade(workspaceId: string) {
    const quota = await this.evaluateWorkspaceQuota(workspaceId, { audit: false });
    return quota.recommendation;
  }

  async assertCanCreateProject(userId: string, workspaceId: string) {
    if (await this.isPlatformAdmin(userId)) return;
    const quota = await this.evaluateWorkspaceQuota(workspaceId, { audit: false, actorId: userId });
    const decision = projectLimitDecision({
      used: quota.usage.projectCount,
      limit: quota.quota.projects.limit,
    });
    if (!decision.ok) {
      const message = await this.upgradeMessage(quota.effectivePlan.code, quota.usage.projectCount, quota.quota.projects.limit, '个应用', 'maxProjects');
      await this.audit(userId, workspaceId, 'PLAN_LIMIT_REACHED', { resource: 'projects', limit: message });
      throw new ForbiddenException({ code: decision.code, message });
    }
  }

  async assertCanInviteMember(userId: string, workspaceId: string) {
    if (await this.isPlatformAdmin(userId)) return;
    const quota = await this.evaluateWorkspaceQuota(workspaceId, { audit: false, actorId: userId });
    const decision = memberLimitDecision({
      used: quota.usage.memberCount,
      limit: quota.quota.members.limit,
    });
    if (!decision.ok) {
      const message = await this.upgradeMessage(quota.effectivePlan.code, quota.usage.memberCount, quota.quota.members.limit, '名成员', 'maxMembers');
      await this.audit(userId, workspaceId, 'PLAN_LIMIT_REACHED', { resource: 'members', limit: message });
      throw new ForbiddenException({ code: decision.code, message });
    }
  }

  async noteDeploymentQuota(userId: string, workspaceId: string) {
    const quota = await this.evaluateWorkspaceQuota(workspaceId, { audit: false, actorId: userId });
    const deployment = usageWarning({ kind: 'deployments', used: quota.usage.deploymentCount, limit: quota.quota.deployments.limit });
    const build = usageWarning({ kind: 'buildMinutes', used: quota.usage.buildMinutes, limit: quota.quota.buildMinutes.limit });
    const hard = quota.quota.deployments;
    if (hard.limit != null && hard.used != null && hard.used >= hard.limit) {
      if (quota.subscription) {
        await this.prisma.subscription.update({ where: { id: quota.subscription.id }, data: { quotaExceeded: true } });
        await this.recordQuotaSignal(userId, workspaceId, 'OVER_LIMIT', quota.period.start);
      }
      throw new ForbiddenException({
        statusCode: 403,
        code: 'DEPLOYMENT_QUOTA_EXCEEDED',
        message: '本月上线次数已用完。',
        limit: hard.limit,
        used: hard.used,
        remaining: 0,
        plan: quota.effectivePlan.code,
        upgradeAvailable: quota.effectivePlan.code !== 'enterprise',
        action: { label: '查看套餐', href: '/account/subscription/plans' },
      });
    }
    const quotaExceeded = deployment.quotaExceeded || build.quotaExceeded;
    if (quotaExceeded && quota.subscription) {
      await this.prisma.subscription.update({ where: { id: quota.subscription.id }, data: { quotaExceeded: true } });
      await this.recordQuotaSignal(userId, workspaceId, 'OVER_LIMIT', quota.period.start);
    } else if (quota.overallStatus === 'NEAR_LIMIT') {
      await this.recordQuotaSignal(userId, workspaceId, 'NEAR_LIMIT', quota.period.start);
    }
    return {
      blocks: false as const,
      quotaExceeded,
      message: deployment.message ?? build.message ?? (quota.overallStatus === 'NEAR_LIMIT' ? nearLimitCopy() : null),
    };
  }

  async subscriptionView(userId: string) {
    const workspaceId = await this.currentWorkspaceId(userId);
    const quota = await this.evaluateWorkspaceQuota(workspaceId, { audit: true, actorId: userId });
    const history = await this.prisma.workspaceUsageSnapshot.findMany({
      where: { workspaceId, periodEnd: { lte: quota.period.start } },
      orderBy: { periodStart: 'desc' },
      take: 6,
    });
    return {
      ...quota,
      paymentConnected: false,
      canCancel: quota.effectivePlan.code !== 'free',
      upgrade: await unavailablePaymentProvider.createCheckout({ workspaceId, planCode: quota.recommendation.recommendedPlan ?? 'pro' }),
      history,
    };
  }

  async requestUpgrade(userId: string, planCode: string) {
    const workspaceId = await this.currentWorkspaceId(userId);
    const plan = await this.prisma.plan.findUnique({ where: { code: planCode } });
    if (!plan || plan.status !== 'ACTIVE') throw new NotFoundException('套餐不存在');
    const checkout = await unavailablePaymentProvider.createCheckout({ workspaceId, planCode });
    return checkout;
  }

  async scheduleCancel(userId: string) {
    await this.currentWorkspaceId(userId);
    throw new BadRequestException('请通过订阅生命周期预约取消');
  }

  async listSubscriptions(adminId: string, query: { q?: string; planCode?: string; status?: string; page?: string; pageSize?: string }) {
    await this.requirePlatformAdmin(adminId);
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(query.pageSize) || 20));
    const q = query.q?.trim();
    const where: Prisma.SubscriptionWhereInput = {
      ...(query.planCode ? { plan: { code: query.planCode } } : {}),
      ...(query.status ? { status: query.status as SubscriptionStatus } : {}),
      ...(q
        ? {
            OR: [
              { workspace: { name: { contains: q, mode: 'insensitive' } } },
              { workspace: { owner: { name: { contains: q, mode: 'insensitive' } } } },
              { workspace: { owner: { email: { contains: q, mode: 'insensitive' } } } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.subscription.count({ where }),
      this.prisma.subscription.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { plan: true, workspace: { select: { id: true, name: true, owner: { select: { name: true, email: true } } } } },
      }),
    ]);
    const items = await Promise.all(rows.map(async (row) => {
      const quota = await this.evaluateWorkspaceQuota(row.workspaceId, { audit: false });
      return {
        id: row.id,
        workspace: row.workspace.name,
        workspaceId: row.workspace.id,
        owner: row.workspace.owner.name || row.workspace.owner.email,
        plan: row.plan.name,
        planCode: row.plan.code,
        status: row.status,
        statusLabel: subscriptionStatusLabel(row.status),
        currentPeriodStart: row.currentPeriodStart,
        currentPeriodEnd: row.currentPeriodEnd,
        usage: { projects: quota.usage.projectCount, members: quota.usage.memberCount, deployments: quota.usage.deploymentCount },
        overallStatus: quota.overallStatus,
        quotaExceeded: row.quotaExceeded || quota.overallStatus === 'OVER_LIMIT',
        createdAt: row.createdAt,
      };
    }));
    return { page, pageSize, total, items };
  }

  async simulateStatus(adminId: string, subscriptionId: string, status: string, reason: string) {
    await this.requirePlatformAdmin(adminId);
    void subscriptionId;
    void status;
    void reason;
    throw new BadRequestException('请使用订阅生命周期操作，不能直接改状态');
  }

  async listPlans(adminId: string) {
    await this.requirePlatformAdmin(adminId);
    const plans = await this.prisma.plan.findMany({
      orderBy: [{ displayOrder: 'asc' }, { priceMonthly: 'asc' }],
      include: { _count: { select: { subscriptions: true, versions: true, invoices: true } } },
    });
    return plans.map((plan) => ({
      ...this.presentPlan(plan),
      subscriptionCount: plan._count.subscriptions,
      versionCount: plan._count.versions,
      invoiceCount: plan._count.invoices,
    }));
  }

  async createPlan(adminId: string, body: Record<string, unknown>) {
    await this.requirePlatformAdmin(adminId);
    const code = String(body.code ?? '').trim().toLowerCase();
    const name = String(body.name ?? '').trim();
    if (!code || !name) throw new BadRequestException('套餐代码和名称不能为空');
    const flags = assertFeatureFlags(body.featuresJson ?? {});
    if (!flags.ok) throw new BadRequestException(flags.message);
    try {
      const limits = this.limitValues(body);
      const created = await this.prisma.plan.create({
        data: {
          code,
          name,
          description: this.optionalText(body.description),
          audience: this.optionalText(body.audience),
          marketingDescription: this.optionalText(body.marketingDescription),
          recommendationLabel: this.optionalText(body.recommendationLabel),
          priceMonthly: this.money(body.priceMonthly),
          priceYearly: body.priceYearly == null || body.priceYearly === '' ? null : this.money(body.priceYearly),
          currency: String(body.currency ?? 'CNY'),
          contactSales: body.contactSales === true,
          highlighted: body.highlighted === true,
          displayOrder: Number(body.displayOrder ?? 0) || 0,
          status: body.status === 'DRAFT' ? PlanStatus.DRAFT : PlanStatus.ACTIVE,
          maxProjects: limits.maxProjects,
          maxMembers: limits.maxMembers,
          maxDeploymentsPerMonth: limits.maxDeploymentsPerMonth,
          maxBuildMinutesPerMonth: limits.maxBuildMinutesPerMonth,
          maxServers: limits.maxServers,
          maxDatabases: limits.maxDatabases,
          maxRedisInstances: limits.maxRedisInstances,
          featuresJson: flags.flags,
        },
      });
      await this.publishVersion(created.id);
      return created;
    } catch {
      throw new ConflictException('套餐代码已存在');
    }
  }

  async updatePlan(adminId: string, planId: string, body: Record<string, unknown>) {
    await this.requirePlatformAdmin(adminId);
    const current = await this.prisma.plan.findUnique({ where: { id: planId }, include: { _count: { select: { subscriptions: true } } } });
    if (!current) throw new NotFoundException('套餐不存在');
    if (body.code !== undefined) {
      const decision = assertPlanCodeChange({
        currentCode: current.code,
        nextCode: String(body.code).trim().toLowerCase(),
        subscriptionCount: current._count.subscriptions,
      });
      if (!decision.ok) throw new ConflictException(decision.message);
    }
    const flags = body.featuresJson === undefined ? null : assertFeatureFlags(body.featuresJson);
    if (flags && !flags.ok) throw new BadRequestException(flags.message);
    const updated = await this.prisma.plan.update({
      where: { id: planId },
      data: {
        ...(body.code !== undefined ? { code: String(body.code).trim().toLowerCase() } : {}),
        ...(body.name !== undefined ? { name: String(body.name).trim() } : {}),
        ...(body.description !== undefined ? { description: this.optionalText(body.description) } : {}),
        ...(body.audience !== undefined ? { audience: this.optionalText(body.audience) } : {}),
        ...(body.marketingDescription !== undefined ? { marketingDescription: this.optionalText(body.marketingDescription) } : {}),
        ...(body.recommendationLabel !== undefined ? { recommendationLabel: this.optionalText(body.recommendationLabel) } : {}),
        ...(body.priceMonthly !== undefined ? { priceMonthly: this.money(body.priceMonthly) } : {}),
        ...(body.priceYearly !== undefined ? { priceYearly: body.priceYearly == null || body.priceYearly === '' ? null : this.money(body.priceYearly) } : {}),
        ...(body.currency !== undefined ? { currency: String(body.currency) } : {}),
        ...(body.contactSales !== undefined ? { contactSales: body.contactSales === true } : {}),
        ...(body.highlighted !== undefined ? { highlighted: body.highlighted === true } : {}),
        ...(body.displayOrder !== undefined ? { displayOrder: Number(body.displayOrder) || 0 } : {}),
        ...(body.status === 'DRAFT' || body.status === 'ACTIVE' || body.status === 'INACTIVE' || body.status === 'ARCHIVED' ? { status: body.status === 'ARCHIVED' ? PlanStatus.INACTIVE : body.status } : {}),
        ...(flags ? { featuresJson: flags.flags } : {}),
        ...this.limitData(body),
      },
    });
    await this.publishVersion(planId);
    return updated;
  }

  async disablePlan(adminId: string, planId: string) {
    await this.requirePlatformAdmin(adminId);
    return this.prisma.plan.update({ where: { id: planId }, data: { status: PlanStatus.INACTIVE } });
  }

  async deletePlan(adminId: string, planId: string) {
    await this.requirePlatformAdmin(adminId);
    const current = await this.prisma.plan.findUnique({ where: { id: planId }, include: { _count: { select: { subscriptions: true, versions: true, invoices: true } } } });
    if (!current) throw new NotFoundException('套餐不存在');
    const decision = assertPlanReferences({ subscriptions: current._count.subscriptions, versions: current._count.versions, invoices: current._count.invoices });
    if (!decision.ok) throw new ConflictException(decision.message);
    await this.prisma.plan.delete({ where: { id: planId } });
    return { ok: true };
  }

  async overridePlan(adminId: string, workspaceId: string, planCode: string, reason: string) {
    await this.requirePlatformAdmin(adminId);
    const note = reason.trim();
    if (!note) throw new BadRequestException('请填写切换原因');
    const plan = await this.prisma.plan.findUnique({ where: { code: planCode } });
    if (!plan || !canAssignPlan(plan.status)) throw new NotFoundException('套餐不存在');
    const version = await this.openVersion(plan.id);
    const period = plan.code === 'free' ? shanghaiNaturalMonth(new Date()) : resolveUsagePeriod({
      planCode: plan.code,
      currentPeriodStart: null,
      currentPeriodEnd: null,
    });
    const existing = await this.prisma.subscription.findFirst({
      where: { workspaceId, status: { in: [...EFFECTIVE_SUBSCRIPTION_STATUSES] } },
      orderBy: { createdAt: 'desc' },
    });
    const data = {
      planId: plan.id,
      planVersionId: version?.id,
      status: SubscriptionStatus.ACTIVE,
      source: plan.code === 'free' ? 'DEFAULT_FREE' : 'MANUAL_ADMIN',
      activationSource: plan.code === 'free' ? null : 'MANUAL_ADMIN',
      overrideSource: 'MANUAL_ADMIN_OVERRIDE',
      overrideReason: note,
      overrideById: adminId,
      overriddenAt: new Date(),
      cancelAtPeriodEnd: false,
      pendingPlanId: null,
      planChangeEffectiveAt: null,
      currentPeriodStart: period.start,
      currentPeriodEnd: period.end,
    };
    const saved = existing
      ? await this.prisma.subscription.update({ where: { id: existing.id }, data })
      : await this.prisma.subscription.create({ data: { workspaceId, ...data } });
    const effectiveAt = new Date();
    await this.prisma.subscriptionEvent.create({
      data: {
        workspaceId,
        subscriptionId: saved.id,
        eventType: 'SUBSCRIPTION_UPGRADED',
        fromPlanId: existing?.planId ?? null,
        toPlanId: plan.id,
        effectiveAt,
        actorUserId: adminId,
        source: data.source,
        metadataSafe: sanitizeAdminAuditMetadata({ reason: note, overrideSource: 'MANUAL_ADMIN_OVERRIDE' }),
        idempotencyKey: `${saved.id}:OVERRIDE:${effectiveAt.toISOString()}:${adminId}`,
      },
    });
    await this.audit(adminId, workspaceId, 'SUBSCRIPTION_PLAN_OVERRIDDEN', { planCode, reason: note, overrideSource: 'MANUAL_ADMIN_OVERRIDE' });
    await this.audit(adminId, workspaceId, 'SUBSCRIPTION_PLAN_CHANGED', { planCode, source: 'ADMIN_OVERRIDE' });
    return { ok: true, overrideSource: 'MANUAL_ADMIN_OVERRIDE' as const };
  }

  limitsOf(plan: PlanRecord): PlanLimits {
    return {
      projects: plan.maxProjects,
      members: plan.maxMembers,
      deployments: plan.maxDeploymentsPerMonth,
      buildMinutes: plan.maxBuildMinutesPerMonth,
      servers: plan.maxServers,
      databases: plan.maxDatabases,
      redis: plan.maxRedisInstances,
    };
  }

  private withVersion(plan: PlanRecord, version: { priceMonthly: number; priceYearly: number | null; limitsJson: Prisma.JsonValue; featuresJson: Prisma.JsonValue; grandfathered: boolean } | null): PlanRecord {
    if (!version || !version.limitsJson || typeof version.limitsJson !== 'object' || Array.isArray(version.limitsJson)) return plan;
    const raw = version.limitsJson as Record<string, unknown>;
    const read = (key: 'maxProjects' | 'maxMembers' | 'maxDeploymentsPerMonth' | 'maxBuildMinutesPerMonth' | 'maxServers' | 'maxDatabases' | 'maxRedisInstances'): number | null => {
      if (!(key in raw) || raw[key] == null || raw[key] === '') return key in raw ? null : plan[key];
      const parsed = Number(raw[key]);
      return Number.isFinite(parsed) ? parsed : plan[key];
    };
    return {
      ...plan,
      priceMonthly: version.priceMonthly,
      priceYearly: version.priceYearly,
      grandfathered: version.grandfathered,
      maxProjects: read('maxProjects'),
      maxMembers: read('maxMembers'),
      maxDeploymentsPerMonth: read('maxDeploymentsPerMonth'),
      maxBuildMinutesPerMonth: read('maxBuildMinutesPerMonth'),
      maxServers: read('maxServers'),
      maxDatabases: read('maxDatabases'),
      maxRedisInstances: read('maxRedisInstances'),
      featuresJson: version.featuresJson ?? plan.featuresJson,
    };
  }

  private openVersion(planId: string) {
    return this.prisma.planVersion.findFirst({ where: { planId, effectiveTo: null }, orderBy: { version: 'desc' } });
  }

  private async upgradeMessage(current: string, used: number, limit: number | null, unit: string, limitKey: 'maxProjects' | 'maxMembers') {
    if (limit == null) return '当前套餐额度不足，请升级套餐后继续。';
    const ladder = ['free', 'pro', 'team', 'enterprise'];
    const candidates = ladder.slice(Math.max(0, ladder.indexOf(current)) + 1);
    for (const code of candidates) {
      const next = await this.prisma.plan.findUnique({ where: { code } });
      if (!next) continue;
      const nextLimit = next[limitKey];
      if (nextLimit == null || nextLimit > limit) {
        return formatUpgradeReason({ used, limit, unit, nextPlanName: next.name, nextLimit });
      }
    }
    return '当前套餐额度不足，请联系平台管理员。';
  }

  private async publishVersion(planId: string) {
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) return;
    const open = await this.openVersion(planId);
    const limits = {
      maxProjects: plan.maxProjects,
      maxMembers: plan.maxMembers,
      maxDeploymentsPerMonth: plan.maxDeploymentsPerMonth,
      maxBuildMinutesPerMonth: plan.maxBuildMinutesPerMonth,
      maxServers: plan.maxServers,
      maxDatabases: plan.maxDatabases,
      maxRedisInstances: plan.maxRedisInstances,
    };
    const same = open
      && open.priceMonthly === plan.priceMonthly
      && open.priceYearly === plan.priceYearly
      && JSON.stringify(open.limitsJson) === JSON.stringify(limits)
      && JSON.stringify(open.featuresJson) === JSON.stringify(plan.featuresJson);
    if (same) return;
    const now = new Date();
    if (open) await this.prisma.planVersion.update({ where: { id: open.id }, data: { effectiveTo: now } });
    await this.prisma.planVersion.create({
      data: {
        planId,
        version: (open?.version ?? 0) + 1,
        effectiveFrom: now,
        priceMonthly: plan.priceMonthly,
        priceMonthlyCents: plan.priceMonthlyCents,
        priceYearly: plan.priceYearly,
        currency: plan.currency,
        limitsJson: limits,
        featuresJson: plan.featuresJson ?? {},
        grandfathered: false,
      },
    });
  }

  private presentPlan(plan: PlanRecord) {
    return {
      id: plan.id,
      code: plan.code,
      name: plan.name,
      description: plan.description,
      priceMonthly: plan.priceMonthly,
      priceYearly: plan.priceYearly ?? null,
      contactSales: plan.contactSales ?? false,
      currency: plan.currency,
      status: plan.status,
      audience: plan.audience ?? null,
      marketingDescription: plan.marketingDescription ?? null,
      highlighted: plan.highlighted ?? false,
      displayOrder: plan.displayOrder ?? 0,
      grandfathered: plan.grandfathered ?? false,
      limits: this.limitsOf(plan),
      featuresJson: plan.featuresJson,
    };
  }

  private presentSubscription(subscription: { id: string; status: string; startedAt: Date; currentPeriodStart: Date; currentPeriodEnd: Date; cancelAtPeriodEnd: boolean; overrideSource: string | null; quotaExceeded: boolean }) {
    return {
      id: subscription.id,
      status: subscription.status,
      statusLabel: subscriptionStatusLabel(subscription.status),
      startedAt: subscription.startedAt,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      overrideSource: subscription.overrideSource,
      quotaExceeded: subscription.quotaExceeded,
    };
  }

  private async recordQuotaSignal(actorId: string, workspaceId: string, status: 'WITHIN_LIMIT' | 'NEAR_LIMIT' | 'OVER_LIMIT', periodStart: Date) {
    if (status === 'WITHIN_LIMIT') return;
    const action = status === 'OVER_LIMIT' ? 'QUOTA_EXCEEDED' : 'QUOTA_NEAR_LIMIT';
    const already = await this.prisma.auditLog.findFirst({
      where: { workspaceId, action, createdAt: { gte: periodStart } },
    });
    if (!already) await this.audit(actorId, workspaceId, action, { status });
  }

  private async currentWorkspaceId(userId: string) {
    const membership = await this.prisma.workspaceMember.findFirst({ where: { userId }, orderBy: { createdAt: 'asc' } });
    if (!membership) throw new ForbiddenException('没有工作空间');
    return membership.workspaceId;
  }

  private async requirePlan(code: string) {
    const plan = await this.prisma.plan.findUnique({ where: { code } });
    if (!plan) throw new NotFoundException('免费套餐尚未配置');
    return plan;
  }

  private async isPlatformAdmin(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { platformRole: true } });
    return user?.platformRole === 'PLATFORM_ADMIN';
  }

  private async requirePlatformAdmin(userId: string) {
    if (!(await this.isPlatformAdmin(userId))) throw new ForbiddenException('需要平台管理员权限');
  }

  private async audit(userId: string, workspaceId: string, action: string, metadata: Record<string, string | number | boolean | null>) {
    await this.prisma.auditLog.create({
      data: { workspaceId, userId, action, metadata: sanitizeAdminAuditMetadata({ ...metadata, adminUserId: userId, workspaceId }) },
    });
  }

  private optionalText(value: unknown) {
    const text = String(value ?? '').trim();
    return text || null;
  }

  private money(value: unknown) {
    const amount = Number(value ?? 0);
    if (!Number.isFinite(amount) || amount < 0) throw new BadRequestException('价格无效');
    return Math.round(amount);
  }

  private limitValues(body: Record<string, unknown>) {
    const data: {
      maxProjects?: number | null;
      maxMembers?: number | null;
      maxDeploymentsPerMonth?: number | null;
      maxBuildMinutesPerMonth?: number | null;
      maxServers?: number | null;
      maxDatabases?: number | null;
      maxRedisInstances?: number | null;
    } = {};
    for (const key of ['maxProjects', 'maxMembers', 'maxDeploymentsPerMonth', 'maxBuildMinutesPerMonth', 'maxServers', 'maxDatabases', 'maxRedisInstances'] as const) {
      if (body[key] === undefined) continue;
      if (body[key] === null || body[key] === '') {
        data[key] = null;
        continue;
      }
      const parsed = Number(body[key]);
      if (!Number.isInteger(parsed) || parsed < 0) throw new BadRequestException('额度必须是空值或非负整数');
      data[key] = parsed;
    }
    return data;
  }

  private limitData(body: Record<string, unknown>): Prisma.PlanUpdateInput {
    return this.limitValues(body);
  }
}
