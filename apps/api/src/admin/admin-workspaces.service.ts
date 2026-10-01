import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, WorkspaceRole, WorkspaceStatus } from '@launchos/database';
import {
  assertAdminRoute,
  assertMemberMutation,
  assertWorkspaceArchive,
  assertWorkspaceMutable,
  latestActivity,
  sanitizeAdminAuditMetadata,
  transferWorkspaceOwner,
  workspaceDeleteBlockers,
  workspaceStatusLabel,
  WORKSPACE_ROLE_LABELS,
} from '@launchos/domain';
import { PrismaService } from '../database/prisma.service';
import { SubscriptionEngineService } from '../billing/subscription-engine.service';

type ListQuery = {
  q?: string;
  status?: string;
  planCode?: string;
  subscriptionStatus?: string;
  registeredFrom?: string;
  registeredTo?: string;
  sort?: string;
  page?: string;
  pageSize?: string;
};

@Injectable()
export class AdminWorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: SubscriptionEngineService,
  ) {}

  async list(adminId: string, query: ListQuery) {
    await this.requirePlatformAdmin(adminId);
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(query.pageSize) || 20));
    const where = this.where(query);
    const sort = query.sort ?? 'recent_created';
    const rows = await this.prisma.workspace.findMany({
      where,
      include: {
        owner: { select: { id: true, name: true, email: true } },
        _count: { select: { members: true, projects: true } },
        subscriptions: { include: { plan: true }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    const withActive = await Promise.all(rows.map(async (row) => ({ row, lastActiveAt: await this.lastActiveAt(row.id) })));
    withActive.sort((left, right) => this.compare(left, right, sort));
    const start = (page - 1) * pageSize;
    return {
      page,
      pageSize,
      total: withActive.length,
      items: withActive.slice(start, start + pageSize).map(({ row, lastActiveAt }) => this.presentList(row, lastActiveAt)),
    };
  }

  async detail(adminId: string, workspaceId: string) {
    await this.requirePlatformAdmin(adminId);
    const evaluated = await this.billing.evaluateWorkspaceQuota(workspaceId, { audit: true, actorId: adminId });
    const workspace = await this.load(workspaceId);
    const quota = {
      status: evaluated.overallStatus,
      hint: evaluated.overallStatus === 'NEAR_LIMIT' ? '本月使用量接近套餐上限。' : evaluated.overallStatus === 'OVER_LIMIT' ? '当前使用量已超过套餐建议范围' : null,
      blocksService: false,
      lines: evaluated.quota,
    };
    const projects = await this.prisma.project.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        name: true,
        projectType: true,
        status: true,
        gatewayRoutes: { where: { status: 'ACTIVE' }, select: { hostname: true }, take: 1 },
        serviceInstances: { orderBy: { updatedAt: 'desc' }, take: 1, select: { healthStatus: true, status: true } },
        launchRuns: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, status: true, finishedAt: true, createdAt: true } },
      },
    });
    const subscription = workspace.subscriptions[0] ?? null;
    return {
      profile: {
        id: workspace.id,
        name: workspace.name,
        status: workspace.status,
        statusLabel: workspaceStatusLabel(workspace.status),
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
        owner: workspace.owner.name || workspace.owner.email,
        ownerId: workspace.owner.id,
        memberCount: workspace._count.members,
        projectCount: workspace._count.projects,
        lastActiveAt: await this.lastActiveAt(workspaceId),
        adminNote: workspace.adminNote,
        suspendedAt: workspace.suspendedAt,
        suspendReason: workspace.suspendReason,
      },
      members: workspace.members.map((member) => ({
        userId: member.userId,
        name: member.user.name,
        email: member.user.email,
        role: member.role,
        roleLabel: WORKSPACE_ROLE_LABELS[member.role],
        joinedAt: member.createdAt,
        accountStatus: member.user.accountStatus,
      })),
      applications: projects.map((project) => ({
        id: project.id,
        name: project.name,
        type: project.projectType,
        status: project.status,
        publicUrl: project.gatewayRoutes[0] ? `https://${project.gatewayRoutes[0].hostname}` : null,
        lastLaunchAt: project.launchRuns[0]?.finishedAt ?? null,
        healthStatus: project.serviceInstances[0]?.healthStatus ?? 'UNKNOWN',
        launchRun: project.launchRuns[0] ? { id: project.launchRuns[0].id, status: project.launchRuns[0].status } : null,
      })),
      subscription: subscription
        ? {
            plan: subscription.plan.name,
            planCode: subscription.plan.code,
            status: subscription.status,
            startedAt: subscription.startedAt,
            currentPeriodStart: subscription.currentPeriodStart,
            currentPeriodEnd: subscription.currentPeriodEnd,
            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
            overrideSource: subscription.overrideSource,
          }
        : null,
      invoices: workspace.invoices.map((invoice) => ({
        id: invoice.id,
        periodStart: invoice.periodStart,
        periodEnd: invoice.periodEnd,
        amount: invoice.amount,
        currency: invoice.currency,
        status: invoice.status,
        createdAt: invoice.createdAt,
      })),
      usage: evaluated.usage,
      quota,
      cloudResources: workspace.cloudResources.map((resource) => ({
        id: resource.id,
        type: resource.type,
        status: resource.status,
        region: resource.region,
      })),
      audit: workspace.auditLogs.map((row) => ({
        id: row.id,
        action: row.action,
        createdAt: row.createdAt,
        metadata: sanitizeAdminAuditMetadata(row.metadata),
      })),
    };
  }

  async update(adminId: string, workspaceId: string, body: { name?: string; status?: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED'; adminNote?: string; suspendReason?: string }) {
    await this.requirePlatformAdmin(adminId);
    const current = await this.find(workspaceId);
    if (body.status === 'SUSPENDED' && current.status !== 'SUSPENDED') await this.suspend(adminId, workspaceId, body.suspendReason);
    else if (body.status === 'ARCHIVED' && current.status !== 'ARCHIVED') await this.archive(adminId, workspaceId);
    else if (body.status === 'ACTIVE' && current.status !== 'ACTIVE') await this.restore(adminId, workspaceId);
    const data: Prisma.WorkspaceUpdateInput = {};
    if (body.name !== undefined) {
      const name = body.name.trim();
      if (!name) throw new BadRequestException('名称不能为空');
      data.name = name;
    }
    if (body.adminNote !== undefined) data.adminNote = body.adminNote.trim() || null;
    if (Object.keys(data).length > 0) {
      await this.prisma.workspace.update({ where: { id: workspaceId }, data });
      await this.audit(adminId, workspaceId, 'ADMIN_WORKSPACE_UPDATED', { name: body.name ?? null });
    }
    return this.detail(adminId, workspaceId);
  }

  async suspend(adminId: string, workspaceId: string, reason?: string) {
    await this.requirePlatformAdmin(adminId);
    await this.find(workspaceId);
    await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: {
        status: WorkspaceStatus.SUSPENDED,
        suspendedAt: new Date(),
        suspendedBy: { connect: { id: adminId } },
        suspendReason: reason?.trim() || null,
      },
    });
    await this.audit(adminId, workspaceId, 'WORKSPACE_SUSPENDED', { reason: reason?.trim() || null });
    return { ok: true, message: '已暂停新的操作，现有线上服务保持运行。' };
  }

  async restore(adminId: string, workspaceId: string) {
    await this.requirePlatformAdmin(adminId);
    await this.find(workspaceId);
    await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { status: WorkspaceStatus.ACTIVE, suspendedAt: null, suspendedById: null, suspendReason: null },
    });
    await this.audit(adminId, workspaceId, 'WORKSPACE_RESTORED', {});
    return { ok: true };
  }

  async archive(adminId: string, workspaceId: string) {
    await this.requirePlatformAdmin(adminId);
    await this.find(workspaceId);
    const [activeSubscriptions, runningLaunchRuns] = await Promise.all([
      this.prisma.subscription.count({ where: { workspaceId, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCEL_AT_PERIOD_END'] }, plan: { code: { not: 'free' } } } }),
      this.prisma.launchRun.count({ where: { project: { workspaceId }, status: { in: ['RUNNING', 'VERIFYING'] } } }),
    ]);
    const decision = assertWorkspaceArchive({ activeSubscriptions, runningLaunchRuns });
    if (!decision.ok) throw new ConflictException(decision.message);
    await this.prisma.workspace.update({ where: { id: workspaceId }, data: { status: WorkspaceStatus.ARCHIVED } });
    await this.audit(adminId, workspaceId, 'WORKSPACE_ARCHIVED', {});
    return { ok: true };
  }

  async permanentlyDelete(adminId: string, workspaceId: string) {
    await this.requirePlatformAdmin(adminId);
    await this.find(workspaceId);
    const blockers = workspaceDeleteBlockers(await this.deleteFacts(workspaceId));
    if (blockers.length > 0) throw new ConflictException({ code: 'WORKSPACE_DELETE_BLOCKED', message: '只有空的工作空间可以永久删除', blockers });
    await this.audit(adminId, workspaceId, 'ADMIN_WORKSPACE_UPDATED', { deleted: true });
    await this.prisma.workspaceMember.deleteMany({ where: { workspaceId } });
    await this.prisma.auditLog.deleteMany({ where: { workspaceId } });
    await this.prisma.workspace.delete({ where: { id: workspaceId } });
    return { ok: true };
  }

  async transferOwner(adminId: string, workspaceId: string, userId: string) {
    await this.requirePlatformAdmin(adminId);
    const workspace = await this.find(workspaceId);
    await this.ensureMutable(workspace.status);
    const members = await this.prisma.workspaceMember.findMany({ where: { workspaceId } });
    const decision = transferWorkspaceOwner({
      members: members.map((member) => ({ userId: member.userId, role: member.role })),
      fromUserId: workspace.ownerId,
      toUserId: userId,
    });
    if (!decision.ok) throw new BadRequestException(decision.message);
    await this.prisma.$transaction(async (tx) => {
      for (const member of decision.members) {
        await tx.workspaceMember.update({
          where: { workspaceId_userId: { workspaceId, userId: member.userId } },
          data: { role: member.role as WorkspaceRole },
        });
      }
      await tx.workspace.update({ where: { id: workspaceId }, data: { ownerId: userId } });
    });
    await this.audit(adminId, workspaceId, 'WORKSPACE_OWNER_TRANSFERRED', { fromUserId: workspace.ownerId, toUserId: userId });
    return { ok: true };
  }

  async invite(adminId: string, workspaceId: string, email: string, role: string) {
    await this.requirePlatformAdmin(adminId);
    const workspace = await this.find(workspaceId);
    await this.ensureMutable(workspace.status);
    if (role === 'OWNER') throw new BadRequestException('请使用转移所有权');
    const decision = assertMemberMutation({ actorRole: 'OWNER', action: 'invite', nextRole: role });
    if (!decision.allowed) throw new ForbiddenException('不能这样修改成员');
    const target = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!target) throw new NotFoundException('该邮箱尚未注册');
    await this.prisma.workspaceMember.create({
      data: { workspaceId, userId: target.id, role: role as WorkspaceRole },
    });
    await this.audit(adminId, workspaceId, 'ADMIN_WORKSPACE_UPDATED', { invited: target.email, role });
    return { ok: true };
  }

  async changeMemberRole(adminId: string, workspaceId: string, userId: string, role: string) {
    await this.requirePlatformAdmin(adminId);
    const workspace = await this.find(workspaceId);
    await this.ensureMutable(workspace.status);
    if (role === 'OWNER') throw new BadRequestException('请使用转移所有权');
    const target = await this.prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
    if (!target) throw new NotFoundException('成员不存在');
    const decision = assertMemberMutation({ actorRole: 'OWNER', action: 'changeRole', targetRole: target.role, nextRole: role });
    if (!decision.allowed || target.role === 'OWNER') throw new ForbiddenException('不能这样修改成员');
    await this.prisma.workspaceMember.update({ where: { id: target.id }, data: { role: role as WorkspaceRole } });
    await this.audit(adminId, workspaceId, 'ADMIN_WORKSPACE_UPDATED', { memberId: userId, role });
    return { ok: true };
  }

  async removeMember(adminId: string, workspaceId: string, userId: string) {
    await this.requirePlatformAdmin(adminId);
    const workspace = await this.find(workspaceId);
    await this.ensureMutable(workspace.status);
    const target = await this.prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
    if (!target) throw new NotFoundException('成员不存在');
    if (target.role === 'OWNER') throw new ForbiddenException('不能移除所有者');
    await this.prisma.workspaceMember.delete({ where: { id: target.id } });
    await this.audit(adminId, workspaceId, 'ADMIN_WORKSPACE_UPDATED', { removedUserId: userId });
    return { ok: true };
  }

  async overridePlan(adminId: string, workspaceId: string, planCode: string, reason?: string) {
    return this.billing.overridePlan(adminId, workspaceId, planCode, reason?.trim() || 'Alpha 手工切换');
  }

  async listApps(adminId: string, query: ListQuery) {
    await this.requirePlatformAdmin(adminId);
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(query.pageSize) || 20));
    const q = query.q?.trim();
    const where: Prisma.ProjectWhereInput = q
      ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { workspace: { name: { contains: q, mode: 'insensitive' } } }] }
      : {};
    const [total, rows] = await Promise.all([
      this.prisma.project.count({ where }),
      this.prisma.project.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          name: true,
          projectType: true,
          status: true,
          workspace: { select: { id: true, name: true, owner: { select: { name: true, email: true } } } },
          gatewayRoutes: { where: { status: 'ACTIVE' }, select: { hostname: true }, take: 1 },
          serviceInstances: { orderBy: { updatedAt: 'desc' }, take: 1, select: { healthStatus: true } },
          launchRuns: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true, finishedAt: true } },
        },
      }),
    ]);
    return {
      page,
      pageSize,
      total,
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        workspace: row.workspace.name,
        workspaceId: row.workspace.id,
        owner: row.workspace.owner.name || row.workspace.owner.email,
        type: row.projectType,
        status: row.status,
        publicUrl: row.gatewayRoutes[0] ? `https://${row.gatewayRoutes[0].hostname}` : null,
        healthStatus: row.serviceInstances[0]?.healthStatus ?? 'UNKNOWN',
        lastLaunchAt: row.launchRuns[0]?.finishedAt ?? null,
        launchStatus: row.launchRuns[0]?.status ?? null,
      })),
    };
  }

  async appDetail(adminId: string, projectId: string) {
    await this.requirePlatformAdmin(adminId);
    const row = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        projectType: true,
        status: true,
        workspace: { select: { id: true, name: true, owner: { select: { name: true, email: true } } } },
        gatewayRoutes: { where: { status: 'ACTIVE' }, select: { hostname: true }, take: 1 },
        serviceInstances: { orderBy: { updatedAt: 'desc' }, take: 1, select: { healthStatus: true, status: true } },
        launchRuns: { orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, status: true, createdAt: true, finishedAt: true } },
      },
    });
    if (!row) throw new NotFoundException('应用不存在');
    return {
      id: row.id,
      name: row.name,
      type: row.projectType,
      status: row.status,
      workspace: row.workspace.name,
      workspaceId: row.workspace.id,
      owner: row.workspace.owner.name || row.workspace.owner.email,
      publicUrl: row.gatewayRoutes[0] ? `https://${row.gatewayRoutes[0].hostname}` : null,
      healthStatus: row.serviceInstances[0]?.healthStatus ?? 'UNKNOWN',
      serviceStatus: row.serviceInstances[0]?.status ?? null,
      launchRuns: row.launchRuns,
    };
  }

  async countOverLimit(): Promise<number> {
    const workspaces = await this.prisma.workspace.findMany({ select: { id: true } });
    const results = await Promise.all(workspaces.map((workspace) => this.billing.evaluateWorkspaceQuota(workspace.id, { audit: false })));
    return results.filter((quota) => quota.overallStatus === 'OVER_LIMIT').length;
  }

  private async deleteFacts(workspaceId: string) {
    const [projects, members, subscriptions, invoices, servers, databases, redis, domains, activeServices] = await Promise.all([
      this.prisma.project.count({ where: { workspaceId } }),
      this.prisma.workspaceMember.count({ where: { workspaceId } }),
      this.prisma.subscription.count({ where: { workspaceId, plan: { code: { not: 'free' } } } }),
      this.prisma.invoice.count({ where: { workspaceId } }),
      this.prisma.serverInstance.count({ where: { workspaceId } }),
      this.prisma.databaseConnection.count({ where: { workspaceId } }),
      this.prisma.redisConnection.count({ where: { workspaceId } }),
      this.prisma.domainRecord.count({ where: { project: { workspaceId } } }),
      this.prisma.serviceInstance.count({ where: { project: { workspaceId }, status: 'RUNNING' } }),
    ]);
    return { projects, extraMembers: Math.max(0, members - 1), subscriptions, invoices, servers, databases, redis, domains, activeServices };
  }

  private async lastActiveAt(workspaceId: string): Promise<string | null> {
    const [member, project, launch, deployment] = await Promise.all([
      this.prisma.user.findFirst({ where: { memberships: { some: { workspaceId } }, lastLoginAt: { not: null } }, orderBy: { lastLoginAt: 'desc' }, select: { lastLoginAt: true } }),
      this.prisma.project.findFirst({ where: { workspaceId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
      this.prisma.launchRun.findFirst({ where: { project: { workspaceId } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
      this.prisma.deployment.findFirst({ where: { project: { workspaceId } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    ]);
    return latestActivity([
      member?.lastLoginAt?.toISOString() ?? null,
      project?.createdAt.toISOString() ?? null,
      launch?.createdAt.toISOString() ?? null,
      deployment?.createdAt.toISOString() ?? null,
    ]);
  }

  private where(query: ListQuery): Prisma.WorkspaceWhereInput {
    const where: Prisma.WorkspaceWhereInput = {};
    const q = query.q?.trim();
    if (q) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { owner: { name: { contains: q, mode: 'insensitive' } } },
        { owner: { email: { contains: q, mode: 'insensitive' } } },
      ];
    }
    if (query.status === 'ACTIVE' || query.status === 'SUSPENDED' || query.status === 'ARCHIVED') where.status = query.status;
    if (query.planCode) where.subscriptions = { some: { plan: { code: query.planCode } } };
    if (query.subscriptionStatus === 'NONE') where.subscriptions = { none: {} };
    if (query.subscriptionStatus === 'ACTIVE' || query.subscriptionStatus === 'CANCELED' || query.subscriptionStatus === 'PAST_DUE') {
      where.subscriptions = { some: { status: query.subscriptionStatus } };
    }
    if (query.registeredFrom || query.registeredTo) {
      where.createdAt = {
        ...(query.registeredFrom ? { gte: new Date(query.registeredFrom) } : {}),
        ...(query.registeredTo ? { lte: new Date(query.registeredTo) } : {}),
      };
    }
    return where;
  }

  private compare(
    left: { row: { createdAt: Date; _count: { members: number; projects: number } }; lastActiveAt: string | null },
    right: { row: { createdAt: Date; _count: { members: number; projects: number } }; lastActiveAt: string | null },
    sort: string,
  ): number {
    if (sort === 'members') return right.row._count.members - left.row._count.members;
    if (sort === 'applications') return right.row._count.projects - left.row._count.projects;
    if (sort === 'recent_active') return (right.lastActiveAt ? new Date(right.lastActiveAt).getTime() : 0) - (left.lastActiveAt ? new Date(left.lastActiveAt).getTime() : 0);
    return right.row.createdAt.getTime() - left.row.createdAt.getTime();
  }

  private presentList(
    row: {
      id: string;
      name: string;
      status: string;
      createdAt: Date;
      owner: { name: string; email: string };
      _count: { members: number; projects: number };
      subscriptions: Array<{ status: string; plan: { name: string; code: string } }>;
    },
    lastActiveAt: string | null,
  ) {
    const subscription = row.subscriptions[0];
    return {
      id: row.id,
      name: row.name,
      owner: row.owner.name || row.owner.email,
      members: row._count.members,
      applications: row._count.projects,
      plan: subscription?.plan.name ?? '免费',
      planCode: subscription?.plan.code ?? 'free',
      subscriptionStatus: subscription?.status ?? 'ACTIVE',
      status: row.status,
      statusLabel: workspaceStatusLabel(row.status),
      createdAt: row.createdAt,
      lastActiveAt,
    };
  }

  private async load(workspaceId: string) {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: {
        owner: { select: { id: true, name: true, email: true } },
        _count: { select: { members: true, projects: true } },
        members: { include: { user: { select: { name: true, email: true, accountStatus: true } } }, orderBy: { createdAt: 'asc' } },
        subscriptions: { include: { plan: true }, orderBy: { createdAt: 'desc' }, take: 1 },
        invoices: { orderBy: { createdAt: 'desc' }, take: 20 },
        cloudResources: { select: { id: true, type: true, status: true, region: true }, take: 20 },
        auditLogs: { orderBy: { createdAt: 'desc' }, take: 20 },
      },
    });
    if (!workspace) throw new NotFoundException('工作空间不存在');
    return workspace;
  }

  private async find(workspaceId: string) {
    const workspace = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, status: true, ownerId: true } });
    if (!workspace) throw new NotFoundException('工作空间不存在');
    return workspace;
  }

  private ensureMutable(status: string) {
    const decision = assertWorkspaceMutable(status);
    if (!decision.allowed) throw new ForbiddenException(decision.message);
  }

  private async audit(adminId: string, workspaceId: string, action: string, metadata: Record<string, string | number | boolean | null>) {
    const safe = sanitizeAdminAuditMetadata({ ...metadata, adminUserId: adminId, workspaceId });
    await this.prisma.auditLog.create({ data: { workspaceId, userId: adminId, action, metadata: safe } });
  }

  private async requirePlatformAdmin(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { platformRole: true } });
    if (!assertAdminRoute(user?.platformRole ?? 'USER').allowed) throw new ForbiddenException('需要平台管理员权限');
  }
}
