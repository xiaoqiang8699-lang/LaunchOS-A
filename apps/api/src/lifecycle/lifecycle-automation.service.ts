import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@launchos/database';
import { PrismaService } from '../database/prisma.service';

export const LIFECYCLE_TAGS = [
  'NEEDS_ONBOARDING',
  'DEPLOY_BLOCKED',
  'UPGRADE_POTENTIAL',
  'DORMANT',
  'HIGH_VALUE',
] as const;

export type LifecycleTag = (typeof LIFECYCLE_TAGS)[number];

export const DEFAULT_LIFECYCLE_RULES: Array<{
  name: string;
  description: string;
  triggerEvent: string;
  conditionJson: Record<string, unknown>;
  actionType: 'ADD_TAG' | 'CREATE_ALERT' | 'SHOW_IN_ADMIN';
  actionConfigJson: Record<string, unknown>;
}> = [
  {
    name: '新用户未创建项目',
    description: '注册后 24 小时内未创建项目，标记为需要引导',
    triggerEvent: 'USER_REGISTERED',
    conditionJson: { kind: 'NO_PROJECT_WITHIN_HOURS', hours: 24 },
    actionType: 'ADD_TAG',
    actionConfigJson: { tag: 'NEEDS_ONBOARDING', also: ['SHOW_IN_ADMIN'] },
  },
  {
    name: '部署失败用户',
    description: '出现 DEPLOY_FAILED 时标记部署阻塞，并记录失败原因',
    triggerEvent: 'DEPLOY_FAILED',
    conditionJson: { kind: 'ALWAYS' },
    actionType: 'ADD_TAG',
    actionConfigJson: { tag: 'DEPLOY_BLOCKED', also: ['CREATE_ALERT', 'SHOW_IN_ADMIN'] },
  },
  {
    name: '高活跃免费用户',
    description: '项目≥3 且成功部署≥5 且套餐 Free，标记升级潜力',
    triggerEvent: 'SCAN',
    conditionJson: { kind: 'UPGRADE_POTENTIAL', minProjects: 3, minDeploySuccess: 5, planCode: 'free' },
    actionType: 'ADD_TAG',
    actionConfigJson: { tag: 'UPGRADE_POTENTIAL', also: ['SHOW_IN_ADMIN'] },
  },
  {
    name: '沉默用户',
    description: '30 天无 ProductEvent / 登录行为，标记 DORMANT',
    triggerEvent: 'SCAN',
    conditionJson: { kind: 'INACTIVE_DAYS', days: 30 },
    actionType: 'ADD_TAG',
    actionConfigJson: { tag: 'DORMANT', also: ['SHOW_IN_ADMIN'] },
  },
];

type ProductEventLike = {
  name: string;
  userId?: string | null;
  workspaceId?: string | null;
  projectId?: string | null;
  metadata?: Record<string, unknown>;
};

