import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  ApplicationVersionStatus,
  ArtifactStatus,
  ArtifactType,
  CloudResourceStatus,
  CloudResourceType,
  DeployableUnitStatus,
  DeploymentStatus,
  DeploymentStepStatus,
  RemoteDeploymentStatus,
  HealthStatus,
  ServiceStatus,
  ApplicationDomainType,
  WorkspaceRole,
} from '@launchos/database';
import { isMobileFramework, isWebDeployableFramework } from '@launchos/analyzer';
import { DeploymentEngineService } from '@launchos/deployment';
import { toVisitUrls, readSystemDomainZone } from '@launchos/domain';
import { DEFAULT_DEPLOYMENT_MAX_RETRY } from '@launchos/shared';
import {
  evaluateManagedServerForDeploy,
  formatReadableReleaseLabel,
  managedAccessEntryPendingMessage,
  planRollbackTarget,
  resolveDeploymentTargetType,
  requirementKeysForDependencyType,
  deploymentRequestIdempotencyKey,
  DEPLOYMENT_FAILURE_USER_MESSAGES,
  type DeploymentFailureCode,
} from '@launchos/shared';
import { AnalysesService } from '../analyses/analyses.service';
import { PrismaService } from '../database/prisma.service';
import { DeploymentQueueService } from '../queue/deployment-queue.service';
import {
  ManagedHostingSchedulerService,
  NO_MANAGED_HOST_AVAILABLE,
  NO_MANAGED_HOST_MESSAGE,
} from '../managed-hosting/managed-hosting-scheduler.service';
import { CapacityGovernanceService } from '../capacity/capacity-governance.service';
import { EntitlementGovernanceService } from '../billing/entitlement-governance.service';
import { WorkerPresenceService } from '../queue/worker-presence.service';
import {  RuntimeConfigService,
  toMissingConfigUserMessage,
} from '../runtime-config/runtime-config.service';
import { DependenciesService } from '../dependencies/dependencies.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import type { CreateDeploymentDto } from './dto/create-deployment.dto';
import {
  buildExperienceProgress,
  shortFailureCause,
} from './experience-steps';
import { experienceStageLabel } from './experience-stage';

const deploymentSelect = {
  id: true,
  projectId: true,
  environmentId: true,
  deployableUnitId: true,
  status: true,
  version: true,
  releaseLabel: true,
  sourceRevision: true,
  sourceArtifactId: true,
  startedAt: true,
  finishedAt: true,
  errorMessage: true,
  failureCode: true,
  currentStage: true,
  executionAttemptId: true,
  stageHistory: true,
  retryCount: true,
  maxRetry: true,
  bullmqJobId: true,
  lastActivityAt: true,
  queueStallCount: true,
  serverInstanceId: true,
  uploadStatus: true,
  uploadError: true,
  uploadStartedAt: true,
  uploadFinishedAt: true,
  createdAt: true,
  updatedAt: true,
  deployableUnit: {
    select: {
      id: true,
      name: true,
      type: true,
      framework: true,
      rootPath: true,
    },
  },
} as const;

const environmentSelect = {
  id: true,
  name: true,
  type: true,
} as const;

@Injectable()
export class DeploymentsService {
  private readonly logger = new Logger(DeploymentsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaceAccess: WorkspaceAccessService,
    private readonly engine: DeploymentEngineService,
    private readonly deploymentQueue: DeploymentQueueService,
    private readonly workerPresence: WorkerPresenceService,
    private readonly analyses: AnalysesService,
    private readonly runtimeConfig: RuntimeConfigService,
    private readonly dependencies: DependenciesService,
    private readonly managedHosting: ManagedHostingSchedulerService,
    private readonly capacity: CapacityGovernanceService,
    private readonly entitlements: EntitlementGovernanceService,
  ) {}

