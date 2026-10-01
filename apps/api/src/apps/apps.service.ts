import { BadRequestException, Injectable } from '@nestjs/common';
import {
  ApplicationDomainType,
  ApplicationVersionStatus,
  ArtifactStatus,
  ArtifactType,
  CodeUpdateStatus,
  DeploymentStatus,
  HealthStatus,
  ServiceStatus,
} from '@launchos/database';
import { createRuntimeProvider, RuntimeError, type RuntimeProvider } from '@launchos/runtime';
import {
  readGatewayPublicIp,
  toVisitUrls,
  verifyPublicEntryWithRetry,
} from '@launchos/domain';
import {
  buildRuntimeFixPrompt,
  decideProductRuntimeHealth,
  redactSecrets,
  relativeCheckLabelZh,
} from '@launchos/shared';
import { PrismaService } from '../database/prisma.service';
import { DeploymentsService } from '../deployments/deployments.service';
import { decryptCredential } from '../security/credential-cipher';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import { ProjectsService } from '../projects/projects.service';
import type { UpdateAppSettingsDto } from './dto/update-app-settings.dto';

const LOG_TAIL_DEFAULT = 200;
const LOG_TAIL_MAX = 500;

@Injectable()
export class AppsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaceAccess: WorkspaceAccessService,
    private readonly projects: ProjectsService,
    private readonly deployments: DeploymentsService,
  ) {}

  async start(userId: string, appId: string, deployableUnitId?: string) {
    return this.runAction(userId, appId, 'start', deployableUnitId);
  }

  async stop(userId: string, appId: string, deployableUnitId?: string) {
    return this.runAction(userId, appId, 'stop', deployableUnitId);
  }

  async restart(userId: string, appId: string, deployableUnitId?: string) {
    return this.runAction(userId, appId, 'restart', deployableUnitId);
  }

  async logs(userId: string, appId: string, tail?: number) {
    const { provider, service } = await this.requireManagedApp(userId, appId, false);
    const limit = Math.min(
      Math.max(Number.isInteger(tail) ? Number(tail) : LOG_TAIL_DEFAULT, 1),
      LOG_TAIL_MAX,
    );
    try {
      const raw = await provider.getLogs(service.containerId, limit);
      const secretKeys = (
        await this.prisma.runtimeConfigValue.findMany({
          where: { projectId: appId, isSensitive: true },
          select: { key: true },
          take: 200,
        })
      ).map((row) => row.key);
      const logs = redactSecrets(String(raw || '').trim(), [], secretKeys);
      const lines = logs ? logs.split(/\r?\n/) : [];
      return {
        logs,
        lineCount: lines.length,
        limit,
        truncated: lines.length >= limit,
        serviceInstanceId: service.id,
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      throw toUserError(error, '暂时无法读取运行日志');
    }
  }

  async health(userId: string, appId: string, opts?: { refreshPublic?: boolean }) {
    return this.runtimeHealth(userId, appId, opts);
  }

  /**
   * Beta M3 — unified runtime + public health for ordinary users.
   * Prefer persisted SI health; optionally refresh public probe when stale.
   */
  async runtimeHealth(userId: string, appId: string, opts?: { refreshPublic?: boolean }) {
    await this.workspaceAccess.requireProjectAccess(userId, appId);

    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: appId },
      select: {
        id: true,
        name: true,
        applicationDomains: {
          where: { type: ApplicationDomainType.SYSTEM },
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            domain: true,
            status: true,
            dnsStatus: true,
            sslStatus: true,
            deployableUnitId: true,
          },
        },
      },
    });

    const environment = await this.prisma.projectEnvironment.findFirst({
      where: { projectId: appId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        activeDeploymentId: true,
      },
    });

    const serviceSelect = {
      id: true,
      status: true,
      healthStatus: true,
      lastHealthCheckAt: true,
      responseTimeMs: true,
      healthMessage: true,
      createdAt: true,
      deployableUnitId: true,
      artifactId: true,
      healthChecks: {
        orderBy: { checkedAt: 'desc' as const },
        take: 24,
        select: {
          id: true,
          status: true,
          responseTimeMs: true,
          statusCode: true,
          message: true,
          checkedAt: true,
        },
      },
    };

    const service = await this.prisma.serviceInstance.findFirst({
      where: { projectId: appId, status: ServiceStatus.RUNNING },
      orderBy: { createdAt: 'desc' },
      select: serviceSelect,
    });

    const stoppedFallback =
      service ||
      (await this.prisma.serviceInstance.findFirst({
        where: { projectId: appId },
        orderBy: { createdAt: 'desc' },
        select: serviceSelect,
      }));
    const activeService = stoppedFallback;

    const activeDeploymentId = environment?.activeDeploymentId || null;
    const activeDeployment = activeDeploymentId
      ? await this.prisma.deployment.findUnique({
          where: { id: activeDeploymentId },
          select: {
            id: true,
            version: true,
            status: true,
            sourceArtifactId: true,
            startedAt: true,
            finishedAt: true,
            errorMessage: true,
            failureCode: true,
          },
        })
      : null;

    const inFlight = await this.prisma.deployment.findFirst({
      where: {
        projectId: appId,
        status: {
          in: [DeploymentStatus.CREATED, DeploymentStatus.QUEUED, DeploymentStatus.RUNNING],
        },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        sourceArtifactId: true,
        version: true,
        applicationVersion: {
          select: { commitMessage: true },
        },
      },
    });
    const inFlightIsRollback = Boolean(
      inFlight?.applicationVersion?.commitMessage &&
        /^恢复自\s+/.test(inFlight.applicationVersion.commitMessage),
    );

    const currentVersion = await this.prisma.applicationVersion.findFirst({
      where: {
        projectId: appId,
        status: ApplicationVersionStatus.ACTIVE,
        ...(activeService?.deployableUnitId
          ? { deployableUnitId: activeService.deployableUnitId }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        version: true,
        deploymentId: true,
        commitSha: true,
        commitMessage: true,
      },
    });

    const domain =
      project.applicationDomains.find((d) =>
        activeService?.deployableUnitId
          ? d.deployableUnitId === activeService.deployableUnitId || d.deployableUnitId == null
          : true,
      ) || project.applicationDomains[0];
    const visit = domain ? toVisitUrls(domain) : { visitUrl: null as string | null, dnsReady: false };
    const route = domain?.domain
      ? await this.prisma.gatewayRoute.findUnique({
          where: { hostname: domain.domain },
          select: { status: true, targetPort: true },
        })
      : null;

    const publicHistory = (activeService?.healthChecks || []).filter((item) =>
      String(item.message || '').startsWith('public:'),
    );
    let lastPublic = publicHistory[0] || null;
    let publicOk: boolean | null =
      lastPublic == null
        ? null
        : lastPublic.status === HealthStatus.HEALTHY
          ? true
          : lastPublic.status === HealthStatus.UNHEALTHY
            ? false
            : null;
    let publicHttpStatus = lastPublic?.statusCode ?? null;
    let lastPublicCheckAt = lastPublic?.checkedAt ?? null;
    let publicLatencyMs = lastPublic?.responseTimeMs ?? null;

    const shouldRefreshPublic = Boolean(opts?.refreshPublic);

    if (
      shouldRefreshPublic &&
      visit.visitUrl &&
      domain?.domain &&
      activeService?.status === ServiceStatus.RUNNING
    ) {
      try {
        const expectedIp = readGatewayPublicIp();
        if (!expectedIp) {
          // Gateway IP unset — keep persisted probe; do not invent failure.
        } else {
          const started = Date.now();
          const verify = await verifyPublicEntryWithRetry({
            hostname: domain.domain,
            path: '/',
            expectedIp,
            acceptStatuses: [200, 201, 204, 301, 302, 307, 308],
            attempts: 1,
            backoffMs: 0,
          });
          publicOk = verify.ok;
          publicHttpStatus = verify.httpStatus ?? null;
          publicLatencyMs = Math.max(0, Date.now() - started);
          lastPublicCheckAt = new Date();
          if (activeService?.id) {
            await this.prisma.serviceHealthCheck.create({
              data: {
                serviceInstanceId: activeService.id,
                status: verify.ok ? HealthStatus.HEALTHY : HealthStatus.UNHEALTHY,
                statusCode: verify.httpStatus ?? null,
                responseTimeMs: publicLatencyMs,
                message: `public:${verify.ok ? 'OK' : verify.failureCode || 'FAIL'}:http=${verify.httpStatus ?? 'none'}`,
                checkedAt: lastPublicCheckAt,
              },
            });
          }
        }
      } catch {
        // Probe infrastructure failure — do not mark app unhealthy.
      }
    }

    const decision = decideProductRuntimeHealth({
      serviceStatus: activeService?.status,
      runtimeHealth: activeService?.healthStatus,
      healthMessage: activeService?.healthMessage,
      lastHealthCheckAt: activeService?.lastHealthCheckAt,
      gatewayStatus: route?.status || domain?.status,
      dnsStatus: domain?.dnsStatus,
      sslStatus: domain?.sslStatus,
      publicHttpStatus,
      publicOk,
      lastPublicCheckAt,
      activeDeployStatus: inFlight?.status,
      activeDeployIsRollback: inFlightIsRollback,
    });

    const startedAt = activeService?.createdAt || null;
    const startupSummary = buildStartupSummary({
      serviceStatus: activeService?.status,
      healthStatus: activeService?.healthStatus,
      healthMessage: activeService?.healthMessage,
      startedAt,
      deployment: activeDeployment,
    });

    const fixPrompt =
      decision.fixPromptAvailable
        ? buildRuntimeFixPrompt({
            projectName: project.name,
            version: currentVersion?.version || activeDeployment?.version || null,
            recentError: decision.recentError,
            stage: decision.anomalyLayer === 'PUBLIC' ? '公网访问' : '运行检查',
          })
        : null;

    return {
      projectId: appId,
      environmentId: environment?.id ?? null,
      deploymentId: activeDeployment?.id ?? currentVersion?.deploymentId ?? null,
      serviceInstanceId: activeService?.id ?? null,
      version: currentVersion?.version || activeDeployment?.version || null,
      restoredFrom: /^恢复自\s+(.+)$/.exec(currentVersion?.commitMessage || '')?.[1] ?? null,
      visitUrl: visit.visitUrl,
      overallStatus: decision.overallStatus,
      overallLabel: decision.overallLabel,
      runtimeStatus: decision.runtimeStatus,
      runtimeHealth: activeService?.healthStatus ?? HealthStatus.UNKNOWN,
      publicStatus: decision.publicStatus,
      httpStatus: publicHttpStatus,
      gatewayStatus: route?.status ?? null,
      dnsStatus: domain?.dnsStatus ?? null,
      lastHealthCheckAt: activeService?.lastHealthCheckAt ?? null,
      lastHealthCheckLabel: relativeCheckLabelZh(activeService?.lastHealthCheckAt),
      lastPublicCheckAt,
      lastPublicCheckLabel: relativeCheckLabelZh(lastPublicCheckAt),
      lastHealthyAt:
        activeService?.healthStatus === HealthStatus.HEALTHY
          ? activeService.lastHealthCheckAt
          : (activeService?.healthChecks || []).find((item) => item.status === HealthStatus.HEALTHY)
              ?.checkedAt ?? null,
      responseTimeMs: activeService?.responseTimeMs ?? null,
      publicLatencyMs,
      stale: decision.stale,
      startedAt,
      uptimeLabel: uptimeLabelZh(startedAt),
      startupSummary,
      recentError: decision.recentError,
      failureCategory: decision.failureCategory,
      recommendedAction: decision.recommendedAction,
      fixPrompt,
      anomalyLayer: decision.anomalyLayer,
      // Backward-compatible AppHealth fields:
      status: activeService?.healthStatus ?? HealthStatus.UNKNOWN,
      lastCheckedAt: activeService?.lastHealthCheckAt ?? null,
      message:
        decision.recentError ||
        activeService?.healthMessage ||
        (decision.overallStatus === 'HEALTHY' ? '运行正常' : decision.overallLabel),
      history: activeService?.healthChecks ?? [],
    };
  }

  async redeploy(userId: string, appId: string, deployableUnitId?: string) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, appId);
    this.workspaceAccess.requireWriteAccess(membership.role);
    await this.assertNotDeploying(appId, deployableUnitId);

    if (deployableUnitId) {
      const unit = await this.prisma.deployableUnit.findFirst({
        where: { id: deployableUnitId, projectId: appId },
      });
      if (!unit) {
        throw new BadRequestException('未找到该可上线内容');
      }
      if (!unit.deployable) {
        throw new BadRequestException('当前版本暂不支持上线这一部分。');
      }
    }

    const latest = await this.prisma.deployment.findFirst({
      where: {
        projectId: appId,
        ...(deployableUnitId ? { deployableUnitId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      select: {
        environmentId: true,
        serverInstanceId: true,
        deployableUnitId: true,
        serverInstance: { select: { scope: true } },
      },
    });
    const environmentId =
      latest?.environmentId ??
      (
        await this.prisma.projectEnvironment.findFirst({
          where: { projectId: appId },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        })
      )?.id;

    if (!environmentId) {
      throw new BadRequestException('请先完成一次上线准备。');
    }

    await this.prisma.pendingCodeUpdate.updateMany({
      where: { projectId: appId, status: CodeUpdateStatus.PENDING },
      data: { status: CodeUpdateStatus.CONFIRMED },
    });

    const ownedServer = latest?.serverInstance?.scope === 'WORKSPACE_OWNED';
    const serverInstanceId = ownedServer ? latest?.serverInstanceId ?? undefined : undefined;
    return this.deployments.create(userId, appId, {
      environmentId,
      hostingMode: ownedServer ? 'my-server' : 'launchos',
      serverInstanceId,
      deployableUnitId: deployableUnitId || latest?.deployableUnitId || undefined,
    });
  }

  async rollback(userId: string, appId: string, versionId: string) {
    return this.deployments.rollback(userId, appId, versionId);
  }

  async rollbackEnvironment(userId: string, appId: string, environmentId: string) {
    return this.deployments.rollbackEnvironment(userId, appId, environmentId);
  }

  async versions(userId: string, appId: string) {
    await this.workspaceAccess.requireProjectAccess(userId, appId);
    const versions = await this.prisma.applicationVersion.findMany({
      where: { projectId: appId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        projectId: true,
        deploymentId: true,
        deployableUnitId: true,
        version: true,
        commitSha: true,
        commitMessage: true,
        status: true,
        createdAt: true,
        deployableUnit: {
          select: { id: true, name: true, type: true },
        },
        deployment: {
          select: {
            status: true,
            sourceArtifactId: true,
            artifacts: {
              where: {
                type: ArtifactType.BUILD_OUTPUT,
                status: ArtifactStatus.READY,
              },
              take: 1,
              select: { id: true },
            },
          },
        },
      },
    });
    const currentByUnit = new Map<string, string>();
    for (const item of versions) {
      const key = item.deployableUnitId || '__root__';
      if (item.status === ApplicationVersionStatus.ACTIVE && !currentByUnit.has(key)) {
        currentByUnit.set(key, item.id);
      }
    }
    return versions.map((item) => {
      const isCurrent = currentByUnit.get(item.deployableUnitId || '__root__') === item.id;
      const hasArtifact = Boolean(
        item.deployment?.sourceArtifactId || item.deployment?.artifacts?.[0]?.id,
      );
      const deploymentOk = item.deployment?.status === DeploymentStatus.SUCCESS;
      const statusOk =
        item.status !== ApplicationVersionStatus.FAILED &&
        item.status !== ApplicationVersionStatus.DEPLOYING;
      return {
        id: item.id,
        projectId: item.projectId,
        deploymentId: item.deploymentId,
        deployableUnitId: item.deployableUnitId,
        version: item.version,
        commitSha: item.commitSha,
        commitMessage: item.commitMessage,
        status: item.status,
        createdAt: item.createdAt,
        unitName: item.deployableUnit?.name ?? null,
        unitType: item.deployableUnit?.type ?? null,
        isCurrent,
        rollbackable: Boolean(!isCurrent && statusOk && deploymentOk && hasArtifact),
        restoredFrom: /^恢复自\s+(.+)$/.exec(item.commitMessage || '')?.[1] ?? null,
      };
    });
  }

  async issues(userId: string, appId: string) {
    await this.workspaceAccess.requireProjectAccess(userId, appId);
    const diagnoses = await this.prisma.deploymentDiagnosis.findMany({
      where: { deployment: { projectId: appId } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        category: true,
        severity: true,
        title: true,
        description: true,
        solution: true,
        fixPrompt: true,
        createdAt: true,
        deployment: {
          select: {
            deployableUnitId: true,
            deployableUnit: { select: { id: true, name: true, type: true } },
          },
        },
      },
    });

    return diagnoses.map((item) => toIssue(item));
  }

  async getSettings(userId: string, appId: string) {
    const { project } = await this.workspaceAccess.requireProjectAccess(userId, appId);
    const source = await this.prisma.sourceRepository.findFirst({
      where: { projectId: appId },
      orderBy: { createdAt: 'desc' },
      select: { branch: true },
    });
    const pending = await this.prisma.pendingCodeUpdate.findFirst({
      where: { projectId: appId, status: CodeUpdateStatus.PENDING },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        commitSha: true,
        commitMessage: true,
        createdAt: true,
      },
    });
    const detail = await this.prisma.project.findUniqueOrThrow({
      where: { id: project.id },
      select: { autoDeployEnabled: true, defaultBranch: true },
    });

    return {
      autoDeployEnabled: detail.autoDeployEnabled,
      branch: source?.branch || detail.defaultBranch || 'main',
      pendingUpdate: pending,
    };
  }

  async updateSettings(userId: string, appId: string, dto: UpdateAppSettingsDto) {
    const { membership, project } = await this.workspaceAccess.requireProjectAccess(userId, appId);
    this.workspaceAccess.requireWriteAccess(membership.role);

    const branch = dto.branch?.trim();
    await this.prisma.$transaction(async (tx) => {
      await tx.project.update({
        where: { id: project.id },
        data: {
          autoDeployEnabled: dto.autoDeployEnabled ?? undefined,
          defaultBranch: branch || undefined,
        },
      });
      if (branch) {
        const source = await tx.sourceRepository.findFirst({
          where: { projectId: project.id },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        });
        if (source) {
          await tx.sourceRepository.update({
            where: { id: source.id },
            data: { branch },
          });
        }
      }
    });

    return this.getSettings(userId, appId);
  }

  private async runAction(
    userId: string,
    appId: string,
    action: 'start' | 'stop' | 'restart',
    deployableUnitId?: string,
  ) {
    const { membership, provider, service } = await this.requireManagedApp(
      userId,
      appId,
      true,
      deployableUnitId,
    );
    this.workspaceAccess.requireWriteAccess(membership.role);

    try {
      const status =
        action === 'start'
          ? await provider.startRuntime(service.containerId)
          : action === 'stop'
            ? await provider.stopRuntime(service.containerId)
            : await provider.restartRuntime(service.containerId);

      await this.prisma.serviceInstance.update({
        where: { id: service.id },
        data: {
          status: status.running ? ServiceStatus.RUNNING : ServiceStatus.STOPPED,
          port: status.port ?? service.port,
          externalPort: status.port ?? service.externalPort,
          healthStatus: HealthStatus.UNKNOWN,
          healthMessage: status.running ? '等待下一次检测' : '应用已停止',
          responseTimeMs: null,
        },
      });
      await this.syncGatewayRoutesQuietly();
    } catch (error) {
      await this.prisma.serviceInstance.update({
        where: { id: service.id },
        data: {
          status: ServiceStatus.FAILED,
          healthStatus: HealthStatus.UNHEALTHY,
          healthMessage: actionMessage(action),
          responseTimeMs: null,
          lastHealthCheckAt: new Date(),
        },
      });
      await this.syncGatewayRoutesQuietly();
      throw toUserError(error, actionMessage(action));
    }

    return this.projects.getApp(userId, appId);
  }

  private async syncGatewayRoutesQuietly(): Promise<void> {
    try {
      const { SystemDomainService } = await import('@launchos/domain');
      await new SystemDomainService(this.prisma).syncGatewayRoutes();
    } catch {
      // Gateway may not be configured yet
    }
  }

  private async requireManagedApp(
    userId: string,
    appId: string,
    mutating: boolean,
    deployableUnitId?: string,
  ) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, appId);
    const service = await this.prisma.serviceInstance.findFirst({
      where: deployableUnitId
        ? { projectId: appId, deployableUnitId }
        : { projectId: appId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        containerId: true,
        port: true,
        externalPort: true,
        serverInstanceId: true,
        deployableUnitId: true,
        server: {
          select: {
            host: true,
            port: true,
            username: true,
            credentialEncrypted: true,
          },
        },
      },
    });

    if (!service?.containerId) {
      throw new BadRequestException('这个内容还没有上线，先完成一次上线后再管理。');
    }

    const containerId = service.containerId;

    if (mutating) {
      await this.assertNotDeploying(appId, deployableUnitId);
    }

    return {
      membership,
      service: { ...service, containerId },
      provider: this.createProvider(service),
    };
  }

  private async assertNotDeploying(appId: string, deployableUnitId?: string): Promise<void> {
    const latest = await this.prisma.deployment.findFirst({
      where: {
        projectId: appId,
        ...(deployableUnitId ? { deployableUnitId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      select: { status: true },
    });
    if (
      latest &&
      (latest.status === DeploymentStatus.CREATED ||
        latest.status === DeploymentStatus.QUEUED ||
        latest.status === DeploymentStatus.RUNNING)
    ) {
      throw new BadRequestException('该组成正在上线，请等待当前任务完成。');
    }
  }

  private createProvider(service: {
    serverInstanceId: string | null;
    server: {
      host: string;
      port: number;
      username: string;
      credentialEncrypted: string;
    } | null;
  }): RuntimeProvider {
    if (!service.serverInstanceId) {
      return createRuntimeProvider('local');
    }
    if (!service.server) {
      throw new BadRequestException('绑定的服务器不可用，请重新上线。');
    }
    return createRuntimeProvider('remote', {
      host: service.server.host,
      port: service.server.port,
      username: service.server.username,
      password: decryptCredential(service.server.credentialEncrypted),
    });
  }
}

function uptimeLabelZh(startedAt: Date | string | null | undefined): string | null {
  if (!startedAt) return null;
  const t = startedAt instanceof Date ? startedAt.getTime() : Date.parse(String(startedAt));
  if (!Number.isFinite(t)) return null;
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return `${sec} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

function buildStartupSummary(input: {
  serviceStatus?: string | null;
  healthStatus?: string | null;
  healthMessage?: string | null;
  startedAt?: Date | string | null;
  deployment?: {
    status: string;
    finishedAt?: Date | string | null;
    errorMessage?: string | null;
  } | null;
}): {
  result: 'SUCCESS' | 'FAILED' | 'UNKNOWN';
  label: string;
  at: string | null;
  errorSummary: string | null;
} {
  const status = String(input.serviceStatus || '').toUpperCase();
  const health = String(input.healthStatus || '').toUpperCase();
  if (status === 'RUNNING' && health === 'HEALTHY') {
    return {
      result: 'SUCCESS',
      label: '应用启动成功',
      at: input.startedAt ? new Date(input.startedAt).toISOString() : null,
      errorSummary: null,
    };
  }
  if (status === 'FAILED' || health === 'UNHEALTHY') {
    return {
      result: 'FAILED',
      label: '应用启动失败',
      at: input.startedAt ? new Date(input.startedAt).toISOString() : null,
      errorSummary: input.healthMessage || input.deployment?.errorMessage || '启动未通过检查',
    };
  }
  if (status === 'STOPPED') {
    return {
      result: 'SUCCESS',
      label: '应用已停止',
      at: input.startedAt ? new Date(input.startedAt).toISOString() : null,
      errorSummary: null,
    };
  }
  return {
    result: 'UNKNOWN',
    label: '等待确认启动结果',
    at: null,
    errorSummary: null,
  };
}

function actionMessage(action: 'start' | 'stop' | 'restart'): string {
  if (action === 'start') {
    return '暂时无法启动应用';
  }
  if (action === 'stop') {
    return '暂时无法停止应用';
  }
  return '暂时无法重启应用';
}

function toUserError(error: unknown, fallback: string): BadRequestException {
  if (error instanceof BadRequestException) {
    return error;
  }
  if (error instanceof RuntimeError) {
    return new BadRequestException(fallback);
  }
  return new BadRequestException(fallback);
}

function toIssue(diagnosis: {
  id: string;
  category: string;
  severity: string;
  title: string;
  description: string;
  solution: string;
  fixPrompt: string;
  createdAt: Date;
  deployment?: {
    deployableUnitId: string | null;
    deployableUnit: { id: string; name: string; type: string } | null;
  };
}) {
  const mapped = ISSUE_BY_CATEGORY[diagnosis.category] ?? DEFAULT_ISSUE;
  const unitName = diagnosis.deployment?.deployableUnit?.name || null;
  const unitContext = unitName
    ? `问题发生在「${unitName}」，而不是整个应用。`
    : '问题发生在当前应用的上线流程中。';
  return {
    id: diagnosis.id,
    title: mapped.title,
    severity: diagnosis.severity,
    discoveredAt: diagnosis.createdAt,
    cause: mapped.cause,
    suggestion: mapped.suggestion,
    deployableUnitId: diagnosis.deployment?.deployableUnitId ?? null,
    unitName,
    unitType: diagnosis.deployment?.deployableUnit?.type ?? null,
    assistantPrompt:
      diagnosis.fixPrompt ||
      [
        '请帮我排查这个应用上线失败的原因，并给出修改建议。不要直接改代码，也不要提交。',
        unitContext,
        `问题：${mapped.title}`,
        `原因：${mapped.cause}`,
        `建议：${mapped.suggestion}`,
      ].join('\n'),
  };
}

const DEFAULT_ISSUE = {
  title: '上线未成功',
  cause: '这次上线没有完成。',
  suggestion: '可以把问题复制给开发助手帮忙查看。',
};

const ISSUE_BY_CATEGORY: Record<string, { title: string; cause: string; suggestion: string }> = {
  DEPENDENCY_ERROR: {
    title: '缺少依赖',
    cause: '应用缺少必要的代码依赖。',
    suggestion: '请补齐依赖后再重新上线。',
  },
  CONFIG_ERROR: {
    title: '数据库连接失败',
    cause: 'DATABASE_URL 未配置',
    suggestion: '检查环境变量',
  },
  DATABASE_ERROR: {
    title: '数据库连接失败',
    cause: 'DATABASE_URL 未配置',
    suggestion: '检查环境变量',
  },
  PORT_ERROR: {
    title: '端口被占用',
    cause: '应用启动时端口被占用。',
    suggestion: '请换一个端口，或关掉占用端口的程序后再上线。',
  },
  RUNTIME_ERROR: {
    title: '应用启动失败',
    cause: '应用启动后意外退出。',
    suggestion: '请检查启动方式和代码后重新上线。',
  },
  BUILD_ERROR: {
    title: '构建失败',
    cause: '应用构建没有通过。',
    suggestion: '请先在本地确认代码能正常构建，再重新上线。',
  },
  UNKNOWN: DEFAULT_ISSUE,
};