@Injectable()
export class LifecycleAutomationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LifecycleAutomationService.name);
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private scanning = false;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.ensureDefaultRules().catch((error) => {
      this.logger.warn(
        `ensureDefaultRules failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    });
    // Daily scanner (also run once shortly after boot for Beta ops).
    setTimeout(() => {
      void this.runDailyScan().catch(() => undefined);
    }, 15_000);
    this.scanTimer = setInterval(
      () => {
        void this.runDailyScan().catch(() => undefined);
      },
      24 * 60 * 60 * 1000,
    );
  }

  onModuleDestroy() {
    if (this.scanTimer) clearInterval(this.scanTimer);
  }

  async ensureDefaultRules() {
    for (const rule of DEFAULT_LIFECYCLE_RULES) {
      const existing = await this.prisma.lifecycleRule.findFirst({
        where: { name: rule.name },
        select: { id: true },
      });
      if (existing) continue;
      await this.prisma.lifecycleRule.create({
        data: {
          name: rule.name,
          description: rule.description,
          triggerEvent: rule.triggerEvent,
          conditionJson: rule.conditionJson as Prisma.InputJsonValue,
          actionType: rule.actionType,
          actionConfigJson: rule.actionConfigJson as Prisma.InputJsonValue,
          status: 'ACTIVE',
        },
      });
    }
  }

  async overview() {
    const [activeRules, totalRules, triggerCount, pendingUsers, completedActions] =
      await Promise.all([
        this.prisma.lifecycleRule.count({ where: { status: 'ACTIVE' } }),
        this.prisma.lifecycleRule.count(),
        this.prisma.lifecycleAction.count(),
        this.prisma.lifecycleAction.groupBy({
          by: ['userId'],
          where: { status: 'PENDING' },
        }),
        this.prisma.lifecycleAction.count({ where: { status: 'COMPLETED' } }),
      ]);
    return {
      activeRules,
      totalRules,
      triggerCount,
      pendingUsers: pendingUsers.length,
      completedActions,
    };
  }

  async listRules() {
    const rows = await this.prisma.lifecycleRule.findMany({
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { actions: true } } },
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        triggerEvent: row.triggerEvent,
        conditionJson: row.conditionJson,
        actionType: row.actionType,
        actionConfigJson: row.actionConfigJson,
        status: row.status,
        actionCount: row._count.actions,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
    };
  }

  async createRule(input: {
    name: string;
    description?: string;
    triggerEvent: string;
    conditionJson?: Record<string, unknown>;
    actionType: 'ADD_TAG' | 'CREATE_ALERT' | 'SHOW_IN_ADMIN';
    actionConfigJson?: Record<string, unknown>;
    status?: 'ACTIVE' | 'DISABLED';
  }) {
    const row = await this.prisma.lifecycleRule.create({
      data: {
        name: input.name.slice(0, 120),
        description: input.description?.slice(0, 500) || null,
        triggerEvent: input.triggerEvent.slice(0, 80),
        conditionJson: (input.conditionJson || {}) as Prisma.InputJsonValue,
        actionType: input.actionType,
        actionConfigJson: (input.actionConfigJson || {}) as Prisma.InputJsonValue,
        status: input.status || 'ACTIVE',
      },
    });
    return row;
  }

  async updateRule(
    id: string,
    input: Partial<{
      name: string;
      description: string | null;
      triggerEvent: string;
      conditionJson: Record<string, unknown>;
      actionType: 'ADD_TAG' | 'CREATE_ALERT' | 'SHOW_IN_ADMIN';
      actionConfigJson: Record<string, unknown>;
      status: 'ACTIVE' | 'DISABLED';
    }>,
  ) {
    return this.prisma.lifecycleRule.update({
      where: { id },
      data: {
        ...(input.name != null ? { name: input.name.slice(0, 120) } : {}),
        ...(input.description !== undefined
          ? { description: input.description?.slice(0, 500) ?? null }
          : {}),
        ...(input.triggerEvent != null ? { triggerEvent: input.triggerEvent.slice(0, 80) } : {}),
        ...(input.conditionJson != null
          ? { conditionJson: input.conditionJson as Prisma.InputJsonValue }
          : {}),
        ...(input.actionType != null ? { actionType: input.actionType } : {}),
        ...(input.actionConfigJson != null
          ? { actionConfigJson: input.actionConfigJson as Prisma.InputJsonValue }
          : {}),
        ...(input.status != null ? { status: input.status } : {}),
      },
    });
  }

  async toggleRule(id: string) {
    const current = await this.prisma.lifecycleRule.findUnique({ where: { id } });
    if (!current) return null;
    return this.prisma.lifecycleRule.update({
      where: { id },
      data: { status: current.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' },
    });
  }

  /** Called after ProductEvent is persisted. Fire-and-forget safe. */
  async onProductEvent(event: ProductEventLike): Promise<void> {
    if (!event.userId) return;
    try {
      // Clear onboarding need once a project exists.
      if (event.name === 'PROJECT_CREATED') {
        await this.removeTag(event.userId, 'NEEDS_ONBOARDING');
      }
      if (event.name === 'DEPLOY_SUCCESS') {
        await this.removeTag(event.userId, 'DEPLOY_BLOCKED');
      }

      const rules = await this.prisma.lifecycleRule.findMany({
        where: { status: 'ACTIVE', triggerEvent: event.name },
      });
      for (const rule of rules) {
        const matched = await this.evaluateCondition(rule.conditionJson, event.userId, event);
        if (!matched.ok) continue;
        await this.executeRule(rule.id, event.userId, rule.actionType, rule.actionConfigJson, matched.reason);
      }
    } catch (error) {
      this.logger.warn(
        `onProductEvent failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }

  async runDailyScan() {
    if (this.scanning) return { skipped: true };
    this.scanning = true;
    try {
      // Replay recent product events so engine-written DEPLOY_* also drive rules.
      const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
      const recentEvents = await this.prisma.productEvent.findMany({
        where: {
          createdAt: { gte: since },
          name: {
            in: [
              'USER_REGISTERED',
              'PROJECT_CREATED',
              'DEPLOY_FAILED',
              'DEPLOY_SUCCESS',
              'PLAN_CHANGED',
            ],
          },
          userId: { not: null },
        },
        orderBy: { createdAt: 'asc' },
        take: 2000,
        select: {
          name: true,
          userId: true,
          workspaceId: true,
          projectId: true,
          metadata: true,
        },
      });
      for (const event of recentEvents) {
        await this.onProductEvent({
          name: event.name,
          userId: event.userId,
          workspaceId: event.workspaceId,
          projectId: event.projectId,
          metadata: (event.metadata as Record<string, unknown>) || {},
        });
      }

      const rules = await this.prisma.lifecycleRule.findMany({
        where: { status: 'ACTIVE', triggerEvent: { in: ['SCAN', 'USER_REGISTERED'] } },
      });
      const users = await this.prisma.user.findMany({
        where: { accountStatus: { not: 'ARCHIVED' } },
        select: { id: true, createdAt: true },
        take: 2000,
        orderBy: { createdAt: 'desc' },
      });
      let matched = 0;
      for (const user of users) {
        for (const rule of rules) {
          const eventName =
            rule.triggerEvent === 'USER_REGISTERED' ? 'USER_REGISTERED' : 'SCAN';
          const fakeEvent: ProductEventLike = { name: eventName, userId: user.id };
          const result = await this.evaluateCondition(rule.conditionJson, user.id, fakeEvent);
          if (!result.ok) continue;
          await this.executeRule(
            rule.id,
            user.id,
            rule.actionType,
            rule.actionConfigJson,
            result.reason,
          );
          matched += 1;
        }
      }
      this.logger.log(
        `Lifecycle daily scan matched=${matched} users=${users.length} replayed=${recentEvents.length}`,
      );
      return { matched, users: users.length, replayed: recentEvents.length };
    } finally {
      this.scanning = false;
    }
  }

  async userLifecycle(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
        lastLoginAt: true,
        memberships: {
          select: {
            workspace: {
              select: {
                projects: {
                  select: {
                    id: true,
                    _count: { select: { deployments: { where: { status: 'SUCCESS' } } } },
                  },
                },
                subscriptions: {
                  orderBy: { createdAt: 'desc' },
                  take: 1,
                  select: { plan: { select: { code: true, name: true } } },
                },
              },
            },
          },
        },
      },
    });
    if (!user) return null;

    const [tags, recentEvents, actions, latestFailed] = await Promise.all([
      this.prisma.userTag.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.productEvent.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        take: 50,
        select: {
          id: true,
          name: true,
          createdAt: true,
          projectId: true,
          workspaceId: true,
          metadata: true,
        },
      }),
      this.prisma.lifecycleAction.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: { rule: { select: { id: true, name: true } } },
      }),
      this.prisma.deployment.findFirst({
        where: {
          status: 'FAILED',
          project: { workspace: { members: { some: { userId } } } },
        },
        orderBy: { createdAt: 'desc' },
        select: { errorMessage: true, failureCode: true, createdAt: true },
      }),
    ]);

    const projectCount = user.memberships.reduce((s, m) => s + m.workspace.projects.length, 0);
    const deploySuccessCount = user.memberships.reduce(
      (s, m) => s + m.workspace.projects.reduce((a, p) => a + p._count.deployments, 0),
      0,
    );
    const plan = user.memberships[0]?.workspace.subscriptions[0]?.plan ?? {
      code: 'free',
      name: 'Free',
    };

    const tagSet = new Set(tags.map((t) => t.tag));
    let statusLabel = '正常';
    let statusCode = 'ACTIVE';
    if (tagSet.has('DEPLOY_BLOCKED')) {
      statusLabel = '部署阻塞';
      statusCode = 'DEPLOY_BLOCKED';
    } else if (tagSet.has('NEEDS_ONBOARDING')) {
      statusLabel = '需要引导';
      statusCode = 'NEEDS_ONBOARDING';
    } else if (tagSet.has('UPGRADE_POTENTIAL')) {
      statusLabel = '高活跃免费用户';
      statusCode = 'UPGRADE_POTENTIAL';
    } else if (tagSet.has('DORMANT')) {
      statusLabel = '沉默用户';
      statusCode = 'DORMANT';
    } else if (tagSet.has('HIGH_VALUE')) {
      statusLabel = '高价值用户';
      statusCode = 'HIGH_VALUE';
    }

    const reasonParts: string[] = [];
    if (projectCount > 0) reasonParts.push(`创建${projectCount}个应用`);
    if (deploySuccessCount > 0) reasonParts.push(`成功部署${deploySuccessCount}次`);
    if (latestFailed?.errorMessage && tagSet.has('DEPLOY_BLOCKED')) {
      reasonParts.push(`最近失败：${latestFailed.errorMessage}`);
    }

    const timeline = recentEvents.map((e) => ({
      id: e.id,
      eventType: e.name,
      label: timelineLabel(e.name),
      createdAt: e.createdAt,
      projectId: e.projectId,
      workspaceId: e.workspaceId,
    }));

    return {
      userId: user.id,
      email: user.email,
      name: user.name,
      statusCode,
      statusLabel,
      tags: tags.map((t) => ({
        id: t.id,
        tag: t.tag,
        source: t.source,
        createdAt: t.createdAt,
      })),
      reason: reasonParts.join(' · ') || null,
      plan,
      projectCount,
      deploySuccessCount,
      lastFailedDeploy: latestFailed
        ? {
            errorMessage: latestFailed.errorMessage,
            failureCode: latestFailed.failureCode,
            createdAt: latestFailed.createdAt,
          }
        : null,
      timeline,
      triggeredRules: actions.map((a) => ({
        id: a.id,
        ruleId: a.ruleId,
        ruleName: a.rule?.name ?? null,
        actionType: a.actionType,
        status: a.status,
        detail: a.detailJson,
        createdAt: a.createdAt,
      })),
    };
  }

  private async evaluateCondition(
    conditionJson: unknown,
    userId: string,
    event: ProductEventLike,
  ): Promise<{ ok: boolean; reason?: string }> {
    const condition = (conditionJson || {}) as Record<string, unknown>;
    const kind = String(condition.kind || 'ALWAYS');

    if (kind === 'ALWAYS') {
      const reason =
        event.name === 'DEPLOY_FAILED'
          ? String(event.metadata?.errorMessage || event.metadata?.failureCode || '部署失败')
          : undefined;
      return { ok: true, reason };
    }

    if (kind === 'NO_PROJECT_WITHIN_HOURS') {
      const hours = Number(condition.hours) || 24;
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { createdAt: true },
      });
      if (!user) return { ok: false };
      const ageMs = Date.now() - user.createdAt.getTime();
      if (ageMs < hours * 3600 * 1000) return { ok: false };
      const projectEvent = await this.prisma.productEvent.findFirst({
        where: { userId, name: 'PROJECT_CREATED' },
        select: { id: true },
      });
      if (projectEvent) return { ok: false };
      const membershipProject = await this.prisma.user.count({
        where: {
          id: userId,
          memberships: { some: { workspace: { projects: { some: {} } } } },
        },
      });
      if (membershipProject > 0) return { ok: false };
      return { ok: true, reason: `注册超过${hours}小时仍未创建项目` };
    }

    if (kind === 'UPGRADE_POTENTIAL') {
      const minProjects = Number(condition.minProjects) || 3;
      const minDeploySuccess = Number(condition.minDeploySuccess) || 5;
      const planCode = String(condition.planCode || 'free');
      const stats = await this.userUsageStats(userId);
      if (stats.projectCount < minProjects) return { ok: false };
      if (stats.deploySuccessCount < minDeploySuccess) return { ok: false };
      if (stats.planCode !== planCode) return { ok: false };
      return {
        ok: true,
        reason: `创建${stats.projectCount}个应用 · 成功部署${stats.deploySuccessCount}次 · 套餐 ${stats.planCode}`,
      };
    }

    if (kind === 'INACTIVE_DAYS') {
      const days = Number(condition.days) || 30;
      const since = new Date(Date.now() - days * 24 * 3600 * 1000);
      const recent = await this.prisma.productEvent.findFirst({
        where: { userId, createdAt: { gte: since } },
        select: { id: true },
      });
      if (recent) return { ok: false };
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { lastLoginAt: true, createdAt: true },
      });
      const lastLogin = user?.lastLoginAt || user?.createdAt;
      if (lastLogin && lastLogin >= since) return { ok: false };
      return { ok: true, reason: `${days}天无行为` };
    }

    return { ok: false };
  }

  private async userUsageStats(userId: string) {
    const memberships = await this.prisma.workspaceMember.findMany({
      where: { userId },
      select: {
        workspace: {
          select: {
            projects: {
              select: {
                id: true,
                _count: { select: { deployments: { where: { status: 'SUCCESS' } } } },
              },
            },
            subscriptions: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { plan: { select: { code: true } } },
            },
          },
        },
      },
    });
    const projectCount = memberships.reduce((s, m) => s + m.workspace.projects.length, 0);
    const deploySuccessCount = memberships.reduce(
      (s, m) => s + m.workspace.projects.reduce((a, p) => a + p._count.deployments, 0),
      0,
    );
    const planCode = memberships[0]?.workspace.subscriptions[0]?.plan.code || 'free';
    return { projectCount, deploySuccessCount, planCode };
  }

  private async executeRule(
    ruleId: string,
    userId: string,
    actionType: string,
    actionConfigJson: unknown,
    reason?: string,
  ) {
    const config = (actionConfigJson || {}) as Record<string, unknown>;
    const tag = String(config.tag || '').toUpperCase();
    const also = Array.isArray(config.also) ? config.also.map(String) : [];

    if (actionType === 'ADD_TAG' && tag) {
      await this.upsertTag(userId, tag);
      await this.createAction(ruleId, userId, 'ADD_TAG', 'COMPLETED', { tag, reason });
    }
    if (actionType === 'CREATE_ALERT' || also.includes('CREATE_ALERT')) {
      await this.createAction(ruleId, userId, 'CREATE_ALERT', 'PENDING', { tag, reason });
    }
    if (actionType === 'SHOW_IN_ADMIN' || also.includes('SHOW_IN_ADMIN')) {
      await this.createAction(ruleId, userId, 'SHOW_IN_ADMIN', 'PENDING', { tag, reason });
    }
  }

  private async upsertTag(userId: string, tag: string) {
    await this.prisma.userTag.upsert({
      where: { userId_tag: { userId, tag } },
      create: { userId, tag, source: 'SYSTEM' },
      update: {},
    });
  }

  private async removeTag(userId: string, tag: string) {
    await this.prisma.userTag.deleteMany({ where: { userId, tag } });
  }

  private async createAction(
    ruleId: string,
    userId: string,
    actionType: 'ADD_TAG' | 'CREATE_ALERT' | 'SHOW_IN_ADMIN',
    status: 'PENDING' | 'COMPLETED' | 'DISMISSED',
    detail: Record<string, unknown>,
  ) {
    // Dedupe pending SHOW_IN_ADMIN / CREATE_ALERT per rule+user within 24h
    if (status === 'PENDING') {
      const since = new Date(Date.now() - 24 * 3600 * 1000);
      const existing = await this.prisma.lifecycleAction.findFirst({
        where: {
          ruleId,
          userId,
          actionType,
          status: 'PENDING',
          createdAt: { gte: since },
        },
        select: { id: true },
      });
      if (existing) return existing;
    }
    return this.prisma.lifecycleAction.create({
      data: {
        ruleId,
        userId,
        actionType,
        status,
        detailJson: detail as Prisma.InputJsonValue,
      },
    });
  }
}

function timelineLabel(name: string): string {
  const map: Record<string, string> = {
    USER_REGISTERED: '注册账号',
    WORKSPACE_CREATED: '创建 Workspace',
    PROJECT_CREATED: '创建项目',
    SOURCE_CONNECTED: '连接源码',
    DEPLOY_STARTED: '开始部署',
    DEPLOY_SUCCESS: '部署成功',
    DEPLOY_FAILED: '部署失败',
    DOMAIN_CONNECTED: '绑定域名',
    PLAN_VIEWED: '查看套餐',
    PLAN_CHANGED: '变更套餐',
  };
  return map[name] || name;
}