  async create(userId: string, projectId: string, dto: CreateDeploymentDto) {
    const { membership, project } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    this.workspaceAccess.requireWriteAccess(membership.role);
    await this.ensureWorkerOnline();

    const runningCount = await this.prisma.serviceInstance.count({
      where: { projectId, status: 'RUNNING' },
    });
    await this.entitlements.assertCanStartDeployment(userId, project.workspaceId, {
      projectId,
      isExistingRunningApp: runningCount > 0,
      kind: 'deploy',
    });

    // Beta M5 — capacity admission before any build/deploy work (platform managed only).
    const hostingModeEarly = dto.hostingMode ?? (dto.serverInstanceId?.trim() ? 'my-server' : 'launchos');
    if (hostingModeEarly !== 'my-server') {
      const { decision } = await this.capacity.admitManagedDeployment({ allowWait: true });
      if (decision.result === 'WORKER_UNAVAILABLE' || decision.result === 'REJECTED_CAPACITY') {
        this.capacity.assertAdmitted(decision);
      }
    }

    const environment = await this.prisma.projectEnvironment.findUnique({
      where: { id: dto.environmentId },
      select: { id: true, projectId: true },
    });

    if (!environment || environment.projectId !== projectId) {
      throw new NotFoundException('Environment not found');
    }

    const sourceCount = await this.prisma.sourceRepository.count({ where: { projectId } });
    if (sourceCount === 0) {
      throw new BadRequestException('请先连接代码');
    }

    const idempotencyKey = dto.idempotencyKey?.trim() || null;
    if (idempotencyKey) {
      const existing = await this.prisma.deployment.findFirst({
        where: {
          projectId,
          environmentId: environment.id,
          idempotencyKey: deploymentRequestIdempotencyKey({
            projectId,
            environmentId: environment.id,
            clientKey: idempotencyKey,
          }),
        },
        select: { id: true, status: true },
      });
      if (existing) {
        // Only short-circuit for in-flight or successful deployments. Terminal failures
        // must allow a fresh attempt (External Alpha confirm-retry / managed relaunch).
        if (
          existing.status !== DeploymentStatus.FAILED &&
          existing.status !== DeploymentStatus.CANCELLED
        ) {
          return this.getById(userId, existing.id);
        }
        // Free the unique idempotency key so a new deployment row can be created.
        await this.prisma.deployment.update({
          where: { id: existing.id },
          data: { idempotencyKey: null },
        });
      }
    }

    const activeEnvDeployment = await this.prisma.deployment.findFirst({
      where: {
        projectId,
        environmentId: environment.id,
        usageClass: 'REAL_EXECUTION',
        status: {
          in: [DeploymentStatus.CREATED, DeploymentStatus.QUEUED, DeploymentStatus.RUNNING],
        },
      },
      select: { id: true, status: true },
    });
    if (activeEnvDeployment) {
      throw new ConflictException({
        message: '该环境正在上线，请等待当前任务完成。',
        code: 'DEPLOYMENT_ALREADY_RUNNING',
        deploymentId: activeEnvDeployment.id,
      });
    }

    const hostingMode = dto.hostingMode ?? (dto.serverInstanceId?.trim() ? 'my-server' : 'launchos');
    let serverInstanceId: string | undefined;
    if (hostingMode === 'my-server') {
      if (!dto.serverInstanceId?.trim()) {
        throw new BadRequestException('请选择一台服务器');
      }
      const server = await this.prisma.serverInstance.findFirst({
        where: {
          id: dto.serverInstanceId.trim(),
          workspaceId: membership.workspace.id,
          scope: 'WORKSPACE_OWNED',
        },
        select: { id: true, host: true, status: true, dockerStatus: true, provider: true, metadata: true },
      });
      if (!server) {
        throw new NotFoundException('服务器不存在');
      }
      const gate = evaluateManagedServerForDeploy(server);
      if (!gate.ok) {
        throw new BadRequestException({
          message: gate.blockers[0]?.message || '服务器尚未就绪，无法部署',
          code: gate.blockers[0]?.code || 'SERVER_NOT_READY',
          blockers: gate.blockers,
        });
      }
      serverInstanceId = server.id;
    } else {
      const previous = await this.prisma.deployment.findFirst({
        where: {
          projectId,
          serverInstance: { scope: 'PLATFORM_MANAGED' },
        },
        orderBy: { createdAt: 'desc' },
        select: { serverInstanceId: true },
      });
      const allocated = await this.managedHosting.allocate(previous?.serverInstanceId ?? undefined);
      if ('code' in allocated) {
        this.logger.warn(NO_MANAGED_HOST_AVAILABLE);
        throw new BadRequestException({
          message: NO_MANAGED_HOST_MESSAGE,
          code: NO_MANAGED_HOST_AVAILABLE,
        });
      }
      const server = await this.prisma.serverInstance.findFirst({
        where: { id: allocated.serverInstanceId, scope: 'PLATFORM_MANAGED' },
        select: { id: true, host: true, status: true, dockerStatus: true, provider: true, metadata: true },
      });
      const gate = evaluateManagedServerForDeploy(server);
      if (!gate.ok || !server) {
        this.logger.warn(NO_MANAGED_HOST_AVAILABLE);
        throw new BadRequestException({
          message: NO_MANAGED_HOST_MESSAGE,
          code: NO_MANAGED_HOST_AVAILABLE,
          blockers: gate.blockers,
        });
      }
      serverInstanceId = server.id;
    }

    const targetType = resolveDeploymentTargetType({
      explicit: dto.targetType,
      hostingMode,
      serverInstanceId,
    });

    if (targetType === 'MANAGED_SERVER' && !serverInstanceId?.trim()) {
      throw new BadRequestException({
        message: '托管部署未绑定服务器，已拒绝本地回退。',
        code: 'MANAGED_SERVER_NOT_BOUND',
      });
    }

    let sourceArtifactId: string | undefined;
    let deployableArtifactId: string | undefined;
    if (dto.selectedArtifactId?.trim()) {
      const selected = await this.prisma.artifact.findFirst({
        where: {
          id: dto.selectedArtifactId.trim(),
          type: ArtifactType.BUILD_OUTPUT,
          status: ArtifactStatus.READY,
          deployment: { projectId },
        },
        select: { id: true },
      });
      if (!selected) {
        throw new BadRequestException({
          message: '指定的应用制品不可用',
          code: 'ARTIFACT_NOT_READY',
        });
      }
      sourceArtifactId = selected.id;

      if (targetType === 'MANAGED_SERVER') {
        const image = await this.prisma.artifact.findFirst({
          where: {
            type: ArtifactType.DOCKER_IMAGE,
            status: ArtifactStatus.READY,
            size: { gt: 0 },
            deployment: { projectId },
          },
          orderBy: { createdAt: 'desc' },
          select: { id: true, metadata: true },
        });
        const meta = image?.metadata;
        if (
          image &&
          meta &&
          typeof meta === 'object' &&
          !Array.isArray(meta) &&
          (meta as { sourceArtifactId?: string }).sourceArtifactId === sourceArtifactId
        ) {
          deployableArtifactId = image.id;
        }
      }
    }

    const analysisPayload = await this.analyses.analyzeCode(userId, projectId);
    let deployableUnitId: string | undefined = dto.deployableUnitId?.trim() || undefined;

    if (deployableUnitId) {
      const unit = await this.prisma.deployableUnit.findFirst({
        where: { id: deployableUnitId, projectId },
      });
      if (!unit) {
        throw new NotFoundException('未找到该可上线内容');
      }
      if (!unit.deployable || unit.status === DeployableUnitStatus.UNSUPPORTED) {
        throw new BadRequestException('当前版本暂不支持上线这一部分。');
      }
      await this.prisma.project.update({
        where: { id: projectId },
        data: { selectedDeployableUnitId: unit.id },
      });
    } else {
      const units = await this.prisma.deployableUnit.findMany({
        where: {
          projectId,
          status: { not: DeployableUnitStatus.IGNORED },
        },
        orderBy: [{ deployable: 'desc' }, { confidence: 'desc' }],
      });
      const launchable = units.filter((unit) => unit.deployable);
      if (units.length > 1 && launchable.length > 1) {
        throw new BadRequestException('发现多个可上线内容，请先选择要上线的部分。');
      }
      if (launchable.length === 1) {
        deployableUnitId = launchable[0]!.id;
      } else {
        const framework =
          analysisPayload.result?.framework ?? analysisPayload.analysis?.framework;
        if (isMobileFramework(framework)) {
          throw new BadRequestException(
            '当前项目属于暂不支持的原生 iOS / 移动应用，无法使用服务器部署流程。',
          );
        }
        if (!isWebDeployableFramework(framework)) {
          this.logger.warn('PROJECT_NOT_DEPLOYABLE');
          throw new BadRequestException('当前版本暂不支持自动上线这种技术类型。');
        }
      }
    }

    if (deployableUnitId) {
      const activeDeployment = await this.prisma.deployment.findFirst({
        where: {
          projectId,
          deployableUnitId,
          status: {
            in: [
              DeploymentStatus.CREATED,
              DeploymentStatus.QUEUED,
              DeploymentStatus.RUNNING,
            ],
          },
        },
        select: { id: true },
      });
      if (activeDeployment) {
        throw new ConflictException({
          message: '该组成正在上线，请等待当前任务完成。',
          code: 'DEPLOYMENT_ALREADY_RUNNING',
          deploymentId: activeDeployment.id,
        });
      }
    }

    if (deployableUnitId) {
      await this.runtimeConfig.scanAndPersist(
        projectId,
        deployableUnitId,
        (
          await this.prisma.deployableUnit.findUniqueOrThrow({
            where: { id: deployableUnitId },
            select: { rootPath: true },
          })
        ).rootPath,
      );
      const missing = await this.runtimeConfig.getMissingRequired(projectId, deployableUnitId);
      const dependencyKeys = new Set([
        ...requirementKeysForDependencyType('POSTGRESQL'),
        ...requirementKeysForDependencyType('REDIS'),
      ]);
      const nonDependencyMissing = missing.filter((item) => !dependencyKeys.has(item.key));
      if (nonDependencyMissing.length > 0) {
        throw new BadRequestException({
          message: toMissingConfigUserMessage(nonDependencyMissing),
          code: 'RUNTIME_CONFIG_MISSING',
          missing: nonDependencyMissing.map((item) => ({
            key: item.key,
            label: item.label,
          })),
          configPath: `/projects/${projectId}/units/${deployableUnitId}/config`,
        });
      }
      const depValidation = await this.dependencies.validateBeforeDeploy(
        projectId,
        deployableUnitId,
      );
      if (!depValidation.ready) {
        throw new BadRequestException({
          message:
            depValidation.blockers[0]?.userMessage ||
            '应用依赖尚未就绪，请完成后再上线。',
          code: 'DEPENDENCY_NOT_READY',
          blockers: depValidation.blockers,
          dependenciesPath: `/projects/${projectId}/dependencies`,
        });
      }
    }

    const count = await this.prisma.deployment.count({ where: { projectId } });
    const maxRetry = readMaxRetry();
    const now = new Date();
    const storedIdempotencyKey = idempotencyKey
      ? deploymentRequestIdempotencyKey({
          projectId,
          environmentId: environment.id,
          clientKey: idempotencyKey,
        })
      : null;
    const created = await this.prisma.deployment.create({
      data: {
        projectId,
        environmentId: environment.id,
        deployableUnitId: deployableUnitId ?? null,
        status: DeploymentStatus.CREATED,
        version: `v${count + 1}`,
        releaseLabel: formatReadableReleaseLabel({ createdAt: now, sequence: count + 1 }),
        executionAttemptId: randomUUID(),
        idempotencyKey: storedIdempotencyKey,
        currentStage: 'QUEUED',
        retryCount: 0,
        maxRetry,
        serverInstanceId: serverInstanceId ?? null,
        targetType,
        sourceArtifactId: sourceArtifactId ?? null,
        deployableArtifactId: deployableArtifactId ?? null,
      },
      select: {
        id: true,
        version: true,
        releaseLabel: true,
        serverInstanceId: true,
        targetType: true,
        sourceArtifactId: true,
        deployableArtifactId: true,
        executionAttemptId: true,
      },
    });

    if (targetType === 'MANAGED_SERVER' && !created.serverInstanceId) {
      // Belt-and-suspenders: never enqueue a managed deploy without bound server.
      await this.prisma.deployment.update({
        where: { id: created.id },
        data: {
          status: DeploymentStatus.FAILED,
          finishedAt: new Date(),
          errorMessage: 'MANAGED_SERVER_NOT_BOUND',
        },
      });
      throw new BadRequestException({
        message: '托管部署未绑定服务器，已拒绝本地回退。',
        code: 'MANAGED_SERVER_NOT_BOUND',
      });
    }

    await this.prisma.applicationVersion.create({
      data: {
        projectId,
        deploymentId: created.id,
        deployableUnitId: deployableUnitId ?? null,
        version: created.version ?? `v${count + 1}`,
        commitSha: '',
        commitMessage: '',
        status: ApplicationVersionStatus.DEPLOYING,
      },
    });

    await this.engine.createPendingSteps(created.id);
    await this.engine.enqueue(created.id);
    await this.prisma.deploymentLog.create({
      data: {
        deploymentId: created.id,
        level: 'info',
        message: 'Deployment created and queued',
      },
    });
    const jobId = await this.deploymentQueue.enqueue(created.id, maxRetry);
    await this.prisma.deployment.update({
      where: { id: created.id },
      data: { bullmqJobId: jobId, lastActivityAt: new Date() },
    });

    return this.getById(userId, created.id);
  }

