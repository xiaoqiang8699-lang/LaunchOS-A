import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  COMMERCIAL_NOTIFICATION_TYPES,
  assertOrderStaysUnpaid,
  billingProfileAccess,
  buildCheckoutDraft,
  calculateWorkspacePriceBreakdown,
  canReviewUpgrade,
  canWriteInvoiceFacts,
  estimateWorkspaceCloudCost,
  manualActivationMarker,
  presentPriceBreakdown,
  profileIncomplete,
  recognizedMargin,
  rejectCouponEntry,
  sanitizeAdminAuditMetadata,
  unavailableCloudBillingProvider,
  validateBillingProfile,
  type CloudCostInput,
  type CloudCostType,
} from '@launchos/domain';
import { PrismaService } from '../database/prisma.service';

const PROFILE_FIELDS = [
  'billingName',
  'billingEmail',
  'companyName',
  'taxId',
  'country',
  'region',
  'city',
  'addressLine1',
  'addressLine2',
  'postalCode',
  'contactName',
  'contactPhone',
  'currency',
] as const;

@Injectable()
export class CommercialService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(userId: string) {
    const membership = await this.membership(userId);
    const access = billingProfileAccess(membership.role);
    if (!access.read) throw new ForbiddenException('当前角色不能查看账单');
    const profile = await this.prisma.billingProfile.findUnique({ where: { workspaceId: membership.workspaceId } });
    const priced = await this.priceContext(membership.workspaceId, 'monthly');
    const cloud = await this.estimateForWorkspace(membership.workspaceId);
    const breakdown = calculateWorkspacePriceBreakdown({
      subscriptionFee: priced.fee,
      cloudResourceEstimatedCost: cloud.totalEstimatedCloudCost,
      discount: 0,
      currency: profile?.currency || priced.currency,
    });
    const presentation = presentPriceBreakdown({
      planName: priced.planName,
      subscriptionFee: priced.fee,
      contactSales: priced.contactSales,
      cloudResourceEstimatedCost: cloud.totalEstimatedCloudCost,
      discount: 0,
      totalEstimated: breakdown.totalEstimated,
      currency: breakdown.currency,
      billingInterval: 'monthly',
    });
    const invoices = await this.prisma.invoice.findMany({
      where: { workspaceId: membership.workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        invoiceNumber: true,
        amount: true,
        currency: true,
        status: true,
        periodStart: true,
        periodEnd: true,
        subscriptionAmount: true,
        cloudResourceAmount: true,
        totalAmount: true,
        createdAt: true,
      },
    });
    return {
      profile,
      canEdit: access.edit,
      profileStatus: profile?.billingEmail ? '已填写' : '未填写',
      plan: { code: priced.planCode, name: priced.planName },
      cloud,
      breakdown,
      presentation,
      invoices,
      enforcement: { suspend: false, pastDue: false, dunning: false, reclaim: false },
    };
  }

  async updateProfile(userId: string, body: Record<string, unknown>) {
    const membership = await this.membership(userId);
    if (!billingProfileAccess(membership.role).edit) throw new ForbiddenException('当前角色不能修改账单资料');
    const data = this.profileData(body);
    const decision = validateBillingProfile(data);
    if (!decision.ok) throw new BadRequestException(decision.message);
    const profile = await this.prisma.billingProfile.upsert({
      where: { workspaceId: membership.workspaceId },
      create: { workspaceId: membership.workspaceId, ...data },
      update: data,
    });
    await this.audit(membership.workspaceId, userId, 'BILLING_PROFILE_UPDATED', { currency: profile.currency });
    if (profileIncomplete(profile)) await this.intent(membership.workspaceId, 'BILLING_PROFILE_INCOMPLETE', 'profile');
    return profile;
  }

  rejectCoupon() {
    const decision = rejectCouponEntry();
    throw new BadRequestException(decision.message);
  }

  async approveUpgrade(adminId: string, requestId: string) {
    await this.requireAdmin(adminId);
    const request = await this.prisma.upgradeRequest.findUnique({
      where: { id: requestId },
      include: { requestedPlan: true },
    });
    if (!request || request.status !== 'PENDING') throw new BadRequestException('升级申请不存在或已处理');
    const unpaid = assertOrderStaysUnpaid('DRAFT');
    if (!unpaid.ok) throw new BadRequestException(unpaid.message);
    const draft = await this.createCheckoutDraft({
      actorId: adminId,
      workspaceId: request.workspaceId,
      planId: request.requestedPlanId,
      billingInterval: 'monthly',
      upgradeRequestId: request.id,
      orderType: request.fromPlanId === request.requestedPlanId ? 'SUBSCRIPTION_RENEWAL' : 'SUBSCRIPTION_UPGRADE',
    });
    const updated = await this.prisma.upgradeRequest.update({
      where: { id: request.id },
      data: { status: 'APPROVED', handledById: adminId, handledAt: new Date() },
    });
    return {
      status: updated.status,
      requestId: updated.id,
      orderId: draft.id,
      orderNumber: draft.orderNumber,
      orderStatus: draft.status,
      payment: null,
      message: '已生成结账草稿。支付功能即将开放，订单不会标成已支付。',
    };
  }

  async createCheckoutDraft(input: {
    actorId: string;
    workspaceId: string;
    planId: string;
    billingInterval: 'monthly' | 'yearly';
    upgradeRequestId?: string;
    orderType: 'SUBSCRIPTION_NEW' | 'SUBSCRIPTION_UPGRADE' | 'SUBSCRIPTION_RENEWAL' | 'OTHER';
  }) {
    if (input.upgradeRequestId) {
      const existing = await this.prisma.commercialOrder.findFirst({
        where: { upgradeRequestId: input.upgradeRequestId, status: 'DRAFT' },
      });
      if (existing) return existing;
    }
    const plan = await this.prisma.plan.findUnique({ where: { id: input.planId } });
    if (!plan || plan.status !== 'ACTIVE') throw new NotFoundException('套餐不存在');
    const version = await this.prisma.planVersion.findFirst({
      where: { planId: plan.id, effectiveTo: null },
      orderBy: { version: 'desc' },
    });
    const fee = plan.contactSales
      ? null
      : input.billingInterval === 'yearly'
        ? (version?.priceYearly ?? plan.priceYearly)
        : (version?.priceMonthly ?? plan.priceMonthly);
    const cloud = await this.estimateForWorkspace(input.workspaceId);
    const breakdown = calculateWorkspacePriceBreakdown({
      subscriptionFee: fee,
      cloudResourceEstimatedCost: cloud.totalEstimatedCloudCost,
      discount: 0,
      currency: version?.currency || plan.currency,
    });
    const orderNumber = `LO-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const draft = buildCheckoutDraft({
      orderNumber,
      type: input.orderType,
      planId: plan.id,
      planVersionId: version?.id ?? null,
      billingInterval: input.billingInterval,
      breakdown,
    });
    const blocked = assertOrderStaysUnpaid(draft.status);
    if (!blocked.ok) throw new BadRequestException(blocked.message);
    const created = await this.prisma.commercialOrder.create({
      data: {
        workspaceId: input.workspaceId,
        orderNumber: draft.orderNumber,
        type: draft.type,
        status: 'DRAFT',
        planId: draft.planId,
        planVersionId: draft.planVersionId,
        billingInterval: draft.billingInterval,
        subscriptionFee: draft.subscriptionFee,
        cloudCostEstimate: draft.cloudCostEstimate,
        discountAmount: draft.discountAmount,
        taxAmount: draft.taxAmount,
        totalAmount: draft.totalAmount,
        currency: breakdown.currency,
        upgradeRequestId: input.upgradeRequestId,
        createdById: input.actorId,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    await this.intent(input.workspaceId, 'ORDER_CREATED', created.orderNumber);
    await this.audit(input.workspaceId, input.actorId, 'CHECKOUT_DRAFT_CREATED', {
      orderNumber: created.orderNumber,
      planCode: plan.code,
      status: created.status,
    });
    return created;
  }

  async listOrders(adminId: string) {
    await this.requireAdmin(adminId);
    const rows = await this.prisma.commercialOrder.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        workspace: { select: { name: true, owner: { select: { email: true, name: true } } } },
        plan: { select: { name: true, code: true } },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      orderNumber: row.orderNumber,
      workspaceName: row.workspace.name,
      ownerEmail: row.workspace.owner.email,
      ownerName: row.workspace.owner.name,
      type: row.type,
      planName: row.plan?.name ?? '—',
      subscriptionFee: row.subscriptionFee,
      cloudCostEstimate: row.cloudCostEstimate,
      discountAmount: row.discountAmount,
      taxAmount: row.taxAmount,
      totalAmount: row.totalAmount,
      currency: row.currency,
      status: row.status,
      createdAt: row.createdAt,
    }));
  }

  async cancelOrder(adminId: string, orderId: string) {
    await this.requireAdmin(adminId);
    const order = await this.prisma.commercialOrder.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('订单不存在');
    if (order.status !== 'DRAFT' && order.status !== 'PENDING_PAYMENT') throw new BadRequestException('已支付的订单不能直接取消，需要走退款');
    await this.prisma.payment.updateMany({ where: { orderId: order.id, status: { in: ['PENDING', 'PROCESSING'] } }, data: { status: 'CANCELED' } });
    const updated = await this.prisma.commercialOrder.update({ where: { id: order.id }, data: { status: 'CANCELED' } });
    await this.audit(order.workspaceId, adminId, 'COMMERCIAL_ORDER_CANCELED', { orderNumber: order.orderNumber });
    return { id: updated.id, status: updated.status };
  }

  async adminBilling(adminId: string) {
    await this.requireAdmin(adminId);
    const rows = await this.prisma.subscription.findMany({
      where: { status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCEL_AT_PERIOD_END'] } },
      orderBy: { updatedAt: 'desc' },
      take: 40,
      include: {
        plan: true,
        planVersion: true,
        workspace: { include: { owner: { select: { email: true, name: true } }, billingProfile: true } },
      },
    });
    const orders = await this.prisma.commercialOrder.findMany({
      where: { workspaceId: { in: rows.map((row) => row.workspaceId) } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => {
      const fee = row.plan.contactSales ? null : (row.planVersion?.priceMonthly ?? row.plan.priceMonthly);
      const latest = orders.find((order) => order.workspaceId === row.workspaceId);
      const profile = row.workspace.billingProfile;
      return {
        workspaceId: row.workspaceId,
        workspaceName: row.workspace.name,
        ownerEmail: row.workspace.owner.email,
        planName: row.plan.name,
        subscriptionFee: fee,
        currency: row.plan.currency,
        estimatedCloudCost: latest?.cloudCostEstimate ?? null,
        estimatedGrossMargin: recognizedMargin({ recognizedSubscriptionRevenue: null, actualCloudCost: null }),
        profileStatus: profile?.billingEmail ? '已填写' : '未填写',
        billingName: profile?.billingName ?? null,
        billingEmail: profile?.billingEmail ?? null,
        companyName: profile?.companyName ?? null,
        orderStatus: latest?.status ?? 'NONE',
        paymentStatus: row.paymentStatus,
      };
    });
  }

  async cloudBillStatus() {
    return unavailableCloudBillingProvider.fetchWorkspaceCosts({ workspaceId: 'platform' });
  }

  async refuseSettlement(adminId: string) {
    await this.requireAdmin(adminId);
    const succeeded = await this.prisma.payment.count({ where: { status: 'SUCCEEDED' } });
    if (!canWriteInvoiceFacts(succeeded > 0 ? 'SUCCEEDED' : null)) {
      throw new BadRequestException('只有真实结算时才写入账单事实');
    }
    throw new BadRequestException('只有真实结算时才写入账单事实');
  }

  notificationTypes() {
    return COMMERCIAL_NOTIFICATION_TYPES;
  }

  manualMarker() {
    return manualActivationMarker();
  }

  private async estimateForWorkspace(workspaceId: string) {
    const start = new Date();
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    const [servers, databases, redisInstances, projects, records] = await Promise.all([
      this.prisma.serverInstance.findMany({ where: { workspaceId }, select: { id: true, metadata: true } }),
      this.prisma.databaseConnection.findMany({ where: { workspaceId }, select: { id: true } }),
      this.prisma.redisConnection.findMany({ where: { workspaceId }, select: { id: true } }),
      this.prisma.project.findMany({ where: { workspaceId }, select: { id: true } }),
      this.prisma.cloudCostRecord.findMany({
        where: { workspaceId, periodStart: { lt: end }, periodEnd: { gt: start } },
      }),
    ]);
    const domains = projects.length
      ? await this.prisma.applicationDomain.findMany({ where: { projectId: { in: projects.map((project) => project.id) } }, select: { id: true } })
      : [];
    const amounts = new Map<string, number | null>();
    for (const record of records) {
      if (!record.resourceId) continue;
      if (!amounts.has(record.resourceId)) amounts.set(record.resourceId, record.amount);
      else {
        const previous = amounts.get(record.resourceId);
        amounts.set(record.resourceId, previous == null || record.amount == null ? null : previous + record.amount);
      }
    }
    const sharedIds = new Set(servers.filter((server) => this.shared(server.metadata)).map((server) => server.id));
    const inputs: CloudCostInput[] = [
      ...servers.filter((server) => !sharedIds.has(server.id)).map((server) => this.cost('SERVER', server.id, workspaceId, amounts)),
      ...databases.map((row) => this.cost('DATABASE', row.id, workspaceId, amounts)),
      ...redisInstances.map((row) => this.cost('REDIS', row.id, workspaceId, amounts)),
      ...domains.map((row) => this.cost('DOMAIN', row.id, workspaceId, amounts)),
    ];
    for (const record of records) {
      if (record.resourceId && (sharedIds.has(record.resourceId) || inputs.some((item) => item.resourceId === record.resourceId))) continue;
      inputs.push({
        workspaceId,
        shared: false,
        resourceType: record.resourceType,
        resourceId: record.resourceId || record.id,
        amount: record.amount,
      });
    }
    return estimateWorkspaceCloudCost(workspaceId, inputs);
  }

  private cost(resourceType: CloudCostType, resourceId: string, workspaceId: string, amounts: Map<string, number | null>): CloudCostInput {
    return {
      workspaceId,
      shared: false,
      resourceType,
      resourceId,
      amount: amounts.has(resourceId) ? (amounts.get(resourceId) ?? null) : null,
    };
  }

  private shared(metadata: unknown): boolean {
    return Boolean(metadata && typeof metadata === 'object' && !Array.isArray(metadata) && (metadata as { platformShared?: boolean }).platformShared === true);
  }

  private async priceContext(workspaceId: string, interval: 'monthly' | 'yearly') {
    const subscription = await this.prisma.subscription.findFirst({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      include: { plan: true, planVersion: true },
    });
    const plan = subscription?.plan;
    const version = subscription?.planVersion;
    const contactSales = plan?.contactSales ?? false;
    const fee = contactSales
      ? null
      : interval === 'yearly'
        ? (version?.priceYearly ?? plan?.priceYearly ?? null)
        : (version?.priceMonthly ?? plan?.priceMonthly ?? 0);
    return {
      planCode: plan?.code ?? 'free',
      planName: plan?.name ?? 'Free',
      fee,
      contactSales,
      currency: version?.currency || plan?.currency || 'CNY',
    };
  }

  private profileData(body: Record<string, unknown>) {
    const data: Record<string, string | null> = {};
    for (const field of PROFILE_FIELDS) {
      if (body[field] === undefined) continue;
      const value = body[field];
      data[field] = value == null || String(value).trim() === '' ? null : String(value).trim();
    }
    if (!data.currency) data.currency = 'CNY';
    return data;
  }

  private async membership(userId: string) {
    const membership = await this.prisma.workspaceMember.findFirst({ where: { userId }, orderBy: { createdAt: 'asc' } });
    if (!membership) throw new ForbiddenException('没有可用的工作空间');
    return membership;
  }

  private async requireAdmin(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { platformRole: true } });
    if (!canReviewUpgrade(user?.platformRole ?? 'USER')) throw new ForbiddenException('需要平台管理员权限');
  }

  private async audit(workspaceId: string, userId: string, action: string, metadata: Record<string, string | number | boolean | null>) {
    const safe = sanitizeAdminAuditMetadata(metadata);
    await this.prisma.auditLog.create({ data: { workspaceId, userId, action, metadata: safe } });
  }

  private async intent(workspaceId: string, type: (typeof COMMERCIAL_NOTIFICATION_TYPES)[number], periodKey: string) {
    await this.prisma.notificationIntent.create({ data: { workspaceId, type, periodKey } }).catch(() => undefined);
  }
}
