import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  buildFeatureMatrix,
  canAssignPlan,
  canRequestUpgrade,
  canReviewUpgrade,
  comparisonBadges,
  displayMonthlyPrice,
  displayYearlyPrice,
  formatFeatureCell,
  isCustomerVisiblePlan,
  recommendBestPlan,
  unavailablePaymentProvider,
  upgradeTrigger,
  userLimitSentence,
  PLAN_AUDIENCE,
  CLOUD_COST_DISCLAIMER,
  FEATURE_LABELS,
  type CatalogPlan,
} from '@launchos/domain';
import { PrismaService } from '../database/prisma.service';
import { SubscriptionEngineService } from './subscription-engine.service';
import { SubscriptionService } from './subscription.service';
import { CommercialService } from './commercial.service';

const HINTS: Record<string, string> = {
  advancedLogs: '高级日志需要 Pro 或更高套餐。升级后可以查看更完整的运行和部署日志。',
  teamPermissions: '团队权限需要 Team 套餐。升级到 Team 后可配置更完整的成员权限。',
  customDomain: '自定义域名需要 Pro 或更高套餐。',
  auditLog: '审计日志需要 Team 套餐。',
  sso: 'SSO 需要 Enterprise。请联系平台管理员。',
  privateNetworking: '私有网络需要 Enterprise。请联系平台管理员。',
};