  /**
   * Step 28 — rollback environment to previous successful deployment (artifact reuse, no rebuild).
   */
  async rollbackEnvironment(userId: string, projectId: string, environmentId: string) {
    const { membership, project } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    this.workspaceAccess.requireWriteAccess(membership.role);
    await this.ensureWorkerOnline();
    await this.entitlements.assertCanStartDeployment(userId, project.workspaceId, {
      projectId,
      isExistingRunningApp: true,
      kind: 'rollback',
    });

    const environment = await this.prisma.projectEnvironment.findFirst({
      where: { id: environmentId, projectId },
      select: {
        id: true,
        activeDeploymentId: true,
        previousDeploymentId: true,
      },
    });
    if (!environment) {
      throw new NotFoundException('环境不存在');
    }

    const planned = planRollbackTarget({
      activeDeploymentId: environment.activeDeploymentId,
      previousDeploymentId: environment.previousDeploymentId,
    });
    if (!planned.ok) {
      throw new BadRequestException({ message: planned.message, code: planned.code });
    }

    const activeRunning = await this.prisma.deployment.findFirst({
      where: {
        projectId,
        environmentId,
        status: {
          in: [DeploymentStatus.CREATED, DeploymentStatus.QUEUED, DeploymentStatus.RUNNING],
        },
      },
      select: { id: true },
    });
    if (activeRunning) {
      throw new ConflictException({
        message: '该环境正在上线，请等待当前任务完成。',
        code: 'DEPLOYMENT_ALREADY_RUNNING',
        deploymentId: activeRunning.id,
      });
    }

    const target = await this.prisma.deployment.findFirst({
      where: {
        id: planned.toDeploymentId,
        projectId,
        environmentId,
        status: DeploymentStatus.SUCCESS,
      },
      select: {
        id: true,
        serverInstanceId: true,
        deployableUnitId: true,
        sourceArtifactId: true,
        deployableArtifactId: true,
        sourceRevision: true,
        artifacts: {
          where: {
            type: ArtifactType.BUILD_OUTPUT,
            status: ArtifactStatus.READY,
          },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true },
        },
      },
    });
    if (!target) {
      throw new BadRequestException({
        message: '回滚目标不是成功版本，已取消回滚。',
        code: 'ROLLBACK_TARGET_INVALID',
      });
    }
    const artifactId = target.sourceArtifactId || target.artifacts[0]?.id;
    if (!artifactId) {
      throw new BadRequestException({
        message: '回滚目标没有可用制品，已取消回滚。',
        code: 'ROLLBACK_ARTIFACT_MISSING',
      });
    }

    const count = await this.prisma.deployment.count({ where: { projectId } });
    const maxRetry = readMaxRetry();
    const now = new Date();
    const created = await this.prisma.deployment.create({
      data: {
        projectId,
        environmentId,
        deployableUnitId: target.deployableUnitId,
        status: DeploymentStatus.CREATED,
        version: `v${count + 1}`,
        releaseLabel: formatReadableReleaseLabel({ createdAt: now, sequence: count + 1 }),
        executionAttemptId: randomUUID(),
        currentStage: 'QUEUED',
        sourceRevision: target.sourceRevision,
        retryCount: 0,
        maxRetry,
        serverInstanceId: target.serverInstanceId,
        sourceArtifactId: artifactId,
        deployableArtifactId: target.deployableArtifactId,
        targetType: target.serverInstanceId ? 'MANAGED_SERVER' : 'LOCAL',
      },
      select: { id: true },
    });

    await this.prisma.deploymentLog.create({
      data: {
        deploymentId: created.id,
        level: 'info',
        message: `ROLLBACK_STARTED from=${environment.activeDeploymentId || '-'} to=${target.id}`,
      },
    }).catch(() => undefined);

