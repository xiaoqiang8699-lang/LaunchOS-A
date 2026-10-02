import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class GrowthAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async overview() {
    const startOfToday = startOfDay(new Date());
    const [
      users,
      workspaces,
      projects,
      deploySuccess,
      runningApps,
      paidUsers,
      usersToday,
      projectsToday,
      deploysToday,
      deploySuccessToday,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.workspace.count(),
      this.prisma.project.count(),
      this.prisma.deployment.count({ where: { status: 'SUCCESS' } }),
      this.prisma.serviceInstance.count({ where: { status: 'RUNNING' } }),
      this.prisma.subscription.count({
        where: {
          status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE', 'CANCEL_AT_PERIOD_END'] },
          plan: { code: { not: 'free' } },
        },
      }),
      this.prisma.user.count({ where: { createdAt: { gte: startOfToday } } }),
      this.prisma.project.count({ where: { createdAt: { gte: startOfToday } } }),
      this.prisma.deployment.count({ where: { createdAt: { gte: startOfToday } } }),
      this.prisma.deployment.count({
        where: { createdAt: { gte: startOfToday }, status: 'SUCCESS' },
      }),
    ]);

    return {
      users,
      usersToday,
      workspaces,
      projects,
      projectsToday,
      deployments: deploySuccess,
      deploymentsToday: deploysToday,
      deploySuccessToday,
      runningApps,
      paidUsers,
    };
  }

  async funnel() {
    const registered = await this.prisma.user.count();
    const withWorkspace = await this.prisma.user.count({
      where: { memberships: { some: {} } },
    });
    const withProject = await this.prisma.user.count({
      where: { memberships: { some: { workspace: { projects: { some: {} } } } } },
    });
    const withDeploySuccess = await this.prisma.user.count({
      where: {
        memberships: {
          some: {
            workspace: {
              projects: { some: { deployments: { some: { status: 'SUCCESS' } } } },
            },
          },
        },
      },
    });
    const withDomain = await this.prisma.user.count({
      where: {
        memberships: {
          some: {
            workspace: {
              projects: { some: { applicationDomains: { some: {} } } },
            },
          },
        },
      },
    });
    const [planViewed, planChanged] = await Promise.all([
      this.uniqueUsersForEvent('PLAN_VIEWED'),
      this.uniqueUsersForEvent('PLAN_CHANGED'),
    ]);
    const upgraded = await this.prisma.user.count({
      where: {
        memberships: {
          some: {
            workspace: {
              subscriptions: {
                some: {
                  status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE', 'CANCEL_AT_PERIOD_END'] },
                  plan: { code: { not: 'free' } },
                },
              },
            },
          },
        },
      },
    });

    const steps = [
      { id: 'REGISTER', label: '注册用户', count: registered },
      { id: 'WORKSPACE', label: '创建 Workspace', count: withWorkspace },
      { id: 'PROJECT', label: '创建应用', count: withProject },
      { id: 'DEPLOY_SUCCESS', label: '首次部署成功', count: withDeploySuccess },
      { id: 'DOMAIN', label: '绑定域名', count: withDomain },
      { id: 'PLAN_VIEWED', label: '查看套餐', count: Math.max(planViewed, upgraded) },
      { id: 'PLAN_CHANGED', label: '升级套餐', count: Math.max(planChanged, upgraded) },
    ].map((step) => ({
      ...step,
      rate: registered > 0 ? Math.round((step.count / registered) * 1000) / 10 : 0,
    }));

    return { totalRegistered: registered, steps };
  }

  async usage() {
    const startOfToday = startOfDay(new Date());
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);

    const [
      projectsToday,
      deploymentsToday,
      deploySuccessToday,
      deployFailedToday,
      runningApps,
      recentSuccess,
      frameworks,
      dailyProjects,
      dailyDeploys,
    ] = await Promise.all([
      this.prisma.project.count({ where: { createdAt: { gte: startOfToday } } }),
      this.prisma.deployment.count({ where: { createdAt: { gte: startOfToday } } }),
      this.prisma.deployment.count({
        where: { createdAt: { gte: startOfToday }, status: 'SUCCESS' },
      }),
      this.prisma.deployment.count({
        where: { createdAt: { gte: startOfToday }, status: 'FAILED' },
      }),
      this.prisma.serviceInstance.count({ where: { status: 'RUNNING' } }),
      this.prisma.deployment.findMany({
        where: {
          status: 'SUCCESS',
          finishedAt: { not: null },
          createdAt: { gte: sevenDaysAgo },
        },
        select: { createdAt: true, finishedAt: true },
        take: 200,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.project.groupBy({
        by: ['framework'],
        _count: { _all: true },
        orderBy: { _count: { framework: 'desc' } },
        take: 20,
      }),
      this.dailyCounts('project', sevenDaysAgo),
      this.dailyCounts('deployment', sevenDaysAgo),
    ]);

    const durations = recentSuccess
      .map((row) =>
        row.finishedAt ? row.finishedAt.getTime() - row.createdAt.getTime() : null,
      )
      .filter((v): v is number => v != null && v > 0);
    const avgDeployMs =
      durations.length > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : null;

    const successRateToday =
      deploymentsToday > 0
        ? Math.round((deploySuccessToday / deploymentsToday) * 1000) / 10
        : null;

    return {
      projectsToday,
      deploymentsToday,
      deploySuccessToday,
      deployFailedToday,
      successRateToday,
      averageDeployDurationMs: avgDeployMs,
      runningApps,
      daily: {
        projects: dailyProjects,
        deployments: dailyDeploys,
      },
      techStack: normalizeTechStack(frameworks),
    };
  }

  async events(query: { page?: string; pageSize?: string; eventType?: string; q?: string }) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(query.pageSize) || 20));
    const eventType = query.eventType?.trim();
    const q = query.q?.trim();
    const where = {
      ...(eventType ? { name: eventType } : {}),
      ...(q
        ? {
            OR: [
              { userId: { contains: q } },
              { projectId: { contains: q } },
              { workspaceId: { contains: q } },
              { name: { contains: q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.productEvent.count({ where }),
      this.prisma.productEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          name: true,
          userId: true,
          workspaceId: true,
          projectId: true,
          createdAt: true,
          metadata: true,
          user: { select: { email: true, name: true } },
        },
      }),
    ]);
    return {
      page,
      pageSize,
      total,
      items: rows.map((row) => ({
        id: row.id,
        eventType: row.name,
        userId: row.userId,
        userEmail: row.user?.email ?? null,
        userName: row.user?.name ?? null,
        workspaceId: row.workspaceId,
        projectId: row.projectId,
        createdAt: row.createdAt,
        metadata: row.metadata,
      })),
    };
  }

  async commercial() {
    const [free, pro, team, enterprise, planViewed, planChanged, upgradeRequests] =
      await Promise.all([
        this.prisma.subscription.count({
          where: {
            status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE', 'CANCEL_AT_PERIOD_END'] },
            plan: { code: 'free' },
          },
        }),
        this.prisma.subscription.count({
          where: {
            status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE', 'CANCEL_AT_PERIOD_END'] },
            plan: { code: 'pro' },
          },
        }),
        this.prisma.subscription.count({
          where: {
            status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE', 'CANCEL_AT_PERIOD_END'] },
            plan: { code: 'team' },
          },
        }),
        this.prisma.subscription.count({
          where: {
            status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE', 'CANCEL_AT_PERIOD_END'] },
            plan: { code: 'enterprise' },
          },
        }),
        this.uniqueUsersForEvent('PLAN_VIEWED'),
        this.uniqueUsersForEvent('PLAN_CHANGED'),
        this.prisma.upgradeRequest.count(),
      ]);

    const freeUsers = free;
    return {
      distribution: { free, pro, team, enterprise },
      conversion: {
        freeUsers,
        planViewed,
        upgradeRequested: upgradeRequests,
        upgraded: planChanged + pro + team + enterprise > planChanged ? pro + team + enterprise : planChanged,
      },
      note: 'Beta 阶段不统计真实收入，不接入支付流水。',
    };
  }

  async userHealth(userId: string) {
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
                id: true,
                subscriptions: {
                  orderBy: { createdAt: 'desc' },
                  take: 1,
                  select: { status: true, plan: { select: { code: true, name: true } } },
                },
                projects: {
                  select: {
                    id: true,
                    _count: { select: { deployments: { where: { status: 'SUCCESS' } } } },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!user) return null;

    const projectCount = user.memberships.reduce(
      (sum, m) => sum + m.workspace.projects.length,
      0,
    );
    const deploySuccessCount = user.memberships.reduce(
      (sum, m) =>
        sum + m.workspace.projects.reduce((s, p) => s + p._count.deployments, 0),
      0,
    );
    const plan =
      user.memberships[0]?.workspace.subscriptions[0]?.plan ??
      ({ code: 'free', name: 'Free' } as const);

    const recentEvents = await this.prisma.productEvent.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, name: true, createdAt: true, projectId: true, workspaceId: true },
    });

    const lastActiveAt =
      recentEvents[0]?.createdAt ||
      user.lastLoginAt ||
      user.createdAt;
    const daysSinceActive = Math.floor(
      (Date.now() - new Date(lastActiveAt).getTime()) / (24 * 3600 * 1000),
    );
    const healthStatus =
      daysSinceActive <= 7 ? 'ACTIVE' : daysSinceActive <= 30 ? 'NEEDS_ATTENTION' : 'DORMANT';

    return {
      userId: user.id,
      email: user.email,
      name: user.name,
      firstSeenAt: user.createdAt,
      lastActiveAt,
      lastLoginAt: user.lastLoginAt,
      projectCount,
      deploySuccessCount,
      plan: { code: plan.code, name: plan.name },
      healthStatus,
      healthLabel:
        healthStatus === 'ACTIVE'
          ? '活跃'
          : healthStatus === 'NEEDS_ATTENTION'
            ? '需要关注'
            : '沉睡',
      recentEvents: recentEvents.map((e) => ({
        id: e.id,
        eventType: e.name,
        createdAt: e.createdAt,
        projectId: e.projectId,
        workspaceId: e.workspaceId,
      })),
    };
  }

  private async uniqueUsersForEvent(name: string) {
    const rows = await this.prisma.productEvent.findMany({
      where: { name, userId: { not: null } },
      distinct: ['userId'],
      select: { userId: true },
    });
    return rows.length;
  }

  private async dailyCounts(kind: 'project' | 'deployment', since: Date) {
    const rows =
      kind === 'project'
        ? await this.prisma.project.findMany({
            where: { createdAt: { gte: since } },
            select: { createdAt: true },
          })
        : await this.prisma.deployment.findMany({
            where: { createdAt: { gte: since } },
            select: { createdAt: true },
          });
    const map = new Map<string, number>();
    for (const row of rows) {
      const key = row.createdAt.toISOString().slice(0, 10);
      map.set(key, (map.get(key) || 0) + 1);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }));
  }
}

function startOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function normalizeTechStack(
  rows: Array<{ framework: string | null; _count: { _all: number } }>,
) {
  const buckets = {
    'Next.js': 0,
    Node: 0,
    Python: 0,
    其他: 0,
  };
  for (const row of rows) {
    const raw = (row.framework || '').toLowerCase();
    const count = row._count._all;
    if (!raw) {
      buckets['其他'] += count;
    } else if (raw.includes('next')) {
      buckets['Next.js'] += count;
    } else if (raw.includes('node') || raw.includes('express') || raw.includes('nest')) {
      buckets.Node += count;
    } else if (raw.includes('python') || raw.includes('django') || raw.includes('flask') || raw.includes('fastapi')) {
      buckets.Python += count;
    } else {
      buckets['其他'] += count;
    }
  }
  return (Object.keys(buckets) as Array<keyof typeof buckets>).map((name) => ({
    name,
    count: buckets[name],
  }));
}