@Injectable()
export class PricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: SubscriptionEngineService,
    private readonly subscriptions: SubscriptionService,
    private readonly commercial: CommercialService,
  ) {}

  async comparison(userId: string) {
    const membership = await this.currentMembership(userId);
    const quota = await this.engine.evaluateWorkspaceQuota(membership.workspaceId, { audit: false });
    const plans = await this.prisma.plan.findMany({ where: { status: 'ACTIVE' }, orderBy: [{ displayOrder: 'asc' }, { priceMonthly: 'asc' }] });
    const catalog = plans.map((plan) => this.catalogPlan(plan)).filter((plan) => isCustomerVisiblePlan(plan.code, 'ACTIVE'));
    const recommendation = recommendBestPlan({
      currentPlan: quota.effectivePlan.code,
      usage: {
        projects: quota.usage.projectCount,
        members: quota.usage.memberCount,
        deployments: quota.usage.deploymentCount,
        buildMinutes: quota.usage.buildMinutes,
        servers: quota.usage.serverCount,
        databases: quota.usage.databaseCount,
        redis: quota.usage.redisCount,
      },
      limits: quota.effectivePlan.limits,
      catalog: Object.fromEntries(
        catalog
          .filter((plan) => plan.code === 'pro' || plan.code === 'team' || plan.code === 'enterprise')
          .map((plan) => [plan.code, { projects: plan.limits.maxProjects, members: plan.limits.maxMembers }]),
      ),
    });
    const badges = comparisonBadges({
      codes: catalog.map((plan) => plan.code),
      currentPlan: quota.effectivePlan.code,
      recommendedPlan: recommendation.recommendedPlan,
    });
    return {
      currentPlan: quota.effectivePlan.code,
      recommendedPlan: recommendation.recommendedPlan,
      reasons: recommendation.reasons,
      disclaimer: CLOUD_COST_DISCLAIMER,
      matrix: buildFeatureMatrix(catalog),
      cards: catalog.map((plan) => ({
        code: plan.code,
        name: plan.name,
        contactSales: plan.contactSales,
        audience: PLAN_AUDIENCE[plan.code] ?? plan.audience,
        priceLabel: displayMonthlyPrice(plan),
        yearlyLabel: displayYearlyPrice(plan),
        badges: badges[plan.code] ?? [],
        summary: [
          userLimitSentence('应用数量', plan.limits.maxProjects),
          userLimitSentence('成员数量', plan.limits.maxMembers),
          userLimitSentence('每月部署次数', plan.limits.maxDeploymentsPerMonth),
          userLimitSentence('构建分钟', plan.limits.maxBuildMinutesPerMonth),
        ],
        keyFeatures: ['customDomain', 'priorityBuild', 'advancedLogs', 'teamPermissions', 'auditLog', 'sso'].map((key) => ({
          label: FEATURE_LABELS[key] ?? key,
          value: formatFeatureCell(plan.features[key]),
        })),
      })),
    };
  }

  async featureHint(userId: string, feature: string) {
    const membership = await this.currentMembership(userId);
    const entitlements = await this.subscriptions.entitlements(membership.workspaceId);
    const enabled = entitlements.features[feature] === true;
    const trigger = upgradeTrigger({ moment: 'locked_feature', featureEnabled: enabled });
    return { show: trigger.show, message: trigger.show ? HINTS[feature] ?? '当前套餐不包含这项能力。' : null };
  }

  async createUpgradeRequest(userId: string, planCode: string, reason?: string) {
    const membership = await this.currentMembership(userId);
    if (!canRequestUpgrade(membership.role)) throw new ForbiddenException('当前角色不能申请升级');
    const current = await this.prisma.subscription.findFirst({
      where: { workspaceId: membership.workspaceId },
      orderBy: { createdAt: 'desc' },
      include: { plan: true },
    });
    const requested = await this.prisma.plan.findUnique({ where: { code: planCode } });
    if (requested?.code === 'PAYMENT_TEST' || requested?.status === 'INTERNAL_TEST') throw new ForbiddenException('该套餐不能用于普通升级');
    if (!requested || !canAssignPlan(requested.status)) throw new NotFoundException('套餐不存在');
    const note = reason?.trim() || '申请升级';
    const existing = await this.prisma.upgradeRequest.findFirst({
      where: { workspaceId: membership.workspaceId, requestedPlanId: requested.id, status: 'PENDING' },
    });
    const request = existing ?? await this.prisma.upgradeRequest.create({
      data: {
        workspaceId: membership.workspaceId,
        fromPlanId: current?.planId ?? requested.id,
        requestedPlanId: requested.id,
        fromSource: current?.source,
        reason: note,
        requestedById: userId,
      },
    });
    const payment = await unavailablePaymentProvider.createCheckout({ workspaceId: membership.workspaceId, planCode });
    return {
      ...payment,
      requestId: request.id,
      status: request.status,
      message: requested.contactSales ? '已提交给平台管理员，请等待联系。支付功能即将开放。' : payment.message,
    };
  }

  async listRequests(adminId: string) {
    await this.requireAdmin(adminId);
    const rows = await this.prisma.upgradeRequest.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        workspace: { select: { name: true } },
        fromPlan: { select: { code: true, name: true } },
        requestedPlan: { select: { code: true, name: true } },
        requestedBy: { select: { email: true, name: true } },
      },
    });
    return rows;
  }

  async approve(adminId: string, requestId: string) {
    return this.commercial.approveUpgrade(adminId, requestId);
  }

  async reject(adminId: string, requestId: string) {
    await this.requireAdmin(adminId);
    const request = await this.prisma.upgradeRequest.findUnique({ where: { id: requestId } });
    if (!request || request.status !== 'PENDING') throw new BadRequestException('升级申请不存在或已处理');
    return this.prisma.upgradeRequest.update({
      where: { id: request.id },
      data: { status: 'REJECTED', handledById: adminId, handledAt: new Date() },
    });
  }

  async metrics() {
    const [freeWorkspaces, proWorkspaces, teamWorkspaces, enterpriseWorkspaces, upgradeRequestsPending, upgradeRequestsFromFree, trialUpgradeRequests] = await Promise.all([
      this.prisma.subscription.count({ where: { status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCEL_AT_PERIOD_END'] }, plan: { code: 'free' } } }),
      this.prisma.subscription.count({ where: { status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCEL_AT_PERIOD_END'] }, plan: { code: 'pro' } } }),
      this.prisma.subscription.count({ where: { status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCEL_AT_PERIOD_END'] }, plan: { code: 'team' } } }),
      this.prisma.subscription.count({ where: { status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCEL_AT_PERIOD_END'] }, plan: { code: 'enterprise' } } }),
      this.prisma.upgradeRequest.count({ where: { status: 'PENDING' } }),
      this.prisma.upgradeRequest.count({ where: { fromPlan: { code: 'free' } } }),
      this.prisma.upgradeRequest.count({ where: { fromSource: 'TRIAL' } }),
    ]);
    return { freeWorkspaces, proWorkspaces, teamWorkspaces, enterpriseWorkspaces, upgradeRequestsPending, upgradeRequestsFromFree, trialUpgradeRequests };
  }

  private catalogPlan(plan: {
    code: string;
    name: string;
    priceMonthly: number;
    priceYearly: number | null;
    currency: string;
    contactSales: boolean;
    status: string;
    highlighted: boolean;
    audience: string | null;
    maxProjects: number | null;
    maxMembers: number | null;
    maxDeploymentsPerMonth: number | null;
    maxBuildMinutesPerMonth: number | null;
    maxServers: number | null;
    maxDatabases: number | null;
    maxRedisInstances: number | null;
    featuresJson: unknown;
  }): CatalogPlan & { audience: string | null } {
    const features = plan.featuresJson && typeof plan.featuresJson === 'object' && !Array.isArray(plan.featuresJson)
      ? Object.fromEntries(Object.entries(plan.featuresJson).filter((entry): entry is [string, boolean | string] => typeof entry[1] === 'boolean' || typeof entry[1] === 'string'))
      : {};
    return {
      code: plan.code,
      name: plan.name,
      priceMonthly: plan.priceMonthly,
      priceYearly: plan.priceYearly,
      currency: plan.currency,
      contactSales: plan.contactSales,
      status: plan.status,
      highlighted: plan.highlighted,
      audience: plan.audience,
      limits: {
        maxProjects: plan.maxProjects,
        maxMembers: plan.maxMembers,
        maxDeploymentsPerMonth: plan.maxDeploymentsPerMonth,
        maxBuildMinutesPerMonth: plan.maxBuildMinutesPerMonth,
        maxServers: plan.maxServers,
        maxDatabases: plan.maxDatabases,
        maxRedisInstances: plan.maxRedisInstances,
      },
      features,
    };
  }

  private async currentMembership(userId: string) {
    const membership = await this.prisma.workspaceMember.findFirst({ where: { userId }, orderBy: { createdAt: 'asc' } });
    if (!membership) throw new ForbiddenException('没有可用的工作空间');
    return membership;
  }

  private async requireAdmin(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { platformRole: true } });
    if (!canReviewUpgrade(user?.platformRole ?? 'USER')) throw new ForbiddenException('需要平台管理员权限');
  }
}