    const sourceVersion = await this.prisma.applicationVersion.findFirst({
      where: { deploymentId: target.id },
      select: { version: true, commitSha: true, commitMessage: true, deployableUnitId: true },
    });
    const restoredFrom = sourceVersion?.version || target.id.slice(0, 8);
    await this.prisma.applicationVersion.create({
      data: {
        projectId,
        deploymentId: created.id,
        deployableUnitId: target.deployableUnitId ?? sourceVersion?.deployableUnitId ?? null,
        version: `v${count + 1}`,
        commitSha: sourceVersion?.commitSha || target.sourceRevision || '',
        commitMessage: `恢复自 ${restoredFrom}`,
        status: ApplicationVersionStatus.DEPLOYING,
      },
    }).catch(() => undefined);

    await this.engine.createPendingSteps(created.id);
    await this.engine.enqueue(created.id);
    const jobId = await this.deploymentQueue.enqueue(created.id, maxRetry);
    await this.prisma.deployment.update({
      where: { id: created.id },
      data: {
        status: DeploymentStatus.QUEUED,
        bullmqJobId: jobId,
        lastActivityAt: new Date(),
      },
    });

    return {
      ...(await this.getById(userId, created.id)),
      rollback: {
        fromDeploymentId: environment.activeDeploymentId,
        toDeploymentId: target.id,
        status: 'ROLLBACK_STARTED',
      },
    };
  }

  async rollback(userId: string, projectId: string, versionId: string) {
    const { membership, project } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    this.workspaceAccess.requireWriteAccess(membership.role);
    await this.ensureWorkerOnline();
    await this.entitlements.assertCanStartDeployment(userId, project.workspaceId, {
      projectId,
      isExistingRunningApp: true,
      kind: 'rollback',
    });

    const version = await this.prisma.applicationVersion.findFirst({
      where: { id: versionId, projectId },
      select: {
        id: true,
        status: true,
        commitSha: true,
        commitMessage: true,
        version: true,
        deployableUnitId: true,
        deployment: {
          select: {
            id: true,
            status: true,
            environmentId: true,
            serverInstanceId: true,
            deployableUnitId: true,
            sourceArtifactId: true,
            deployableArtifactId: true,
            sourceRevision: true,
            version: true,
            artifacts: {
              where: {
                type: ArtifactType.BUILD_OUTPUT,
                status: ArtifactStatus.READY,
              },
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { id: true },
            },
          },
        },
      },
    });

    if (!version) {
      throw new NotFoundException('版本不存在');
    }
    if (version.status === ApplicationVersionStatus.DEPLOYING) {
      throw new BadRequestException('该版本还在上线中，请稍后再试。');
    }
    if (version.status === ApplicationVersionStatus.FAILED) {
      throw new BadRequestException('失败的版本不能恢复。');
    }
    if (version.deployment.status !== DeploymentStatus.SUCCESS) {
      throw new BadRequestException({
        message: '只有历史上线成功的版本可以恢复。',
        code: 'ROLLBACK_TARGET_INVALID',
      });
    }

    const currentActive = await this.prisma.applicationVersion.findFirst({
      where: {
        projectId,
        deployableUnitId: version.deployableUnitId ?? null,
        status: ApplicationVersionStatus.ACTIVE,
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (currentActive?.id === version.id) {
      throw new BadRequestException({
        message: '当前运行版本无需恢复。',
        code: 'ROLLBACK_TARGET_INVALID',
      });
    }

    const artifactId = version.deployment.sourceArtifactId || version.deployment.artifacts[0]?.id;
    if (!artifactId) {
      throw new BadRequestException({
        message: '这个版本没有可复用的上线包，无法恢复。',
        code: 'ROLLBACK_ARTIFACT_MISSING',
      });
    }

    const deployableUnitId =
      version.deployment.deployableUnitId || version.deployableUnitId || null;
    const environmentId = version.deployment.environmentId;

    const activeRunning = await this.prisma.deployment.findFirst({
      where: {
        projectId,
        environmentId,
        status: {
          in: [DeploymentStatus.CREATED, DeploymentStatus.QUEUED, DeploymentStatus.RUNNING],
        },
      },
      select: { id: true },
    });
    if (activeRunning) {
      throw new ConflictException({
        message: '当前有上线任务正在进行，请稍后再试。',
        code: 'DEPLOYMENT_ALREADY_RUNNING',
        deploymentId: activeRunning.id,
      });
    }

    if (deployableUnitId) {
      const missing = await this.runtimeConfig.getMissingRequired(projectId, deployableUnitId);
      const dependencyKeys = new Set([
        ...requirementKeysForDependencyType('POSTGRESQL'),
        ...requirementKeysForDependencyType('REDIS'),
      ]);
      const nonDependencyMissing = missing.filter((item) => !dependencyKeys.has(item.key));
      if (nonDependencyMissing.length > 0) {
        throw new BadRequestException({
          message: `恢复该版本前还需要补充运行配置：${nonDependencyMissing
            .map((item) => item.label || item.key)
            .join('、')}`,
          code: 'RUNTIME_CONFIG_MISSING',
          missing: nonDependencyMissing.map((item) => ({
            key: item.key,
            label: item.label,
          })),
          configPath: `/projects/${projectId}/units/${deployableUnitId}/config`,
        });
      }
      const depValidation = await this.dependencies.validateBeforeDeploy(
        projectId,
        deployableUnitId,
      );
      if (!depValidation.ready) {
        throw new BadRequestException({
          message:
            depValidation.blockers[0]?.userMessage ||
            '恢复该版本前还需要补充运行配置。',
          code: 'DEPENDENCY_NOT_READY',
          blockers: depValidation.blockers,
          dependenciesPath: `/projects/${projectId}/dependencies`,
        });
      }
    }

    const count = await this.prisma.deployment.count({ where: { projectId } });
    const maxRetry = readMaxRetry();
    const now = new Date();
    const nextVersion = `v${count + 1}`;
    const restoredFrom = version.version || version.deployment.version || '历史版本';
    const created = await this.prisma.deployment.create({
      data: {
        projectId,
        environmentId,
        deployableUnitId,
        status: DeploymentStatus.CREATED,
        version: nextVersion,
        releaseLabel: formatReadableReleaseLabel({ createdAt: now, sequence: count + 1 }),
        executionAttemptId: randomUUID(),
        currentStage: 'QUEUED',
        sourceRevision: version.commitSha || version.deployment.sourceRevision || null,
        retryCount: 0,
        maxRetry,
        serverInstanceId: version.deployment.serverInstanceId,
        sourceArtifactId: artifactId,
        deployableArtifactId: version.deployment.deployableArtifactId,
        targetType: version.deployment.serverInstanceId ? 'MANAGED_SERVER' : 'LOCAL',
      },
      select: { id: true, version: true },
    });

    await this.prisma.applicationVersion.create({
      data: {
        projectId,
        deploymentId: created.id,
        deployableUnitId,
        version: created.version ?? nextVersion,
        commitSha: version.commitSha,
        commitMessage: `恢复自 ${restoredFrom}`,
        status: ApplicationVersionStatus.DEPLOYING,
      },
    });

    await this.prisma.deploymentLog.create({
      data: {
        deploymentId: created.id,
        level: 'info',
        message: `ROLLBACK_STARTED fromVersion=${restoredFrom} sourceDeployment=${version.deployment.id} artifact=${artifactId}`,
      },
    }).catch(() => undefined);

    await this.engine.createPendingSteps(created.id);
    await this.engine.enqueue(created.id);
    const jobId = await this.deploymentQueue.enqueue(created.id, maxRetry);
    await this.prisma.deployment.update({
      where: { id: created.id },
      data: {
        status: DeploymentStatus.QUEUED,
        bullmqJobId: jobId,
        lastActivityAt: new Date(),
      },
    });

    return {
      ...(await this.getById(userId, created.id)),
      rollback: {
        fromVersionId: version.id,
        fromVersion: restoredFrom,
        fromDeploymentId: version.deployment.id,
        toDeploymentId: created.id,
        status: 'ROLLBACK_STARTED',
      },
    };
  }

  async listByProject(userId: string, projectId: string) {
    await this.workspaceAccess.requireProjectAccess(userId, projectId);

    return this.prisma.deployment.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: {
        ...deploymentSelect,
        environment: { select: environmentSelect },
      },
    });
  }

  async getById(userId: string, deploymentId: string) {
    await this.workspaceAccess.requireDeploymentAccess(userId, deploymentId);

    const record = await this.prisma.deployment.findUniqueOrThrow({
      where: { id: deploymentId },
      select: {
        ...deploymentSelect,
        environment: { select: environmentSelect },
        serverInstance: {
          select: {
            id: true,
            name: true,
            host: true,
            port: true,
            status: true,
            dockerStatus: true,
            scope: true,
          },
        },
        steps: {
          orderBy: { order: 'asc' },
          select: {
            id: true,
            stepKey: true,
            name: true,
            status: true,
            order: true,
            attempt: true,
            startedAt: true,
            finishedAt: true,
            errorMessage: true,
            command: true,
            exitCode: true,
            duration: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        logs: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            stepId: true,
            level: true,
            message: true,
            createdAt: true,
          },
        },
      },
    });

    const service = await this.prisma.serviceInstance.findFirst({
      where: { artifact: { deploymentId } },
      orderBy: { createdAt: 'desc' },
      select: {
        status: true,
        containerId: true,
        port: true,
        externalPort: true,
        internalPort: true,
        runtimeMode: true,
        server: { select: { name: true, host: true, scope: true } },
      },
    });

    const platform =
      record.serverInstance?.scope === 'PLATFORM_MANAGED' || service?.server?.scope === 'PLATFORM_MANAGED';
    const serverName = platform
      ? 'LaunchOS 自动托管'
      : service?.server?.name ?? record.serverInstance?.name ?? null;
    const safeRecord = platform
      ? {
          ...record,
          serverInstance: record.serverInstance
            ? { ...record.serverInstance, name: 'LaunchOS 自动托管', host: null, port: null }
            : null,
        }
      : record;
    return {
      ...safeRecord,
      runtime: {
        mode: record.serverInstanceId || service?.server ? 'remote' : 'local',
        serverName,
        serverHost: platform ? null : service?.server?.host ?? record.serverInstance?.host ?? null,
        containerStatus: service?.status ?? null,
        containerId: service?.containerId ?? null,
        externalPort: service?.externalPort ?? service?.port ?? null,
        internalPort: service?.internalPort ?? null,
      },
    };
  }

  async listArtifacts(userId: string, deploymentId: string) {
    await this.workspaceAccess.requireDeploymentAccess(userId, deploymentId);

    return this.prisma.artifact.findMany({
      where: { deploymentId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        deploymentId: true,
        type: true,
        storagePath: true,
        size: true,
        status: true,
        createdAt: true,
      },
    });
  }

  async getDiagnosis(userId: string, deploymentId: string) {
    await this.workspaceAccess.requireDeploymentAccess(userId, deploymentId);

    const diagnosis = await this.prisma.deploymentDiagnosis.findFirst({
      where: { deploymentId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        deploymentId: true,
        category: true,
        severity: true,
        title: true,
        description: true,
        solution: true,
        fixPrompt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return { diagnosis };
  }

  async cloudDeploy(userId: string, deploymentId: string) {
    const { membership } = await this.workspaceAccess.requireDeploymentAccess(userId, deploymentId);
    this.workspaceAccess.requireWriteAccess(membership.role);

    try {
      const prepared = await this.engine.prepareCloudDeploy(deploymentId);
      void this.engine.runRemoteDeployment(prepared.remoteDeploymentId).catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : 'Cloud deploy failed';
        console.error(`LaunchOS cloud deploy failed for ${deploymentId}: ${detail}`);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Cloud deploy failed';
      throw new BadRequestException(message);
    }

    return this.getRemoteStatus(userId, deploymentId);
  }

  async getExperience(userId: string, deploymentId: string) {
    await this.workspaceAccess.requireDeploymentAccess(userId, deploymentId);

    const [deployment, diagnosis, lastLog] = await Promise.all([
      this.prisma.deployment.findUniqueOrThrow({
        where: { id: deploymentId },
        select: {
          ...deploymentSelect,
          steps: {
            orderBy: [{ order: 'asc' }, { attempt: 'asc' }],
            select: {
              stepKey: true,
              status: true,
              attempt: true,
              startedAt: true,
              finishedAt: true,
              errorMessage: true,
            },
          },
          serverInstance: {
            select: { id: true, name: true, host: true, scope: true },
          },
          remoteDeployments: {
            orderBy: { startedAt: 'desc' },
            take: 1,
            select: {
              status: true,
              cloudResource: { select: { publicIp: true } },
            },
          },
          project: {
            select: {
              id: true,
              name: true,
              aiAnalyses: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true } },
              deploymentPlans: {
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: { runtime: true },
              },
              resourceRecommendations: {
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: { id: true },
              },
              cloudResources: {
                where: { type: CloudResourceType.SERVER },
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: {
                  publicIp: true,
                  status: true,
                  provider: { select: { name: true, type: true } },
                },
              },
              domains: {
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: { domain: true, status: true },
              },
              applicationDomains: {
                where: { type: ApplicationDomainType.SYSTEM },
                orderBy: { createdAt: 'desc' },
                take: 20,
                select: {
                  domain: true,
                  status: true,
                  sslStatus: true,
                  dnsStatus: true,
                  deployableUnitId: true,
                },
              },
              serviceInstances: {
                orderBy: { createdAt: 'desc' },
                take: 20,
                select: {
                  runtime: true,
                  runtimeMode: true,
                  status: true,
                  healthStatus: true,
                  port: true,
                  externalPort: true,
                  internalPort: true,
                  containerId: true,
                  deployableUnitId: true,
                  artifactId: true,
                  server: { select: { name: true, host: true } },
                },
              },
            },
          },
        },
      }),
      this.prisma.deploymentDiagnosis.findFirst({
        where: { deploymentId },
        orderBy: { createdAt: 'desc' },
        select: {
          category: true,
          title: true,
          description: true,
          solution: true,
          fixPrompt: true,
        },
      }),
      this.prisma.deploymentLog.findFirst({
        where: { deploymentId },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
    ]);

    const unitId = deployment.deployableUnitId;
    const unitServices = deployment.project.serviceInstances.filter((item) =>
      unitId ? item.deployableUnitId === unitId : true,
    );
    const unitDomains = deployment.project.applicationDomains.filter((item) =>
      unitId ? item.deployableUnitId === unitId || item.deployableUnitId == null : true,
    );
    const scopedDeployment = {
      ...deployment,
      project: {
        ...deployment.project,
        serviceInstances: unitServices.slice(0, 1),
        applicationDomains: unitDomains,
      },
    };

    const rollbackVersion = deployment.sourceArtifactId
      ? await this.prisma.applicationVersion.findFirst({
          where: { deploymentId },
          select: { commitMessage: true, version: true },
        })
      : null;
    const restoredFrom =
      /^恢复自\s+(.+)$/.exec(rollbackVersion?.commitMessage || '')?.[1] ?? null;
    const isRollback = Boolean(deployment.sourceArtifactId);

    const { steps, progress } = buildExperienceProgress({
      status: deployment.status,
      serverInstanceId: deployment.serverInstanceId,
      steps: deployment.steps,
      remoteDeployments: deployment.remoteDeployments,
      cloudResources: deployment.project.cloudResources,
      service: unitServices[0]
        ? {
            status: unitServices[0].status,
            healthStatus: unitServices[0].healthStatus,
          }
        : null,
      deployableUnit: deployment.deployableUnit,
      lastActivityAt: deployment.lastActivityAt ?? lastLog?.createdAt ?? deployment.updatedAt,
      isRollback,
    });

    const success = buildSuccessPayload(scopedDeployment);
    const hosting = hostingInfo(scopedDeployment);
    const userErrorBase =
      deployment.status === DeploymentStatus.FAILED
        ? toUserError(diagnosis, deployment.uploadError || deployment.errorMessage)
        : null;
    const failureCode = deployment.failureCode || null;
    const failureUserMessage =
      failureCode && failureCode in DEPLOYMENT_FAILURE_USER_MESSAGES
        ? DEPLOYMENT_FAILURE_USER_MESSAGES[failureCode as DeploymentFailureCode]
        : null;
    const userError = userErrorBase
      ? {
          ...userErrorBase,
          title: isRollback ? '恢复失败' : '上线失败',
          cause:
            failureUserMessage ||
            shortFailureCause(steps, deployment.uploadError || deployment.errorMessage),
          suggestion: isRollback
            ? '当前线上版本未受影响。请稍后重试，或检查运行配置后再次恢复。'
            : userErrorBase.suggestion,
          failureCode,
          failedStageLabel: experienceStageLabel(deployment.currentStage),
        }
      : null;

    return {
      deployment: {
        id: deployment.id,
        projectId: deployment.projectId,
        projectName: deployment.project.name,
        status: deployment.status,
        version: deployment.version,
        releaseLabel: deployment.releaseLabel,
        errorMessage: deployment.errorMessage,
        failureCode,
        currentStage: deployment.currentStage,
        currentStageLabel: experienceStageLabel(deployment.currentStage),
        startedAt: deployment.startedAt,
        finishedAt: deployment.finishedAt,
        hostingMode: hosting.mode,
        hostingLabel: hosting.label,
        uploadStatus: deployment.uploadStatus,
        uploadError: deployment.uploadError,
        deployableUnitId: deployment.deployableUnitId,
        unitLabel: progress.unitLabel,
        retryCount: deployment.retryCount,
        maxRetry: deployment.maxRetry,
        isRollback,
        restoredFrom,
      },
      steps,
      progress,
      success,
      // Kept for advanced/debug consumers; product page no longer renders this separately.
      upload: {
        status: deployment.uploadStatus,
        error: deployment.uploadError,
        startedAt: deployment.uploadStartedAt,
        finishedAt: deployment.uploadFinishedAt,
        label: uploadStatusLabel(deployment.uploadStatus),
      },
      userError,
      queue: {
        waitingToStart: deployment.status === DeploymentStatus.QUEUED,
        queuedAt: deployment.status === DeploymentStatus.QUEUED ? deployment.updatedAt : null,
        workerHint:
          deployment.status === DeploymentStatus.QUEUED
            ? '正在等待上线任务开始…'
            : deployment.status === DeploymentStatus.RUNNING
              ? null
              : null,
        bullmqJobId: deployment.bullmqJobId,
      },
    };
  }

  async requeue(userId: string, deploymentId: string) {
    const { membership } = await this.workspaceAccess.requireDeploymentAccess(
      userId,
      deploymentId,
    );
    if (
      membership.role !== WorkspaceRole.OWNER &&
      membership.role !== WorkspaceRole.ADMIN
    ) {
      throw new ForbiddenException();
    }

    const record = await this.prisma.deployment.findUniqueOrThrow({
      where: { id: deploymentId },
      select: {
        id: true,
        status: true,
        maxRetry: true,
        errorMessage: true,
        queueStallCount: true,
      },
    });

    if (record.status === DeploymentStatus.SUCCESS) {
      throw new BadRequestException('已成功的上线任务不能重新入队。');
    }
    if (record.status === DeploymentStatus.RUNNING) {
      throw new BadRequestException('正在执行的任务请等待完成或失败后再恢复。');
    }
    if (
      record.status !== DeploymentStatus.QUEUED &&
      record.status !== DeploymentStatus.FAILED
    ) {
      throw new BadRequestException('当前状态不可重新入队。');
    }

    const stalled =
      record.status === DeploymentStatus.QUEUED ||
      (record.status === DeploymentStatus.FAILED &&
        (record.errorMessage?.includes('未能开始执行') ||
          record.errorMessage?.includes('QUEUE_STALLED') ||
          record.queueStallCount > 0));

    if (!stalled && record.status === DeploymentStatus.FAILED) {
      throw new BadRequestException('仅可恢复排队卡住或明确可恢复的失败任务。');
    }

    await this.ensureWorkerOnline();

    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        status: DeploymentStatus.QUEUED,
        errorMessage: null,
        finishedAt: null,
        lastActivityAt: new Date(),
      },
    });

    const jobId = await this.deploymentQueue.enqueue(record.id, record.maxRetry);
    await this.prisma.deployment.update({
      where: { id: record.id },
      data: { bullmqJobId: jobId },
    });
    await this.prisma.deploymentLog.create({
      data: {
        deploymentId: record.id,
        level: 'info',
        message: `Admin requeue jobId=${jobId}`,
      },
    });

    return this.getById(userId, record.id);
  }

  private async ensureWorkerOnline(): Promise<void> {
    const presence = await this.workerPresence.getOnlineConsumer('deployment');
    if (presence.online && presence.queueReady.deployment) {
      return;
    }
    this.logger.warn('NO_DEPLOYMENT_WORKER_AVAILABLE');
    throw new ServiceUnavailableException({
      message: '上线服务暂时不可用，请稍后再试。',
      code: 'NO_DEPLOYMENT_WORKER_AVAILABLE',
    });
  }

  async getAdvancedLogs(userId: string, deploymentId: string) {
    await this.workspaceAccess.requireDeploymentAccess(userId, deploymentId);

    const [deployment, logs, stepLogs] = await Promise.all([
      this.prisma.deployment.findUniqueOrThrow({
        where: { id: deploymentId },
        select: {
          id: true,
          status: true,
          uploadStatus: true,
          uploadError: true,
          errorMessage: true,
          projectId: true,
          serverInstance: {
            select: { name: true, host: true, port: true, scope: true },
          },
          project: {
            select: {
              slug: true,
              applicationDomains: {
                where: { type: 'SYSTEM' },
                orderBy: { createdAt: 'desc' },
                take: 20,
                select: {
                  domain: true,
                  status: true,
                  dnsStatus: true,
                  sslStatus: true,
                  runtimeHost: true,
                  runtimePort: true,
                },
              },
              serviceInstances: {
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: {
                  status: true,
                  port: true,
                  externalPort: true,
                  server: { select: { name: true, host: true, scope: true } },
                },
              },
            },
          },
        },
      }),
      this.prisma.deploymentLog.findMany({
        where: { deploymentId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          level: true,
          message: true,
          createdAt: true,
        },
      }),
      this.prisma.deploymentStepLog.findMany({
        where: { deploymentId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          command: true,
          cwd: true,
          stdout: true,
          stderr: true,
          exitCode: true,
          duration: true,
          createdAt: true,
        },
      }),
    ]);

    const classified = logs.map((item) => ({
      ...item,
      category: classifyAdvancedLog(item.message),
    }));

    const systemDomain = pickCurrentSystemDomain(deployment.project.applicationDomains) ?? null;
    const service = deployment.project.serviceInstances[0] ?? null;
    const platform =
      deployment.serverInstance?.scope === 'PLATFORM_MANAGED' || service?.server?.scope === 'PLATFORM_MANAGED';
    const targetHost = platform ? null : service?.server?.host ?? '127.0.0.1';
    const targetPort = service?.externalPort ?? service?.port ?? null;

    return {
      deployment: {
        id: deployment.id,
        status: deployment.status,
        uploadStatus: deployment.uploadStatus,
        uploadError: deployment.uploadError,
        errorMessage: deployment.errorMessage,
        serverInstance: platform
          ? deployment.serverInstance
            ? { name: 'LaunchOS 自动托管', host: null, port: null, scope: deployment.serverInstance.scope }
            : null
          : deployment.serverInstance,
      },
      routing: {
        systemDomain: systemDomain?.domain ?? null,
        gatewayStatus: systemDomain?.status ?? null,
        dnsStatus: systemDomain?.dnsStatus ?? null,
        sslStatus: systemDomain?.sslStatus ?? null,
        targetServer: targetHost,
        targetPort,
        serviceStatus: service?.status ?? null,
        routeReady: Boolean(
          systemDomain?.status === 'ACTIVE' && service?.status === 'RUNNING' && targetPort,
        ),
      },
      ssh: classified.filter((item) => item.category === 'ssh'),
      upload: classified.filter((item) => item.category === 'upload'),
      deploy: classified.filter((item) => item.category === 'deploy'),
      other: classified.filter((item) => item.category === 'other'),
      commandLogs: stepLogs,
    };
  }

  async getRemoteStatus(userId: string, deploymentId: string) {
    await this.workspaceAccess.requireDeploymentAccess(userId, deploymentId);

    const remoteDeployment = await this.prisma.remoteDeployment.findFirst({
      where: { deploymentId },
      orderBy: { startedAt: 'desc' },
      select: {
        id: true,
        deploymentId: true,
        cloudResourceId: true,
        status: true,
        logs: true,
        startedAt: true,
        finishedAt: true,
        cloudResource: {
          select: {
            publicIp: true,
            status: true,
          },
        },
      },
    });

    if (!remoteDeployment) {
      return { remoteDeployment: null, publicUrl: null };
    }

    const publicIp = remoteDeployment.cloudResource.publicIp;
    const { cloudResource: _cloudResource, ...record } = remoteDeployment;
    const publicUrl = publicIp ? `http://${publicIp}/` : null;

    return {
      remoteDeployment: {
        ...record,
        publicIp,
        publicUrl,
      },
      publicUrl,
    };
  }

}

