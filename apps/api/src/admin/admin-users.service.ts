import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccountStatus, PlatformRole, Prisma } from '@launchos/database';
import {
  accountStatusLabel,
  assertAdminRoute,
  assertEmailAvailable,
  assertLastPlatformAdminPreserved,
  assertPermanentDeleteConfirmation,
  permanentDeleteBlockers,
  platformRoleLabel,
  resetOnboardingPatch,
  sanitizeAdminAuditMetadata,
  WORKSPACE_ROLE_LABELS,
} from '@launchos/domain';
import { PrismaService } from '../database/prisma.service';

type ListQuery = {
  q?: string;
  platformRole?: string;
  accountStatus?: string;
  subscriptionStatus?: string;
  registeredFrom?: string;
  registeredTo?: string;
  sort?: string;
  page?: string;
  pageSize?: string;
};

const listSelect = {
  id: true,
  email: true,
  name: true,
  platformRole: true,
  accountStatus: true,
  createdAt: true,
  lastLoginAt: true,
  memberships: {
    select: {
      workspace: {
        select: {
          id: true,
          name: true,
          _count: { select: { projects: true } },
          subscriptions: { select: { status: true, plan: { select: { name: true } } }, orderBy: { createdAt: 'desc' as const }, take: 1 },
        },
      },
    },
  },
} satisfies Prisma.UserSelect;

