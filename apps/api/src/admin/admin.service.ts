import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { assertAdminRoute } from '@launchos/domain';
import {
  evaluateGitHubConnectionCapability,
  isGitHubAppConfigured,
  readGitHubAppConfig,
} from '@launchos/github';
import { PrismaService } from '../database/prisma.service';
import { WorkerPresenceService } from '../queue/worker-presence.service';
import { CapacityGovernanceService } from '../capacity/capacity-governance.service';
import { AdminWorkspacesService } from './admin-workspaces.service';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workers: WorkerPresenceService,
    private readonly workspacesAdmin: AdminWorkspacesService,
    private readonly capacity: CapacityGovernanceService,
  ) {}

  async overview() {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [users, workspaces, applications, launchSuccess, launchFailed, activeSubscriptions, alphaSessions, liveProjects, activeWorkspaces, suspendedWorkspaces, subscribed, unhealthy, overLimitWorkspaces, trialingWorkspaces, activePaidSubscriptions, complimentaryWorkspaces, cancelAtPeriodEndSubscriptions, expiredSubscriptions, freeWorkspaces, proWorkspaces, teamWorkspaces, enterpriseWorkspaces, upgradeRequestsPending, upgradeRequestsFromFree, trialUpgradeRequests, usersToday, workspacesToday, deploymentsToday, deploymentsTodaySuccess, deploymentsTodayFailed, deploymentsRunning, deploymentsQueued] =
      await Promise.all([
        this.prisma.user.count(),
        this.prisma.workspace.count(),
        this.prisma.project.count(),
        this.prisma.launchRun.count({ where: { status: 'SUCCESS' } }),
        this.prisma.launchRun.count({ where: { status: 'FAILED' } }),
        this.prisma.subscription.count({ where: { status: 'ACTIVE' } }),
        this.prisma.alphaTestSession.count(),
        this.prisma.launchRun.findMany({
          where: { status: 'SUCCESS' },
          select: { projectId: true },
        }),
        this.prisma.workspace.count({ where: { status: 'ACTIVE' } }),
        this.prisma.workspace.count({ where: { status: 'SUSPENDED' } }),
        this.prisma.subscription.findMany({ where: { status: 'ACTIVE' }, select: { workspaceId: true } }),
        this.prisma.serviceInstance.findMany({ where: { healthStatus: 'UNHEALTHY' }, select: { projectId: true } }),
        this.workspacesAdmin.countOverLimit(),
        this.prisma.subscription.count({ where: { status: 'TRIALING' } }),
        this.prisma.subscription.count({ where: { status: 'ACTIVE', source: 'PAYMENT_PROVIDER' } }),
        this.prisma.subscription.count({ where: { source: 'COMPLIMENTARY' } }),
        this.prisma.subscription.count({ where: { status: 'CANCEL_AT_PERIOD_END' } }),
        this.prisma.subscription.count({ where: { status: 'EXPIRED' } }),
        this.prisma.subscription.count({ where: { status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCEL_AT_PERIOD_END'] }, plan: { code: 'free' } } }),
        this.prisma.subscription.count({ where: { status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCEL_AT_PERIOD_END'] }, plan: { code: 'pro' } } }),
        this.prisma.subscription.count({ where: { status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCEL_AT_PERIOD_END'] }, plan: { code: 'team' } } }),
        this.prisma.subscription.count({ where: { status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCEL_AT_PERIOD_END'] }, plan: { code: 'enterprise' } } }),
        this.prisma.upgradeRequest.count({ where: { status: 'PENDING' } }),
        this.prisma.upgradeRequest.count({ where: { fromPlan: { code: 'free' } } }),
        this.prisma.upgradeRequest.count({ where: { fromSource: 'TRIAL' } }),
        this.prisma.user.count({ where: { createdAt: { gte: startOfToday } } }),
        this.prisma.workspace.count({ where: { createdAt: { gte: startOfToday } } }),
        this.prisma.deployment.count({ where: { createdAt: { gte: startOfToday } } }),
        this.prisma.deployment.count({ where: { createdAt: { gte: startOfToday }, status: 'SUCCESS' } }),
        this.prisma.deployment.count({ where: { createdAt: { gte: startOfToday }, status: 'FAILED' } }),
        this.prisma.deployment.count({ where: { status: 'RUNNING' } }),
        this.prisma.deployment.count({ where: { status: { in: ['CREATED', 'QUEUED'] } } }),
      ]);

    const runtime = await this.runtime().catch(() => null);
    const alphaCompleted = await this.prisma.alphaTestSession.count({ where: { sessionStatus: 'COMPLETED' } });
    const alphaFailed = await this.prisma.alphaTestSession.count({ where: { sessionStatus: 'FAILED' } });

    return {
      users,
      usersToday,
      workspaces,
      workspacesToday,
      applications,
      liveApplications: new Set(liveProjects.map((row) => row.projectId)).size,
      unhealthyApplications: new Set(unhealthy.map((row) => row.projectId)).size,
      launchSuccess,
      launchFailed,
      deploymentsToday,
      deploymentsTodaySuccess,
      deploymentsTodayFailed,
      deploymentsRunning,
      deploymentsQueued,
      deploymentSuccessRateToday:
        deploymentsToday > 0 ? Math.round((deploymentsTodaySuccess / deploymentsToday) * 100) : null,
      activeSubscriptions,
      alphaSessions,
      alphaCompleted,
      alphaFailed,
      activeWorkspaces,
      suspendedWorkspaces,
      subscribedWorkspaces: new Set(subscribed.map((row) => row.workspaceId)).size,
      overLimitWorkspaces,
      trialingWorkspaces,
      activePaidSubscriptions,
      complimentaryWorkspaces,
      cancelAtPeriodEndSubscriptions,
      expiredSubscriptions,
      freeWorkspaces,
      proWorkspaces,
      teamWorkspaces,
      enterpriseWorkspaces,
      upgradeRequestsPending,
      upgradeRequestsFromFree,
      trialUpgradeRequests,
      workerOnline: runtime?.workerOnline ?? null,
      queueWaiting: runtime?.capacity?.queueDepth?.deploymentQueue?.waiting ?? null,
      queueFailed: runtime?.capacity?.queueDepth?.deploymentQueue?.failed ?? null,
      capacityWarnings: runtime?.capacity?.warnings?.length ?? 0,
    };
  }

  async users() {
    const rows = await this.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
        lastLoginAt: true,
        platformRole: true,
        memberships: {
          select: {
            role: true,
            workspace: {
              select: {
                id: true,
                name: true,
                projects: { select: { id: true } },
                subscriptions: { select: { status: true }, orderBy: { createdAt: 'desc' }, take: 1 },
              },
            },
          },
        },
      },
    });
    return rows.map((row) => {
      const apps = row.memberships.reduce((sum, member) => sum + member.workspace.projects.length, 0);
      const subscription = row.memberships.find((member) => member.workspace.subscriptions[0])?.workspace
        .subscriptions[0];
      return {
        id: row.id,
        name: row.name,
        email: row.email,
        createdAt: row.createdAt,
        lastLoginAt: row.lastLoginAt,
        workspaces: row.memberships.map((member) => member.workspace.name),
        applications: apps,
        subscriptionStatus: subscription?.status ?? 'NONE',
        accountStatus: row.platformRole === 'PLATFORM_ADMIN' ? '平台管理员' : '正常',
      };
    });
  }

  async workspaces() {
    const rows = await this.prisma.workspace.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        owner: { select: { name: true, email: true } },
        _count: { select: { members: true, projects: true } },
        subscriptions: { include: { plan: true }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      owner: row.owner.name || row.owner.email,
      members: row._count.members,
      applications: row._count.projects,
      createdAt: row.createdAt,
      plan: row.subscriptions[0]?.plan.name ?? '未开通',
    }));
  }

  async workspace(id: string) {
    const row = await this.prisma.workspace.findUnique({
      where: { id },
      include: {
        owner: { select: { id: true, name: true, email: true } },
        _count: { select: { members: true, projects: true } },
        subscriptions: { include: { plan: true }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    if (!row) throw new NotFoundException('工作空间不存在');
    return {
      id: row.id,
      name: row.name,
      owner: row.owner.name || row.owner.email,
      ownerId: row.owner.id,
      members: row._count.members,
      applications: row._count.projects,
      createdAt: row.createdAt,
      plan: row.subscriptions[0]?.plan.name ?? '未开通',
    };
  }

  async applications() {
    const rows = await this.prisma.project.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        name: true,
        status: true,
        createdAt: true,
        workspace: { select: { name: true } },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      workspace: row.workspace.name,
      createdAt: row.createdAt,
    }));
  }

  async subscriptions() {
    return this.prisma.subscription.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        plan: true,
        workspace: { select: { name: true } },
      },
    });
  }

  async invoices() {
    return this.prisma.invoice.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { workspace: { select: { name: true } } },
    });
  }

  async runtime() {
    const presence = await this.workers.getDeploymentWorkerPresence();
    const credentialsConfigured = isGitHubAppConfigured();
    const config = readGitHubAppConfig();
    const github = evaluateGitHubConnectionCapability({
      configured: credentialsConfigured,
      callbackUrl:
        config?.callbackUrl ??
        process.env.GITHUB_APP_CALLBACK_URL?.trim() ??
        null,
      webOrigin: config?.webOrigin ?? process.env.WEB_ORIGIN?.trim() ?? null,
    });
    const capacity = await this.capacity.adminCapacityView().catch(() => null);
    return {
      workerOnline: presence.online,
      lastSeenAt: presence.lastSeenAt,
      queues: presence.queueReady,
      capacity,
      githubConnection: {
        status: github.status,
        ready: github.status === 'READY',
        callbackUrl: github.callbackUrl,
        diagnosis: github.diagnosis,
        reason: github.reason,
        requiresPublicHttps: github.requiresPublicHttps,
      },
    };
  }

  async audit() {
    return this.prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        user: { select: { email: true, name: true } },
        workspace: { select: { name: true } },
      },
    });
  }

  async listDeployments(query: Record<string, string>) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(query.pageSize) || 20));
    const status = query.status?.trim();
    const q = query.q?.trim();
    const where = {
      ...(status ? { status: status as never } : {}),
      ...(q
        ? {
            OR: [
              { id: { contains: q } },
              { project: { name: { contains: q, mode: 'insensitive' as const } } },
              { project: { workspace: { name: { contains: q, mode: 'insensitive' as const } } } },
              {
                project: {
                  workspace: { owner: { email: { contains: q, mode: 'insensitive' as const } } },
                },
              },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.deployment.count({ where }),
      this.prisma.deployment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          status: true,
          version: true,
          createdAt: true,
          finishedAt: true,
          errorMessage: true,
          failureCode: true,
          currentStage: true,
          project: {
            select: {
              id: true,
              name: true,
              workspace: {
                select: {
                  id: true,
                  name: true,
                  owner: { select: { id: true, email: true, name: true } },
                },
              },
            },
          },
        },
      }),
    ]);
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const [running, queued, todaySuccess, todayFailed] = await Promise.all([
      this.prisma.deployment.count({ where: { status: 'RUNNING' } }),
      this.prisma.deployment.count({ where: { status: { in: ['CREATED', 'QUEUED'] } } }),
      this.prisma.deployment.count({ where: { createdAt: { gte: startOfToday }, status: 'SUCCESS' } }),
      this.prisma.deployment.count({ where: { createdAt: { gte: startOfToday }, status: 'FAILED' } }),
    ]);
    return {
      page,
      pageSize,
      total,
      summary: { running, queued, todaySuccess, todayFailed },
      items: rows.map((row) => ({
        id: row.id,
        status: row.status,
        version: row.version,
        createdAt: row.createdAt,
        finishedAt: row.finishedAt,
        durationMs:
          row.finishedAt && row.createdAt
            ? Math.max(0, row.finishedAt.getTime() - row.createdAt.getTime())
            : null,
        failureCategory: row.failureCode ?? null,
        currentStage: row.currentStage ?? null,
        errorMessage: row.errorMessage ? String(row.errorMessage).slice(0, 240) : null,
        appId: row.project.id,
        appName: row.project.name,
        workspaceId: row.project.workspace.id,
        workspaceName: row.project.workspace.name,
        ownerEmail: row.project.workspace.owner.email,
        ownerName: row.project.workspace.owner.name,
      })),
    };
  }

  async getDeployment(id: string) {
    const row = await this.prisma.deployment.findUnique({
      where: { id },
      include: {
        project: {
          select: {
            id: true,
            name: true,
            workspace: {
              select: {
                id: true,
                name: true,
                owner: { select: { id: true, email: true, name: true } },
              },
            },
          },
        },
        steps: { orderBy: { createdAt: 'asc' } },
        serverInstance: {
          select: {
            id: true,
            name: true,
            status: true,
            scope: true,
            host: true,
          },
        },
        diagnoses: {
          orderBy: { createdAt: 'desc' },
          take: 3,
          select: {
            id: true,
            category: true,
            severity: true,
            title: true,
            description: true,
            createdAt: true,
          },
        },
      },
    });
    if (!row) throw new NotFoundException('部署不存在');
    const service = await this.prisma.serviceInstance.findFirst({
      where: { projectId: row.projectId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        healthStatus: true,
        port: true,
        runtime: true,
        serverInstanceId: true,
      },
    });
    return {
      id: row.id,
      status: row.status,
      version: row.version,
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
      errorMessage: row.errorMessage,
      failureCategory: row.failureCode ?? null,
      currentStage: row.currentStage ?? null,
      stageHistory: row.stageHistory ?? null,
      app: row.project,
      steps: row.steps.map((step) => ({
        id: step.id,
        name: step.name,
        status: step.status,
        message: step.errorMessage,
        createdAt: step.createdAt,
        finishedAt: step.finishedAt,
      })),
      serverInstance: row.serverInstance
        ? {
            id: row.serverInstance.id,
            name: row.serverInstance.name,
            status: row.serverInstance.status,
            scope: row.serverInstance.scope,
            host:
              row.serverInstance.scope === 'PLATFORM_MANAGED' ? row.serverInstance.host : null,
          }
        : null,
      serviceInstance: service,
      diagnoses: row.diagnoses,
    };
  }

  async listDomains(query: Record<string, string>) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(query.pageSize) || 20));
    const type = query.type?.trim();
    const status = query.status?.trim();
    const q = query.q?.trim();

    const appWhere = {
      ...(type ? { type: type as never } : {}),
      ...(status ? { status: status as never } : {}),
      ...(q
        ? {
            OR: [
              { domain: { contains: q, mode: 'insensitive' as const } },
              { project: { name: { contains: q, mode: 'insensitive' as const } } },
              { project: { workspace: { name: { contains: q, mode: 'insensitive' as const } } } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.applicationDomain.count({ where: appWhere }),
      this.prisma.applicationDomain.findMany({
        where: appWhere,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          domain: true,
          type: true,
          status: true,
          dnsStatus: true,
          sslStatus: true,
          createdAt: true,
          project: {
            select: {
              id: true,
              name: true,
              workspace: {
                select: { id: true, name: true, owner: { select: { email: true } } },
              },
            },
          },
        },
      }),
    ]);

    return {
      page,
      pageSize,
      total,
      items: rows.map((row) => ({
        id: row.id,
        hostname: row.domain,
        type: row.type,
        status: row.status,
        dnsStatus: row.dnsStatus,
        sslStatus: row.sslStatus,
        gatewayStatus: row.status,
        appId: row.project.id,
        appName: row.project.name,
        workspaceId: row.project.workspace.id,
        workspaceName: row.project.workspace.name,
        ownerEmail: row.project.workspace.owner.email,
        createdAt: row.createdAt,
      })),
    };
  }

  async listPlatformResources() {
    const [managed, owned] = await Promise.all([
      this.prisma.serverInstance.findMany({
        where: { scope: 'PLATFORM_MANAGED' },
        orderBy: { updatedAt: 'desc' },
        take: 50,
        select: {
          id: true,
          name: true,
          host: true,
          status: true,
          provider: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.serverInstance.findMany({
        where: { scope: 'WORKSPACE_OWNED' },
        orderBy: { updatedAt: 'desc' },
        take: 100,
        select: {
          id: true,
          name: true,
          status: true,
          dockerStatus: true,
          provider: true,
          createdAt: true,
          updatedAt: true,
          workspace: { select: { id: true, name: true, owner: { select: { email: true } } } },
        },
      }),
    ]);
    const runtime = await this.runtime().catch(() => null);
    const capacityServers = runtime?.capacity?.servers ?? [];
    return {
      managed: managed.map((server) => {
        const snap = capacityServers.find((item) => item.id === server.id || item.host === server.host);
        return {
          id: server.id,
          name: server.name,
          host: server.host,
          status: server.status,
          provider: server.provider,
          admission: snap?.admission ?? null,
          diskWarning: snap?.diskWarning ?? false,
          diskCritical: snap?.diskCritical ?? false,
          snapshot: snap?.snapshot ?? null,
        };
      }),
      owned: owned.map((server) => ({
        id: server.id,
        name: server.name,
        status: server.status,
        dockerStatus: server.dockerStatus,
        provider: server.provider,
        workspaceId: server.workspace?.id ?? null,
        workspaceName: server.workspace?.name ?? null,
        ownerEmail: server.workspace?.owner?.email ?? null,
        updatedAt: server.updatedAt,
      })),
    };
  }

  async requirePlatformAdmin(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { platformRole: true },
    });
    const decision = assertAdminRoute(user?.platformRole ?? 'USER');
    if (!decision.allowed) throw new ForbiddenException('需要平台管理员权限');
  }
}