function toUserError(
  diagnosis: {
    category: string;
    title: string;
    description: string;
    solution: string;
    fixPrompt: string;
  } | null,
  errorMessage: string | null,
) {
  if (errorMessage && /上传超时|上传失败|服务器无法连接/i.test(errorMessage)) {
    return {
      cause: errorMessage.split('\n')[0] || errorMessage,
      suggestion: errorMessage.includes('上传')
        ? '请检查网络与服务器磁盘空间后重新上线。'
        : '请检查 IP、端口、账号、密码和防火墙后重试。',
      assistantPrompt: [
        '请帮我排查这个应用上线失败的原因，并给出修改建议。不要直接改代码，也不要提交。',
        `系统提示：${errorMessage}`,
      ].join('\n'),
    };
  }
  const mapped = diagnosis ? USER_ERROR_BY_CATEGORY[diagnosis.category] : undefined;
  const cause = mapped?.cause ?? diagnosis?.description ?? '这次上线没有完成。';
  const suggestion =
    mapped?.suggestion ?? diagnosis?.solution ?? '请检查代码后重新上线，或把问题复制给 AI 开发助手。';
  const assistantPrompt =
    diagnosis?.fixPrompt ||
    [
      '请帮我排查这个应用上线失败的原因，并给出修改建议。不要直接改代码，也不要提交。',
      `问题原因：${cause}`,
      `解决建议：${suggestion}`,
      errorMessage ? `系统提示：${errorMessage}` : '',
    ]
      .filter(Boolean)
      .join('\n');

  return { cause, suggestion, assistantPrompt };
}

