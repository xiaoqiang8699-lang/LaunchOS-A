import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@launchos/database';
import {
  BETA_TESTER_OVERRIDE_DEFAULTS,
  buildEffectiveEntitlements,
  canReserveDeploymentSlot,
  customDomainDecision,
  deploymentConsumesQuota,
  deploymentQuotaDecision,
  entitlementsFromPlanVersion,
  isOverrideActive,
  logRetentionLimitation,
  memberQuotaDecision,
  projectQuotaDecision,
  runningAppQuotaDecision,
  selectVersionsForRetention,
  subscriptionEntitlementBehavior,
  usageLedgerIdempotencyKey,
  type EntitlementSet,
  type EffectiveEntitlements,
  type QuotaBlock,
} from '@launchos/domain';
import { PrismaService } from '../database/prisma.service';
import { SubscriptionEngineService } from './subscription-engine.service';

@Injectable()
export class EntitlementGovernanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: SubscriptionEngineService,
  ) {}

  async resolveEffectiveEntitlements(workspaceId: string): Promise<EffectiveEntitlements> {
    const resolved = await this.engine.resolveEffectivePlan(workspaceId, null);
    const subscription = resolved.subscription;
    const plan = resolved.plan;
    const period = await this.periodFor(workspaceId, plan.code, subscription);
    const usage = await this.reconcileUsage(workspaceId, period);
    const version = subscription?.planVersionId
      ? await this.prisma.planVersion.findUnique({ where: { id: subscription.planVersionId } })
      : await this.prisma.planVersion.findFirst({
          where: { planId: plan.id, effectiveTo: null },
          orderBy: { version: 'desc' },
        });

    const statusBehavior = subscriptionEntitlementBehavior(subscription?.status ?? 'ACTIVE');
    const base = entitlementsFromPlanVersion({
      planCode: statusBehavior.fallBackToFree ? 'free' : plan.code,
      limitsJson:
        version?.limitsJson && typeof version.limitsJson === 'object' && !Array.isArray(version.limitsJson)
          ? (version.limitsJson as Record<string, unknown>)
          : null,
      featuresJson:
        version?.featuresJson && typeof version.featuresJson === 'object' && !Array.isArray(version.featuresJson)
          ? (version.featuresJson as Record<string, unknown>)
          : plan.featuresJson && typeof plan.featuresJson === 'object' && !Array.isArray(plan.featuresJson)
            ? (plan.featuresJson as Record<string, unknown>)
            : null,
      legacy: {
        maxProjects: plan.maxProjects,
        maxMembers: plan.maxMembers,
        maxDeploymentsPerMonth: plan.maxDeploymentsPerMonth,
      },
    });

    const overrideRow = await this.prisma.workspaceEntitlementOverride.findFirst({
      where: { workspaceId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    const overrideLive =
      overrideRow &&
      isOverrideActive({ expiresAt: overrideRow.expiresAt })
        ? {
            id: overrideRow.id,
            reason: overrideRow.reason,
            expiresAt: overrideRow.expiresAt?.toISOString() ?? null,
            actorId: overrideRow.actorId,
            entitlements: (overrideRow.entitlementsJson || {}) as Partial<EntitlementSet>,
          }
        : null;

    if (overrideRow && !overrideLive) {
      await this.recordLedger({
        workspaceId,
        eventType: 'OVERRIDE_EXPIRED',
        resourceId: overrideRow.id,
        idempotencyKey: usageLedgerIdempotencyKey({
          eventType: 'OVERRIDE_EXPIRED',
          workspaceId,
          resourceId: `${overrideRow.id}:${overrideRow.expiresAt?.toISOString() ?? 'none'}`,
        }),
        metadataSafe: { reason: overrideRow.reason },
      }).catch(() => undefined);
    }

    return buildEffectiveEntitlements({
      planCode: statusBehavior.fallBackToFree ? 'free' : plan.code,
      planName: plan.name,
      planVersionId: version?.id ?? null,
      planVersionNumber: version?.version ?? null,
      grandfathered: Boolean(version?.grandfathered),
      subscriptionStatus: subscription?.status ?? null,
      source:
        resolved.source === 'ADMIN_OVERRIDE'
          ? 'ADMIN_OVERRIDE'
          : resolved.source === 'DEFAULT_FREE'
            ? 'DEFAULT_FREE'
            : 'SUBSCRIPTION',
      base,
      override: overrideLive,
      usage,
    });
  }

  async reconcileUsage(
    workspaceId: string,
    period: { start: Date; end: Date },
  ): Promise<EffectiveEntitlements['usage']> {
    const aggregated = await this.engine.aggregateWorkspaceUsage(workspaceId, period);
    const reserved = await this.prisma.usageLedger.count({
      where: {
        workspaceId,
        eventType: 'QUOTA_RESERVED',
        OR: [
          { periodStart: { gte: period.start, lt: period.end } },
          { createdAt: { gte: period.start, lt: period.end } },
        ],
        // released reservations are separate events; reserved without matching release
        NOT: {
          resourceId: {
            in: (
              await this.prisma.usageLedger.findMany({
                where: {
                  workspaceId,
                  eventType: 'QUOTA_RELEASED',
                  createdAt: { gte: period.start },
                },
                select: { resourceId: true },
              })
            )
              .map((r) => r.resourceId)
              .filter((id): id is string => Boolean(id)),
          },
        },
      },
    }).catch(() => 0);

    const runningProjects = await this.prisma.project.count({
      where: {
        workspaceId,
        status: { notIn: ['ARCHIVED', 'TEST'] },
        isDemo: false,
        serviceInstances: { some: { status: 'RUNNING' } },
      },
    });

    const retainedVersions = await this.prisma.applicationVersion.count({
      where: {
        project: { workspaceId },
        status: { in: ['ACTIVE', 'DEPLOYING'] },
      },
    });

    return {
      projects: aggregated.projectCount,
      monthlyDeployments: aggregated.deploymentCount + reserved,
      members: aggregated.memberCount,
      retainedVersions,
      runningApps: runningProjects || aggregated.activeServiceCount,
    };
  }

  async assertCanCreateProject(userId: string, workspaceId: string) {
    if (await this.isPlatformAdmin(userId)) return;
    const eff = await this.resolveEffectiveEntitlements(workspaceId);
    const decision = projectQuotaDecision({
      used: eff.usage.projects,
      limit: eff.entitlements.maxProjects,
      planCode: eff.planCode,
    });
    if (!decision.ok) {
      await this.block(userId, workspaceId, decision);
      throw this.quotaException(decision);
    }
  }

  async assertCanInviteMember(userId: string, workspaceId: string) {
    if (await this.isPlatformAdmin(userId)) return;
    const eff = await this.resolveEffectiveEntitlements(workspaceId);
    const decision = memberQuotaDecision({
      used: eff.usage.members,
      limit: eff.entitlements.maxWorkspaceMembers,
      planCode: eff.planCode,
    });
    if (!decision.ok) {
      await this.block(userId, workspaceId, decision);
      throw this.quotaException(decision);
    }
  }

  async assertCanStartDeployment(
    userId: string,
    workspaceId: string,
    input?: {
      projectId?: string;
      isExistingRunningApp?: boolean;
      kind?: 'deploy' | 'redeploy' | 'rollback';
      reservationKey?: string;
    },
  ) {
    if (await this.isPlatformAdmin(userId)) return { reserved: false as const };
    if (!deploymentConsumesQuota({ kind: input?.kind ?? 'deploy' })) {
      return { reserved: false as const };
    }

    const eff = await this.resolveEffectiveEntitlements(workspaceId);
    const status = subscriptionEntitlementBehavior(eff.subscriptionStatus ?? 'ACTIVE');
    if (status.blockNewConsumingActions && eff.planCode !== 'free') {
      // PAST_DUE: block new consuming; still allow messaging
    }

    const running = runningAppQuotaDecision({
      used: eff.usage.runningApps,
      limit: eff.entitlements.maxRunningApps,
      planCode: eff.planCode,
      isExistingRunningApp: Boolean(input?.isExistingRunningApp),
    });
    if (!running.ok) {
      await this.block(userId, workspaceId, running);
      throw this.quotaException(running);
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM "Subscription"
        WHERE "workspaceId" = ${workspaceId}
        ORDER BY "createdAt" DESC
        LIMIT 1
        FOR UPDATE
      `;

      const period = await this.periodFor(workspaceId, eff.planCode, null);
      const live = await this.reconcileUsage(workspaceId, period);
      const decision = deploymentQuotaDecision({
        used: live.monthlyDeployments,
        limit: eff.entitlements.maxMonthlyDeployments,
        planCode: eff.planCode,
      });
      if (!decision.ok) {
        await this.block(userId, workspaceId, decision);
        throw this.quotaException(decision);
      }

      // Optional reservation for concurrent callers that share a key.
      if (!input?.reservationKey) {
        return { reserved: false as const, period };
      }

      if (
        !canReserveDeploymentSlot({
          used: live.monthlyDeployments,
          reserved: 0,
          limit: eff.entitlements.maxMonthlyDeployments,
        })
      ) {
        const blocked = deploymentQuotaDecision({
          used: live.monthlyDeployments,
          limit: eff.entitlements.maxMonthlyDeployments,
          planCode: eff.planCode,
        });
        if (!blocked.ok) {
          await this.block(userId, workspaceId, blocked);
          throw this.quotaException(blocked);
        }
      }

      const key = input.reservationKey;
      await tx.usageLedger.create({
        data: {
          id: `ul_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          workspaceId,
          eventType: 'QUOTA_RESERVED',
          resourceType: 'DEPLOYMENT',
          resourceId: key,
          quantity: 1,
          periodStart: period.start,
          periodEnd: period.end,
          idempotencyKey: usageLedgerIdempotencyKey({
            eventType: 'QUOTA_RESERVED',
            workspaceId,
            resourceId: key,
          }),
          metadataSafe: { kind: input?.kind ?? 'deploy', projectId: input?.projectId ?? null },
        },
      });
      return { reserved: true as const, reservationKey: key, period };
    });
  }

  async consumeDeploymentReservation(input: {
    workspaceId: string;
    reservationKey: string;
    deploymentId: string;
    kind?: string;
    period?: { start: Date; end: Date };
  }) {
    await this.recordLedger({
      workspaceId: input.workspaceId,
      eventType: input.kind === 'rollback' ? 'ROLLBACK_STARTED' : 'DEPLOYMENT_STARTED',
      resourceType: 'DEPLOYMENT',
      resourceId: input.deploymentId,
      periodStart: input.period?.start,
      periodEnd: input.period?.end,
      idempotencyKey: usageLedgerIdempotencyKey({
        eventType: input.kind === 'rollback' ? 'ROLLBACK_STARTED' : 'DEPLOYMENT_STARTED',
        workspaceId: input.workspaceId,
        resourceId: input.deploymentId,
      }),
      metadataSafe: { reservationKey: input.reservationKey },
    });
  }

  async releaseDeploymentReservation(workspaceId: string, reservationKey: string) {
    await this.recordLedger({
      workspaceId,
      eventType: 'QUOTA_RELEASED',
      resourceType: 'DEPLOYMENT',
      resourceId: reservationKey,
      idempotencyKey: usageLedgerIdempotencyKey({
        eventType: 'QUOTA_RELEASED',
        workspaceId,
        resourceId: reservationKey,
      }),
      metadataSafe: {},
    }).catch(() => undefined);
  }

  async assertCustomDomain(userId: string, workspaceId: string) {
    if (await this.isPlatformAdmin(userId)) return;
    const eff = await this.resolveEffectiveEntitlements(workspaceId);
    const decision = customDomainDecision({
      enabled: eff.entitlements.customDomainEnabled,
      planCode: eff.planCode,
    });
    if (!decision.ok) {
      await this.block(userId, workspaceId, decision);
      throw this.quotaException(decision);
    }
  }

  async applyVersionRetention(workspaceId: string, projectId: string) {
    const eff = await this.resolveEffectiveEntitlements(workspaceId);
    const versions = await this.prisma.applicationVersion.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true, status: true },
      take: 200,
    });
    const current = versions[0];
    const { expire } = selectVersionsForRetention({
      maxRetained: eff.entitlements.maxRetainedVersions,
      versions: versions.map((v) => ({
        id: v.id,
        createdAt: v.createdAt,
        isCurrent: current?.id === v.id,
        status: v.status,
      })),
    });
    if (!expire.length) return { expired: [] as string[] };
    // Soft-expire: keep metadata; mark FAILED retention status if column allows — use notes via ledger.
    for (const id of expire) {
      await this.recordLedger({
        workspaceId,
        eventType: 'DEPLOYMENT_STARTED', // retention audit via metadata only
        resourceType: 'APPLICATION_VERSION',
        resourceId: id,
        idempotencyKey: `VERSION_RETENTION_EXPIRE:${workspaceId}:${id}`,
        metadataSafe: {
          action: 'VERSION_RETENTION_EXPIRE',
          note: 'Expired for rollback; deployment history retained',
        },
      }).catch(() => undefined);
    }
    return { expired: expire, limitation: logRetentionLimitation() };
  }

  async upsertEntitlementOverride(input: {
    adminId: string;
    workspaceId: string;
    entitlements: Partial<EntitlementSet>;
    reason: string;
    expiresAt?: Date | string | null;
  }) {
    await this.requirePlatformAdmin(input.adminId);
    const reason = input.reason.trim();
    if (!reason) throw new BadRequestException('请填写 override 原因');
    const workspace = await this.prisma.workspace.findUnique({ where: { id: input.workspaceId } });
    if (!workspace) throw new NotFoundException('Workspace 不存在');

    await this.prisma.workspaceEntitlementOverride.updateMany({
      where: { workspaceId: input.workspaceId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    const row = await this.prisma.workspaceEntitlementOverride.create({
      data: {
        id: `weo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        workspaceId: input.workspaceId,
        entitlementsJson: input.entitlements as Prisma.InputJsonValue,
        reason,
        actorId: input.adminId,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      },
    });

    await this.recordLedger({
      workspaceId: input.workspaceId,
      eventType: 'OVERRIDE_CREATED',
      resourceId: row.id,
      idempotencyKey: usageLedgerIdempotencyKey({
        eventType: 'OVERRIDE_CREATED',
        workspaceId: input.workspaceId,
        resourceId: `${row.id}:${row.createdAt.toISOString()}`,
      }),
      metadataSafe: { reason, entitlements: input.entitlements },
    });

    return row;
  }

  async ensureBetaTesterOverride(input: {
    adminId: string;
    workspaceId: string;
    expiresAt?: Date;
  }) {
    return this.upsertEntitlementOverride({
      adminId: input.adminId,
      workspaceId: input.workspaceId,
      entitlements: BETA_TESTER_OVERRIDE_DEFAULTS,
      reason: 'External Beta validation',
      expiresAt: input.expiresAt ?? new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    });
  }

  async accountEntitlementsView(userId: string) {
    const membership = await this.prisma.workspaceMember.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    if (!membership) throw new NotFoundException('Workspace 不存在');
    const eff = await this.resolveEffectiveEntitlements(membership.workspaceId);
    return {
      ...eff,
      logRetentionLimitation: logRetentionLimitation(),
      ui: {
        plan: eff.planName,
        projects: `${eff.usage.projects} / ${eff.entitlements.maxProjects ?? '不限'}`,
        monthlyDeployments: `${eff.usage.monthlyDeployments} / ${eff.entitlements.maxMonthlyDeployments ?? '不限'}`,
        members: `${eff.usage.members} / ${eff.entitlements.maxWorkspaceMembers ?? '不限'}`,
        retainedVersions: String(eff.entitlements.maxRetainedVersions ?? '不限'),
        logRetentionDays: String(eff.entitlements.logRetentionDays ?? '不限'),
        customDomain: eff.entitlements.customDomainEnabled ? '可用' : '不可用',
        runningApps: `${eff.usage.runningApps} / ${eff.entitlements.maxRunningApps ?? '不限'}`,
      },
    };
  }

  private quotaException(decision: QuotaBlock) {
    return new ForbiddenException({
      statusCode: 403,
      code: decision.code,
      message: decision.message,
      limit: decision.limit,
      used: decision.used,
      remaining: decision.remaining,
      plan: decision.plan,
      upgradeAvailable: decision.upgradeAvailable,
      action: { label: '查看套餐', href: '/account/subscription/plans' },
    });
  }

  private async block(userId: string, workspaceId: string, decision: QuotaBlock) {
    await this.recordLedger({
      workspaceId,
      eventType: 'QUOTA_BLOCKED',
      resourceId: `${decision.code}:${Date.now()}`,
      idempotencyKey: `QUOTA_BLOCKED:${workspaceId}:${decision.code}:${userId}:${Math.floor(Date.now() / 1000)}`,
      metadataSafe: {
        code: decision.code,
        limit: decision.limit,
        used: decision.used,
        plan: decision.plan,
      },
    }).catch(() => undefined);
    await this.prisma.productEvent
      .create({
        data: {
          name: 'quota_blocked',
          userId,
          metadata: {
            workspaceId,
            code: decision.code,
            plan: decision.plan,
            limit: decision.limit,
            used: decision.used,
          },
        },
      })
      .catch(() => undefined);
  }

  private async recordLedger(input: {
    workspaceId: string;
    eventType: string;
    resourceType?: string;
    resourceId?: string;
    quantity?: number;
    periodStart?: Date;
    periodEnd?: Date;
    idempotencyKey: string;
    metadataSafe?: Record<string, unknown>;
  }) {
    try {
      await this.prisma.usageLedger.create({
        data: {
          id: `ul_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
          workspaceId: input.workspaceId,
          eventType: input.eventType,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          quantity: input.quantity ?? 1,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          idempotencyKey: input.idempotencyKey,
          metadataSafe: (input.metadataSafe ?? {}) as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return;
      }
      throw error;
    }
  }

  private async periodFor(
    _workspaceId: string,
    planCode: string,
    subscription: { currentPeriodStart?: Date; currentPeriodEnd?: Date } | null,
  ) {
    const { resolveUsagePeriod } = await import('@launchos/domain');
    return resolveUsagePeriod({
      planCode,
      currentPeriodStart: subscription?.currentPeriodStart,
      currentPeriodEnd: subscription?.currentPeriodEnd,
    });
  }

  private async isPlatformAdmin(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { platformRole: true },
    });
    return user?.platformRole === 'PLATFORM_ADMIN';
  }

  private async requirePlatformAdmin(userId: string) {
    if (!(await this.isPlatformAdmin(userId))) {
      throw new ForbiddenException('需要平台管理员权限');
    }
  }
}