@Injectable()
export class AdminUsersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(adminId: string, query: ListQuery) {
    await this.requirePlatformAdmin(adminId);
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(query.pageSize) || 20));
    const where = this.where(query);
    const sort = query.sort === 'recent_login' || query.sort === 'applications' ? query.sort : 'recent_register';

    if (sort === 'applications') {
      const matched = await this.prisma.user.findMany({ where, select: listSelect });
      matched.sort((left, right) => this.applicationCount(right) - this.applicationCount(left));
      const start = (page - 1) * pageSize;
      return {
        page,
        pageSize,
        total: matched.length,
        items: matched.slice(start, start + pageSize).map((row) => this.presentList(row)),
      };
    }

    const orderBy: Prisma.UserOrderByWithRelationInput =
      sort === 'recent_login' ? { lastLoginAt: { sort: 'desc', nulls: 'last' } } : { createdAt: 'desc' };
    const [total, rows] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({ where, orderBy, skip: (page - 1) * pageSize, take: pageSize, select: listSelect }),
    ]);
    return { page, pageSize, total, items: rows.map((row) => this.presentList(row)) };
  }

  async detail(adminId: string, userId: string) {
    await this.requirePlatformAdmin(adminId);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        suspendedBy: { select: { id: true, name: true, email: true } },
        memberships: {
          include: {
            workspace: {
              include: {
                _count: { select: { members: true, projects: true } },
                subscriptions: { include: { plan: true }, orderBy: { createdAt: 'desc' }, take: 1 },
                invoices: { orderBy: { createdAt: 'desc' }, take: 20 },
              },
            },
          },
        },
        sessions: { orderBy: { createdAt: 'desc' }, take: 8 },
        alphaTestSessions: { orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, sessionStatus: true, createdAt: true, projectId: true } },
      },
    });
    if (!user) throw new NotFoundException('用户不存在');

    const workspaceIds = user.memberships.map((member) => member.workspaceId);
    const projects = workspaceIds.length
      ? await this.prisma.project.findMany({
          where: { workspaceId: { in: workspaceIds } },
          orderBy: { updatedAt: 'desc' },
          take: 50,
          select: {
            id: true,
            name: true,
            status: true,
            gatewayRoutes: { where: { status: 'ACTIVE' }, select: { hostname: true }, take: 1 },
            serviceInstances: { orderBy: { updatedAt: 'desc' }, take: 1, select: { healthStatus: true, status: true } },
            launchRuns: { orderBy: { createdAt: 'desc' }, take: 1, select: { finishedAt: true, status: true } },
          },
        })
      : [];

    const subscription = user.memberships.find((member) => member.workspace.subscriptions[0])?.workspace.subscriptions[0] ?? null;
    const invoices = user.memberships.flatMap((member) =>
      member.workspace.invoices.map((invoice) => ({
        id: invoice.id,
        workspace: member.workspace.name,
        amount: invoice.amount,
        currency: invoice.currency,
        status: invoice.status,
        periodStart: invoice.periodStart,
        periodEnd: invoice.periodEnd,
      })),
    );
    const audit = await this.prisma.auditLog.findMany({
      where: {
        OR: [{ userId }, { metadata: { path: ['targetUserId'], equals: userId } }],
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: { id: true, action: true, createdAt: true, userId: true, metadata: true },
    });

    return {
      profile: {
        id: user.id,
        displayName: user.name,
        email: user.email,
        platformRole: user.platformRole,
        platformRoleLabel: platformRoleLabel(user.platformRole),
        accountStatus: user.accountStatus,
        accountStatusLabel: accountStatusLabel(user.accountStatus),
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
        onboardingStatus: user.onboardingStatus,
        adminNote: user.adminNote,
        suspendedAt: user.suspendedAt,
        suspendedBy: user.suspendedBy ? user.suspendedBy.name || user.suspendedBy.email : null,
        suspendReason: user.suspendReason,
        projectCount: projects.length,
      },
      workspaces: user.memberships.map((member) => ({
        id: member.workspace.id,
        name: member.workspace.name,
        role: member.role,
        roleLabel: WORKSPACE_ROLE_LABELS[member.role],
        members: member.workspace._count.members,
        applications: member.workspace._count.projects,
      })),
      applications: projects.map((project) => ({
        id: project.id,
        name: project.name,
        status: project.status,
        publicUrl: project.gatewayRoutes[0] ? `https://${project.gatewayRoutes[0].hostname}` : null,
        lastLaunchAt: project.launchRuns[0]?.finishedAt ?? null,
        healthStatus: project.serviceInstances[0]?.healthStatus ?? 'UNKNOWN',
      })),
      billing: {
        plan: subscription?.plan.name ?? '未开通',
        status: subscription?.status ?? 'NONE',
        currentPeriodStart: subscription?.currentPeriodStart ?? null,
        currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
        invoices,
        paymentConnected: false,
      },
      security: {
        lastLoginAt: user.lastLoginAt,
        sessions: user.sessions.map((session) => ({
          id: session.id,
          createdAt: session.createdAt,
          revokedAt: session.revokedAt,
          userAgent: session.userAgent,
        })),
      },
      audit: audit.map((row) => ({
        id: row.id,
        action: row.action,
        createdAt: row.createdAt,
        adminUserId: row.userId,
        metadata: sanitizeAdminAuditMetadata(row.metadata),
      })),
      alphaSessions: user.alphaTestSessions,
    };
  }

  async update(
    adminId: string,
    userId: string,
    body: {
      displayName?: string;
      email?: string;
      platformRole?: 'USER' | 'PLATFORM_ADMIN';
      accountStatus?: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED';
      adminNote?: string;
      suspendReason?: string;
    },
  ) {
    await this.requirePlatformAdmin(adminId);
    const current = await this.findUser(userId);
    if (body.accountStatus === 'SUSPENDED' && current.accountStatus !== 'SUSPENDED') {
      await this.suspend(adminId, userId, body.suspendReason);
    } else if (body.accountStatus === 'ARCHIVED' && current.accountStatus !== 'ARCHIVED') {
      await this.archive(adminId, userId);
    } else if (body.accountStatus === 'ACTIVE' && current.accountStatus !== 'ACTIVE') {
      await this.restore(adminId, userId);
    }
    if (body.platformRole && body.platformRole !== current.platformRole) {
      await this.changeRole(adminId, userId, body.platformRole);
    }

    const data: Prisma.UserUpdateInput = {};
    if (body.displayName !== undefined) {
      const displayName = body.displayName.trim();
      if (!displayName) throw new BadRequestException('姓名不能为空');
      data.name = displayName;
    }
    if (body.adminNote !== undefined) data.adminNote = body.adminNote.trim() || null;
    if (body.email !== undefined) {
      const taken = await this.prisma.user.findFirst({
        where: { email: body.email.trim().toLowerCase(), id: { not: userId } },
        select: { id: true },
      });
      const decision = assertEmailAvailable({ email: body.email, takenByOther: Boolean(taken) });
      if (!decision.ok) throw new ConflictException('该邮箱已经注册');
      data.email = decision.email;
    }
    if (Object.keys(data).length > 0) {
      await this.prisma.user.update({ where: { id: userId }, data });
      await this.audit(adminId, userId, 'ADMIN_USER_UPDATED', {
        displayName: body.displayName ?? null,
        emailChanged: body.email !== undefined,
      });
    }
    return this.detail(adminId, userId);
  }

  async suspend(adminId: string, userId: string, reason?: string) {
    await this.requirePlatformAdmin(adminId);
    const current = await this.findUser(userId);
    await this.protectLastAdmin(current.platformRole, true);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        accountStatus: AccountStatus.SUSPENDED,
        suspendedAt: new Date(),
        suspendedBy: { connect: { id: adminId } },
        suspendReason: reason?.trim() || null,
      },
    });
    await this.revokeSessions(userId);
    await this.audit(adminId, userId, 'ADMIN_USER_SUSPENDED', { reason: reason?.trim() || null });
    return { ok: true };
  }

  async restore(adminId: string, userId: string) {
    await this.requirePlatformAdmin(adminId);
    await this.findUser(userId);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        accountStatus: AccountStatus.ACTIVE,
        suspendedAt: null,
        suspendedById: null,
        suspendReason: null,
      },
    });
    await this.audit(adminId, userId, 'ADMIN_USER_RESTORED', {});
    return { ok: true };
  }

  async resetOnboarding(adminId: string, userId: string) {
    await this.requirePlatformAdmin(adminId);
    await this.findUser(userId);
    await this.prisma.user.update({ where: { id: userId }, data: resetOnboardingPatch() });
    await this.audit(adminId, userId, 'ADMIN_USER_ONBOARDING_RESET', {});
    return { ok: true, warning: '该操作仅用于重新体验引导，不会删除已有应用。' };
  }

  async revokeAllSessions(adminId: string, userId: string) {
    await this.requirePlatformAdmin(adminId);
    await this.findUser(userId);
    await this.revokeSessions(userId);
    await this.audit(adminId, userId, 'ADMIN_USER_SESSIONS_REVOKED', {});
    return { ok: true };
  }

  async changeRole(adminId: string, userId: string, platformRole: 'USER' | 'PLATFORM_ADMIN') {
    await this.requirePlatformAdmin(adminId);
    const current = await this.findUser(userId);
    if (current.platformRole === platformRole) return { ok: true };
    const removesAdmin = current.platformRole === 'PLATFORM_ADMIN' && platformRole !== 'PLATFORM_ADMIN';
    await this.protectLastAdmin(current.platformRole, removesAdmin);
    await this.prisma.user.update({
      where: { id: userId },
      data: { platformRole: platformRole as PlatformRole, isInternal: platformRole === 'PLATFORM_ADMIN' },
    });
    await this.audit(adminId, userId, 'ADMIN_USER_ROLE_CHANGED', { platformRole });
    return { ok: true };
  }

  async archive(adminId: string, userId: string) {
    await this.requirePlatformAdmin(adminId);
    const current = await this.findUser(userId);
    await this.protectLastAdmin(current.platformRole, true);
    await this.prisma.user.update({
      where: { id: userId },
      data: { accountStatus: AccountStatus.ARCHIVED },
    });
    await this.revokeSessions(userId);
    await this.audit(adminId, userId, 'ADMIN_USER_ARCHIVED', {});
    return { ok: true };
  }

  async permanentlyDelete(adminId: string, userId: string, body: { email: string; phrase: string }) {
    await this.requirePlatformAdmin(adminId);
    const current = await this.findUser(userId);
    const confirmation = assertPermanentDeleteConfirmation({ email: current.email, typedEmail: body.email, phrase: body.phrase });
    if (!confirmation.ok) throw new BadRequestException(confirmation.message);
    await this.protectLastAdmin(current.platformRole, current.platformRole === 'PLATFORM_ADMIN');
    const blockers = permanentDeleteBlockers(await this.deleteFacts(userId));
    if (blockers.length > 0) {
      throw new ConflictException({ code: 'USER_DELETE_BLOCKED', message: '该用户仍关联工作空间或资源，不能永久删除', blockers });
    }
    await this.audit(adminId, userId, 'ADMIN_USER_DELETED', { email: current.email });
    const owned = await this.prisma.workspace.findMany({ where: { ownerId: userId }, select: { id: true } });
    await this.prisma.$transaction(async (tx) => {
      await tx.auditLog.deleteMany({ where: { userId } });
      for (const workspace of owned) {
        await tx.workspaceMember.deleteMany({ where: { workspaceId: workspace.id } });
        await tx.workspace.delete({ where: { id: workspace.id } });
      }
      await tx.workspaceMember.deleteMany({ where: { userId } });
      await tx.user.delete({ where: { id: userId } });
    });
    return { ok: true };
  }

  private async deleteFacts(userId: string) {
    const owned = await this.prisma.workspace.findMany({
      where: { ownerId: userId },
      select: {
        id: true,
        _count: { select: { members: true, projects: true, cloudResources: true } },
        subscriptions: { where: { status: 'ACTIVE' }, select: { id: true } },
        invoices: { where: { status: 'OPEN' }, select: { id: true } },
        projects: {
          select: {
            serviceInstances: { where: { status: 'RUNNING' }, select: { id: true } },
            launchRuns: { where: { status: { in: ['RUNNING', 'VERIFYING'] } }, select: { id: true } },
          },
        },
      },
    });
    const foreignMemberships = await this.prisma.workspaceMember.count({
      where: { userId, workspace: { ownerId: { not: userId } } },
    });
    return {
      foreignMemberships,
      ownedWorkspaces: owned.map((workspace) => ({
        otherMembers: Math.max(0, workspace._count.members - 1),
        projects: workspace._count.projects,
        cloudResources: workspace._count.cloudResources,
        runningApplications: workspace.projects.reduce(
          (sum, project) => sum + project.serviceInstances.length + project.launchRuns.length,
          0,
        ),
        activeSubscription: workspace.subscriptions.length > 0,
        unpaidInvoice: workspace.invoices.length > 0,
      })),
    };
  }

  private async protectLastAdmin(role: string, removesAdmin: boolean) {
    const platformAdminCount = await this.prisma.user.count({ where: { platformRole: 'PLATFORM_ADMIN' } });
    const decision = assertLastPlatformAdminPreserved({
      isPlatformAdmin: role === 'PLATFORM_ADMIN',
      platformAdminCount,
      removesAdmin,
    });
    if (!decision.ok) {
      throw new ConflictException({ code: decision.code, message: '不能取消最后一个平台管理员' });
    }
  }

  private async findUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, platformRole: true, accountStatus: true },
    });
    if (!user) throw new NotFoundException('用户不存在');
    return user;
  }

  private async revokeSessions(userId: string) {
    await this.prisma.authSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async audit(adminId: string, targetUserId: string, action: string, metadata: Record<string, string | number | boolean | null>) {
    const membership = await this.prisma.workspaceMember.findFirst({
      where: { userId: adminId },
      orderBy: { createdAt: 'asc' },
    });
    if (!membership) return;
    const safe = sanitizeAdminAuditMetadata({ ...metadata, adminUserId: adminId, targetUserId });
    await this.prisma.auditLog.create({
      data: { workspaceId: membership.workspaceId, userId: adminId, action, metadata: safe },
    });
  }

  private async requirePlatformAdmin(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { platformRole: true } });
    const decision = assertAdminRoute(user?.platformRole ?? 'USER');
    if (!decision.allowed) throw new ForbiddenException('需要平台管理员权限');
  }

  private where(query: ListQuery): Prisma.UserWhereInput {
    const where: Prisma.UserWhereInput = {};
    const q = query.q?.trim();
    if (q) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
      ];
    }
    if (query.platformRole === 'USER' || query.platformRole === 'PLATFORM_ADMIN') where.platformRole = query.platformRole;
    if (query.accountStatus === 'ACTIVE' || query.accountStatus === 'SUSPENDED' || query.accountStatus === 'ARCHIVED') {
      where.accountStatus = query.accountStatus;
    }
    if (query.registeredFrom || query.registeredTo) {
      where.createdAt = {
        ...(query.registeredFrom ? { gte: new Date(query.registeredFrom) } : {}),
        ...(query.registeredTo ? { lte: new Date(query.registeredTo) } : {}),
      };
    }
    if (query.subscriptionStatus === 'NONE') {
      where.memberships = { none: { workspace: { subscriptions: { some: {} } } } };
    } else if (query.subscriptionStatus === 'ACTIVE' || query.subscriptionStatus === 'CANCELED' || query.subscriptionStatus === 'PAST_DUE') {
      where.memberships = { some: { workspace: { subscriptions: { some: { status: query.subscriptionStatus } } } } };
    }
    return where;
  }

  private applicationCount(row: Prisma.UserGetPayload<{ select: typeof listSelect }>): number {
    return row.memberships.reduce((sum, member) => sum + member.workspace._count.projects, 0);
  }

  private presentList(row: Prisma.UserGetPayload<{ select: typeof listSelect }>) {
    const subscription = row.memberships.find((member) => member.workspace.subscriptions[0])?.workspace.subscriptions[0];
    return {
      id: row.id,
      displayName: row.name,
      email: row.email,
      platformRole: row.platformRole,
      platformRoleLabel: platformRoleLabel(row.platformRole),
      createdAt: row.createdAt,
      lastLoginAt: row.lastLoginAt,
      workspaces: row.memberships.map((member) => ({ id: member.workspace.id, name: member.workspace.name })),
      applications: this.applicationCount(row),
      plan: subscription?.plan.name ?? '未开通',
      subscriptionStatus: subscription?.status ?? 'NONE',
      accountStatus: row.accountStatus,
      accountStatusLabel: accountStatusLabel(row.accountStatus),
    };
  }
}