function uploadStatusLabel(status: string): string {
  switch (status) {
    case 'PREPARING':
      return '准备上传';
    case 'UPLOADING':
      return '上传中';
    case 'COMPLETED':
      return '上传完成';
    case 'FAILED':
      return '上传失败';
    default:
      return '等待上传';
  }
}

function classifyAdvancedLog(message: string): 'ssh' | 'upload' | 'deploy' | 'other' {
  if (message.startsWith('[SSH]') || /ssh|连接服务器/i.test(message)) {
    return 'ssh';
  }
  if (message.startsWith('[上传]') || /上传|upload/i.test(message)) {
    return 'upload';
  }
  if (message.startsWith('[部署]') || /docker|构建|启动应用|部署/i.test(message)) {
    return 'deploy';
  }
  return 'other';
}

const USER_ERROR_BY_CATEGORY: Record<string, { cause: string; suggestion: string }> = {
  DEPENDENCY_ERROR: {
    cause: '应用缺少必要的代码依赖。',
    suggestion: '请补齐依赖后再重新上线。',
  },
  CONFIG_ERROR: {
    cause: '应用缺少必要配置。',
    suggestion: '请补上配置后再重新上线。',
  },
  PORT_ERROR: {
    cause: '应用启动时端口被占用。',
    suggestion: '请换一个端口，或关掉占用端口的程序后再上线。',
  },
  RUNTIME_ERROR: {
    cause: '应用启动后意外退出。',
    suggestion: '请检查启动方式和代码后重新上线。',
  },
  BUILD_ERROR: {
    cause: '应用构建没有通过。',
    suggestion: '请先在本地确认代码能正常构建，再重新上线。',
  },
  DATABASE_ERROR: {
    cause: '应用连接数据服务失败。',
    suggestion: '请检查数据相关配置后再重新上线。',
  },
  QUEUE_ERROR: {
    cause: '上线任务未能开始执行。',
    suggestion: '请稍后重试。若持续失败，请联系管理员检查上线服务。',
  },
  UNKNOWN: {
    cause: '这次上线没有完成。',
    suggestion: '可以把问题复制给 AI 开发助手帮忙查看。',
  },
};

