import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { WorkspaceRole } from '@launchos/database';
import { assertBillingMutation, assertMemberMutation, nearLimitCopy, WORKSPACE_ROLE_LABELS } from '@launchos/domain';
import { SubscriptionEngineService } from '../billing/subscription-engine.service';
import { SubscriptionService } from '../billing/subscription.service';
import { PricingService } from '../billing/pricing.service';
import { CommercialService } from '../billing/commercial.service';
import { PaymentService } from '../billing/payment.service';
import { EntitlementGovernanceService } from '../billing/entitlement-governance.service';
import { AuthService } from '../auth/auth.service';
import { PrismaService } from '../database/prisma.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';

const ASSIGNABLE: WorkspaceRole[] = [
  WorkspaceRole.OWNER,
  WorkspaceRole.ADMIN,
  WorkspaceRole.MEMBER,
  WorkspaceRole.VIEWER,
];

function ratio(used: number | null | undefined, limit: number | null | undefined): number | null {
  if (used == null || limit == null || limit <= 0) return null;
  return used / limit;
}

@Injectable()
export class AccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaceAccess: WorkspaceAccessService,
    private readonly auth: AuthService,
    private readonly engine: SubscriptionEngineService,
    private readonly subscriptions: SubscriptionService,
    private readonly pricing: PricingService,
    private readonly commercial: CommercialService,
    private readonly payments: PaymentService,
    private readonly entitlementGov: EntitlementGovernanceService,
  ) {}

  async profile(userId: string) {
    return this.auth.getProfile(userId);
  }

  async updateProfile(userId: string, name: string) {
    return this.auth.updateProfileName(userId, name);
  }

  async members(userId: string) {
    const membership = await this.workspaceAccess.requireCurrentWorkspace(userId);
    const rows = await this.prisma.workspaceMember.findMany({
      where: { workspaceId: membership.workspaceId },
      include: { user: { select: { id: true, email: true, name: true, lastLoginAt: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return {
      actorRole: membership.role,
      canManage: assertMemberMutation({ actorRole: membership.role, action: 'invite', nextRole: 'MEMBER' }).allowed,
      members: rows.map((row) => ({
        userId: row.userId,
        email: row.user.email,
        name: row.user.name,
        role: row.role,
        roleLabel: WORKSPACE_ROLE_LABELS[row.role],
        lastLoginAt: row.user.lastLoginAt,
        joinedAt: row.createdAt,
      })),
    };
  }

  async invite(userId: string, email: string, role: string) {
    const membership = await this.workspaceAccess.requireCurrentWorkspace(userId);
    await this.workspaceAccess.assertWorkspaceMutable(membership.workspaceId);
    const nextRole = this.parseRole(role);
    this.ensureMemberChange(membership.role, 'invite', undefined, nextRole);
    const target = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!target) throw new NotFoundException('该邮箱尚未注册');
    const existing = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: membership.workspaceId, userId: target.id } },
    });
    if (existing) throw new BadRequestException('该用户已在团队中');
    await this.entitlementGov.assertCanInviteMember(userId, membership.workspaceId);
    await this.prisma.workspaceMember.create({
      data: { workspaceId: membership.workspaceId, userId: target.id, role: nextRole },
    });
    await this.audit(membership.workspaceId, userId, 'MEMBER_INVITED', { email: target.email, role: nextRole });
    return { ok: true };
  }

  async changeRole(actorId: string, targetUserId: string, role: string) {
    const membership = await this.workspaceAccess.requireCurrentWorkspace(actorId);
    await this.workspaceAccess.assertWorkspaceMutable(membership.workspaceId);
    const nextRole = this.parseRole(role);
    const target = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: membership.workspaceId, userId: targetUserId } },
    });
    if (!target) throw new NotFoundException('成员不存在');
    this.ensureMemberChange(membership.role, 'changeRole', target.role, nextRole);
    if (target.role === WorkspaceRole.OWNER && nextRole !== WorkspaceRole.OWNER) {
      await this.ensureOwnerRemains(membership.workspaceId, targetUserId);
    }
    await this.prisma.workspaceMember.update({
      where: { id: target.id },
      data: { role: nextRole },
    });
    await this.audit(membership.workspaceId, actorId, 'MEMBER_ROLE_CHANGED', {
      targetUserId,
      role: nextRole,
    });
    return { ok: true };
  }

  async remove(actorId: string, targetUserId: string) {
    const membership = await this.workspaceAccess.requireCurrentWorkspace(actorId);
    await this.workspaceAccess.assertWorkspaceMutable(membership.workspaceId);
    const target = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: membership.workspaceId, userId: targetUserId } },
    });
    if (!target) throw new NotFoundException('成员不存在');
    this.ensureMemberChange(membership.role, 'remove', target.role);
    if (target.role === WorkspaceRole.OWNER) {
      await this.ensureOwnerRemains(membership.workspaceId, targetUserId);
    }
    await this.prisma.workspaceMember.delete({ where: { id: target.id } });
    await this.audit(membership.workspaceId, actorId, 'MEMBER_REMOVED', { targetUserId });
    return { ok: true };
  }

  async security(userId: string, sessionId?: string) {
    const membership = await this.workspaceAccess.requireCurrentWorkspace(userId);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, name: true, createdAt: true, lastLoginAt: true },
    });
    const sessions = await this.prisma.authSession.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 8,
    });
    const audit = await this.prisma.auditLog.findMany({
      where: { workspaceId: membership.workspaceId, userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return {
      account: user,
      lastLoginAt: user?.lastLoginAt ?? null,
      currentSessionId: sessionId ?? null,
      sessions: sessions.map((session) => ({
        id: session.id,
        userAgent: session.userAgent,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        revokedAt: session.revokedAt,
        current: session.id === sessionId,
      })),
      audit: audit.map((row) => ({
        id: row.id,
        action: row.action,
        createdAt: row.createdAt,
      })),
    };
  }

  async changePassword(userId: string, currentPassword: string, nextPassword: string) {
    const membership = await this.workspaceAccess.requireCurrentWorkspace(userId);
    const result = await this.auth.changePassword(userId, currentPassword, nextPassword);
    await this.audit(membership.workspaceId, userId, 'PASSWORD_CHANGED', {});
    return result;
  }

  async revokeOtherSessions(userId: string, sessionId?: string) {
    const membership = await this.workspaceAccess.requireCurrentWorkspace(userId);
    await this.prisma.authSession.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(sessionId ? { id: { not: sessionId } } : {}),
      },
      data: { revokedAt: new Date() },
    });
    await this.audit(membership.workspaceId, userId, 'OTHER_SESSIONS_REVOKED', {});
    return { ok: true };
  }

  async billing(userId: string) {
    const membership = await this.workspaceAccess.requireCurrentWorkspace(userId);
    const invoices = await this.prisma.invoice.findMany({
      where: { workspaceId: membership.workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const quota = await this.engine.evaluateWorkspaceQuota(membership.workspaceId, { audit: false, actorId: userId });
    return {
      plan: {
        code: quota.effectivePlan.code,
        name: quota.effectivePlan.name,
        priceMonthly: quota.effectivePlan.priceMonthly,
        currency: quota.effectivePlan.currency,
      },
      status: quota.subscription?.status ?? 'ACTIVE',
      statusLabel: quota.subscription?.statusLabel ?? '正常',
      nextRenewalAt: quota.subscription?.currentPeriodEnd ?? quota.period.end,
      cancelAtPeriodEnd: quota.subscription?.cancelAtPeriodEnd ?? false,
      usage: { applications: quota.usage.projectCount },
      invoices,
      paymentConnected: false,
      canChange: assertBillingMutation(membership.role).allowed,
      quotaHint: quota.overallStatus === 'OVER_LIMIT'
        ? '当前使用量已超过套餐建议范围'
        : quota.overallStatus === 'NEAR_LIMIT'
          ? nearLimitCopy()
          : null,
      commercial: await this.commercial.summary(userId),
      paymentHistory: await this.payments.historyForWorkspace(membership.workspaceId),
    };
  }

  async subscription(userId: string) {
    const view = await this.subscriptions.userSubscription(userId);
    const entitlements = await this.entitlementGov.accountEntitlementsView(userId).catch(() => null);
    if (!entitlements) {
      return { ...view, entitlements };
    }

    // Prefer resolveEffectiveEntitlements for all used/limit surfaces (Beta override etc.).
    const quota = {
      ...(view.quota ?? {}),
      projects: {
        used: entitlements.usage.projects,
        limit: entitlements.entitlements.maxProjects,
      },
      deployments: {
        used: entitlements.usage.monthlyDeployments,
        limit: entitlements.entitlements.maxMonthlyDeployments,
      },
      members: {
        used: entitlements.usage.members,
        limit: entitlements.entitlements.maxWorkspaceMembers,
      },
      runningApps: {
        used: entitlements.usage.runningApps,
        limit: entitlements.entitlements.maxRunningApps,
      },
    };

    const ratios = [
      ratio(quota.projects.used, quota.projects.limit),
      ratio(quota.deployments.used, quota.deployments.limit),
      ratio(quota.members.used, quota.members.limit),
      ratio(quota.runningApps.used, quota.runningApps.limit),
    ].filter((value): value is number => value != null);
    const overallStatus = ratios.some((value) => value >= 1)
      ? 'OVER_LIMIT'
      : ratios.some((value) => value >= 0.8)
        ? 'NEAR_LIMIT'
        : 'WITHIN_LIMIT';

    return { ...view, quota, overallStatus, entitlements };
  }

  async entitlements(userId: string) {
    return this.entitlementGov.accountEntitlementsView(userId);
  }

  async usage(userId: string) {
    const view = await this.entitlementGov.accountEntitlementsView(userId);
    return {
      plan: view.planCode,
      planName: view.planName,
      usage: view.usage,
      remaining: view.remaining,
      quota: view.quota,
      warnings: view.warnings,
      ui: view.ui,
      entitlements: view.entitlements,
      override: view.override,
      source: view.source,
    };
  }

  async requestUpgrade(userId: string, planCode: string) {
    return this.pricing.createUpgradeRequest(userId, planCode);
  }

  async planComparison(userId: string) {
    return this.pricing.comparison(userId);
  }

  async featureHint(userId: string, feature: string) {
    return this.pricing.featureHint(userId, feature);
  }

  async scheduleCancel(userId: string) {
    return this.subscriptions.scheduleCancelForUser(userId);
  }

  async resumeSubscription(userId: string) {
    return this.subscriptions.resumeForUser(userId);
  }

  async startTrial(userId: string, planCode: string, days: number) {
    return this.subscriptions.startTrialForUser(userId, planCode, days);
  }

  async updateBillingProfile(userId: string, body: Record<string, unknown>) {
    return this.commercial.updateProfile(userId, body);
  }

  rejectCoupon() {
    return this.commercial.rejectCoupon();
  }

  async changeBilling(userId: string) {
    const membership = await this.workspaceAccess.requireCurrentWorkspace(userId);
    const decision = assertBillingMutation(membership.role);
    if (!decision.allowed) throw new ForbiddenException('当前角色不能修改账单');
    throw new BadRequestException('支付尚未开通');
  }

  private parseRole(role: string): WorkspaceRole {
    if (!ASSIGNABLE.includes(role as WorkspaceRole)) {
      throw new BadRequestException('角色无效');
    }
    return role as WorkspaceRole;
  }

  private ensureMemberChange(
    actorRole: string,
    action: 'invite' | 'changeRole' | 'remove',
    targetRole?: string,
    nextRole?: string,
  ): void {
    const decision = assertMemberMutation({ actorRole, action, targetRole, nextRole });
    if (!decision.allowed) throw new ForbiddenException('当前角色不能管理成员');
  }

  private async ensureOwnerRemains(workspaceId: string, leavingUserId: string): Promise<void> {
    const owners = await this.prisma.workspaceMember.count({
      where: { workspaceId, role: WorkspaceRole.OWNER, userId: { not: leavingUserId } },
    });
    if (owners < 1) throw new ForbiddenException('工作空间至少保留一位所有者');
  }

  private audit(workspaceId: string, userId: string, action: string, metadata: Record<string, string>) {
    return this.prisma.auditLog.create({
      data: { workspaceId, userId, action, metadata },
    });
  }
}