function readMaxRetry(): number {
  const raw = Number(process.env.DEPLOYMENT_MAX_RETRY);
  if (Number.isInteger(raw) && raw > 0) {
    return raw;
  }
  return DEFAULT_DEPLOYMENT_MAX_RETRY;
}

type ExperienceDeployment = {
  status: DeploymentStatus;
  serverInstanceId: string | null;
  serverInstance: { id: string; name: string; host: string; scope?: string | null } | null;
  steps: { stepKey: string; status: DeploymentStepStatus }[];
  remoteDeployments: { status: RemoteDeploymentStatus; cloudResource: { publicIp: string | null } }[];
  project: {
    name: string;
    aiAnalyses: { id: string }[];
    deploymentPlans: { runtime: string }[];
    resourceRecommendations: { id: string }[];
    cloudResources: {
      publicIp: string | null;
      status: CloudResourceStatus;
      provider: { name: string; type: string };
    }[];
    domains: { domain: string; status: string }[];
    applicationDomains: { domain: string; status: string; sslStatus: string; dnsStatus: string }[];
    serviceInstances: {
      runtime: string;
      runtimeMode: string;
      status: ServiceStatus;
      healthStatus?: HealthStatus | null;
      port: number | null;
      externalPort: number | null;
      internalPort: number | null;
      containerId: string | null;
      server: { name: string; host: string } | null;
    }[];
  };
};

function hostingInfo(deployment: ExperienceDeployment): {
  mode: 'launchos' | 'my-server';
  label: string;
  accessEntryPending: boolean;
} {
  if (deployment.serverInstance?.scope === 'PLATFORM_MANAGED') {
    return { mode: 'launchos', label: 'LaunchOS 自动托管', accessEntryPending: false };
  }
  const serverName =
    deployment.project.serviceInstances[0]?.server?.name ?? deployment.serverInstance?.name;
  const hasRemoteServer =
    Boolean(deployment.serverInstanceId) || Boolean(deployment.project.serviceInstances[0]?.server);
  const providerHint = deployment.project.cloudResources[0]?.provider?.type;
  if (hasRemoteServer && providerHint === 'ALIYUN') {
    return {
      mode: 'launchos',
      label: 'LaunchOS 托管',
      accessEntryPending: true,
    };
  }
  if (hasRemoteServer) {
    return { mode: 'my-server', label: serverName || '我的服务器', accessEntryPending: false };
  }
  return { mode: 'launchos', label: 'LaunchOS 自动托管', accessEntryPending: false };
}

function buildSuccessPayload(deployment: ExperienceDeployment) {
  const remote = deployment.remoteDeployments[0];
  const server = deployment.project.cloudResources[0];
  const domain = deployment.project.domains[0];
  const applicationDomain = pickCurrentSystemDomain(deployment.project.applicationDomains);
  const service = deployment.project.serviceInstances[0];
  const plan = deployment.project.deploymentPlans[0];
  const publicIp = remote?.cloudResource.publicIp || server?.publicIp || null;
  const branded = applicationDomain
    ? toVisitUrls(applicationDomain)
    : { visitUrl: null, localVisitUrl: null, dnsReady: false, gatewayReady: false };
  const accessPort = service?.externalPort ?? service?.port ?? null;
  const remoteHost = service?.server?.host?.trim() || deployment.serverInstance?.host?.trim() || null;
  const hosting = hostingInfo(deployment);
  const platform = deployment.serverInstance?.scope === 'PLATFORM_MANAGED';
  const runtimeUrl = platform
    ? branded.visitUrl
    : hosting.mode === 'my-server' && remoteHost && accessPort
      ? `http://${remoteHost}:${accessPort}/`
      : accessPort
        ? `http://127.0.0.1:${accessPort}/`
        : null;

  // Step 27: do not fabricate public ECS:dynamicPort URLs or bare publicIp links.
  const visitUrl = branded.visitUrl
    ? branded.visitUrl
    : hosting.accessEntryPending
      ? null
      : hosting.mode === 'my-server'
        ? null
        : publicIp
          ? `http://${publicIp}/`
          : domain?.domain
            ? `http://${domain.domain}/`
            : null;

  return {
    visitUrl,
    localVisitUrl: branded.dnsReady ? null : branded.localVisitUrl,
    visitUrlReady: Boolean(branded.dnsReady && branded.visitUrl),
    visitUrlPreparing:
      hosting.accessEntryPending || Boolean(branded.gatewayReady && !branded.dnsReady),
    accessEntryPending: hosting.accessEntryPending,
    accessEntryMessage: hosting.accessEntryPending
      ? managedAccessEntryPendingMessage()
      : null,
    systemDomain: applicationDomain?.domain ?? null,
    dnsStatus: applicationDomain?.dnsStatus ?? null,
    gatewayDomainStatus: applicationDomain?.status ?? null,
    runtimeUrl,
    runtime: plan?.runtime || service?.runtime || 'nodejs',
    cloudProvider: hosting.mode === 'my-server' ? '我的服务器' : server?.provider.name || 'LaunchOS',
    serverIp: platform || hosting.accessEntryPending ? null : publicIp || remoteHost || '127.0.0.1',
    serverName: platform ? null : service?.server?.name ?? deployment.serverInstance?.name ?? null,
    serverHost: platform ? null : remoteHost,
    accessPort: hosting.accessEntryPending ? null : accessPort,
    deployMode: hosting.mode === 'my-server' || hosting.accessEntryPending ? 'remote' : 'local',
    hostingMode: hosting.mode,
    hostingLabel: hosting.label,
    containerStatus: service?.status ?? null,
  };
}

function pickCurrentSystemDomain<T extends { domain: string }>(domains: T[]): T | undefined {
  if (!domains.length) return undefined;
  const zone = readSystemDomainZone();
  const suffix = `.${zone}`;
  return domains.find((item) => item.domain === zone || item.domain.endsWith(suffix)) ?? domains[0];
}
