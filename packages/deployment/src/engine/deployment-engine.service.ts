import { mkdir, unlink, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DeploymentDiagnoser } from '@launchos/ai';
import {
  ApplicationSslStatus,
  ApplicationVersionStatus,
  ArtifactStatus,
  ArtifactType,
  DiagnosisCategory,
  DiagnosisSeverity,
  DeploymentStatus,
  DeploymentStepStatus,
  HealthStatus,
  PrismaClient,
  RemoteUploadStatus,
  ServiceStatus,
} from '@launchos/database';
import { RunnerService, type CommandResult } from '@launchos/runner';
import {
  buildAndSaveImageArchive,
  MANAGED_BASE_IMAGE,
  RUNTIME_PULL_POLICY_NEVER,
  createRuntimeProvider,
  generateDockerFiles,
  RemoteDockerRuntime,
  RuntimeService,
  isDockerSupportedFramework,
  readRuntimeMode,
  type RuntimeMode,
} from '@launchos/runtime';
import {
  decryptCredential,
  QUEUE_STALL_MS,
  RUNNING_STALL_MS,
  deploymentJobId,
  isRetryableDeploymentError,
  classifyDeploymentFailure,
  planReleasePointers,
  sanitizeDeploymentFailureDetail,
  shouldAutoRetryDeploymentFailure,
  OLD_RUNTIME_GRACE_MS,
  redactSecrets,
  asManagedServerMeta,
  asDockerImageMetadata,
  assertRuntimePublishSpec,
  assertManagedRuntimePort,
  assertManagedServerBound,
  assertImageArchitectureCompatible,
  classifyManagedDeployRuntimeFailure,
  managedAccessEntryPendingMessage,
  resolveFailedServiceInstanceStatus,
  resolveRunnableStartCommand,
  scanImageBuildForSecrets,
  shouldSkipPublicGatewayForManagedDeploy,
  RUNTIME_PULL_POLICY,
  MANAGED_SERVER_ARCHITECTURE,
  resolveUnitHealthCheck,
  filterRuntimeEnvForUnitType,
  verifyRuntimeConfigPresence,
  WEB_FORBIDDEN_RUNTIME_SECRET_KEYS,
  type DockerImageArtifactMetadata,
} from '@launchos/shared';
import {
  applyColocatedNginxRoute,
  certificateCoversHostname,
  DomainManager,
  ensurePublicDnsReady,
  markDomainDnsFromPublicResolve,
  readGatewayPublicIp,
  readSystemDomainZone,
  SystemDomainService,
  verifyPublicEntryWithRetry,
} from '@launchos/domain';
import { GitError, GitService, isPlaceholderGitUrl, type GitAuthContext } from '@launchos/git';
import {
  GitHubAppError,
  createInstallationAccessToken,
} from '@launchos/github';
import {
  ProjectAnalyzer,
  SECRET_ENV_ARTIFACT_EXCLUDES,
  installCommandFromManager,
  isMobileFramework,
  isWebDeployableFramework,
  resolveUnitPath,
} from '@launchos/analyzer';
import { MinioArtifactStore } from '../artifacts/minio-artifact-store';
import { DomainService } from '../domains/domain.service';
import { DEPLOYMENT_STEPS } from '../steps/definitions';
import { canTransition } from '../state-machine/transitions';
import { CloudRuntimeDeployer } from '../remote/cloud-runtime-deployer';
import {
  allocateHostPort,
  toUserFacingRuntimeError,
} from '../remote/host-port-allocator';
import { DeploymentEngineError } from './errors';
import { RuntimeConfigResolver } from '../runtime-config/runtime-config-resolver';

export { DeploymentEngineError } from './errors';

export class DeploymentEngineService {
  private readonly artifactStore = new MinioArtifactStore();
  private readonly buildOutputs = new Map<string, { path: string; size: number }>();
  private readonly git = new GitService();
  private readonly projectAnalyzer = new ProjectAnalyzer();
  private readonly domains: DomainService;
  private readonly domainManager: DomainManager;
  private readonly diagnoser = new DeploymentDiagnoser();
  private readonly remoteDeployer: CloudRuntimeDeployer;
  private readonly runtimeConfigResolver: RuntimeConfigResolver;
  /** Per-deployment secret plaintexts for log redaction (memory only). */
  private readonly deploymentSecrets = new Map<string, string[]>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly runner: RunnerService = new RunnerService(),
    private readonly runtime: RuntimeService = new RuntimeService(),
    domains?: DomainService,
    domainManager?: DomainManager,
  ) {
    this.domains = domains ?? new DomainService(prisma);
    this.domainManager = domainManager ?? new DomainManager(prisma);
    this.remoteDeployer = new CloudRuntimeDeployer(prisma, this.artifactStore);
    this.runtimeConfigResolver = new RuntimeConfigResolver(prisma);
  }

  async createPendingSteps(deploymentId: string): Promise<void> {
    await this.prisma.deploymentStep.createMany({
      data: DEPLOYMENT_STEPS.map((step, index) => ({
        deploymentId,
        stepKey: step.stepKey,
        name: step.name,
        status: DeploymentStepStatus.PENDING,
        order: index + 1,
        attempt: 1,
      })),
    });
  }

  async transition(
    deploymentId: string,
    nextStatus: DeploymentStatus,
    extra: {
      startedAt?: Date;
      finishedAt?: Date;
      errorMessage?: string | null;
      currentStage?: string | null;
      failureCode?: string | null;
    } = {},
  ): Promise<void> {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { status: true },
    });

    if (!deployment) {
      throw new DeploymentEngineError(`Deployment ${deploymentId} not found`);
    }

    if (!canTransition(deployment.status, nextStatus)) {
      throw new DeploymentEngineError(
        `Invalid transition ${deployment.status} -> ${nextStatus}`,
      );
    }

    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        status: nextStatus,
        startedAt: extra.startedAt,
        finishedAt: extra.finishedAt,
        errorMessage: extra.errorMessage,
        ...(extra.currentStage !== undefined ? { currentStage: extra.currentStage } : {}),
        ...(extra.failureCode !== undefined ? { failureCode: extra.failureCode } : {}),
      },
    });
  }

  async enqueue(deploymentId: string): Promise<void> {
    await this.transition(deploymentId, DeploymentStatus.QUEUED);
    await this.touchActivity(deploymentId);
  }

  async prepareAttempt(deploymentId: string, attempt: number): Promise<void> {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { status: true },
    });

    if (!deployment) {
      throw new DeploymentEngineError(`Deployment ${deploymentId} not found`);
    }

    if (
      deployment.status === DeploymentStatus.SUCCESS ||
      deployment.status === DeploymentStatus.CANCELLED
    ) {
      return;
    }

    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        retryCount: attempt,
        status: DeploymentStatus.QUEUED,
        errorMessage: null,
        startedAt: null,
        finishedAt: null,
        lastActivityAt: new Date(),
        bullmqJobId: deploymentJobId(deploymentId),
      },
    });

    if (attempt > 1) {
      await this.prisma.deploymentStep.updateMany({
        where: { deploymentId },
        data: {
          status: DeploymentStepStatus.PENDING,
          startedAt: null,
          finishedAt: null,
          errorMessage: null,
          command: null,
          exitCode: null,
          duration: null,
          attempt,
        },
      });
      await this.writeLog(deploymentId, null, 'info', `Retry attempt ${attempt} started`);
    }
  }

  async execute(
    deploymentId: string,
    options: { finalAttempt?: boolean } = {},
  ): Promise<void> {
    const claimed = await this.prisma.deployment.updateMany({
      where: { id: deploymentId, status: DeploymentStatus.QUEUED },
      data: {
        status: DeploymentStatus.RUNNING,
        startedAt: new Date(),
        errorMessage: null,
        lastActivityAt: new Date(),
        bullmqJobId: deploymentJobId(deploymentId),
      },
    });

    if (claimed.count === 0) {
      return;
    }

    try {
      await this.runSteps(deploymentId);
      await this.transition(deploymentId, DeploymentStatus.SUCCESS, {
        finishedAt: new Date(),
        errorMessage: null,
        currentStage: 'SUCCESS',
        failureCode: null,
      });
      await this.finalizeApplicationVersion(deploymentId, ApplicationVersionStatus.ACTIVE);
      await this.recordSuccessfulReleasePointers(deploymentId);
      await this.trackDeploySuccess(deploymentId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Deployment failed';
      const classified = classifyDeploymentFailure(message);
      const retryable =
        isRetryableDeploymentError(message) && shouldAutoRetryDeploymentFailure(classified.code);
      const finalAttempt = options.finalAttempt !== false || !retryable;
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: {
          status: finalAttempt ? DeploymentStatus.FAILED : DeploymentStatus.QUEUED,
          finishedAt: finalAttempt ? new Date() : null,
          errorMessage: classified.userMessage,
          failureCode: classified.code,
          currentStage: 'FAILED',
          lastActivityAt: new Date(),
        },
      });
      if (finalAttempt) {
        await this.finalizeApplicationVersion(deploymentId, ApplicationVersionStatus.FAILED);
        await this.markNewServiceInstancesFailedOnDeployFailure(deploymentId);
        await this.trackDeployFailed(deploymentId, classified.userMessage, classified.code);
        await this.diagnoseFailure(deploymentId, message).catch((diagnosisError: unknown) => {
          const detail =
            diagnosisError instanceof Error ? diagnosisError.message : 'Diagnosis failed';
          console.error(`LaunchOS diagnosis failed for ${deploymentId}: ${detail}`);
        });
      }
      throw error;
    } finally {
      await this.cleanupBuildOutput(deploymentId);
    }
  }

  async prepareCloudDeploy(deploymentId: string): Promise<{ remoteDeploymentId: string }> {
    const result = await this.remoteDeployer.prepare(deploymentId, true);
    if (result.status === 'SKIPPED' || !result.remoteDeploymentId) {
      throw new DeploymentEngineError('No RUNNING cloud server with public IP is available');
    }
    return { remoteDeploymentId: result.remoteDeploymentId };
  }

  async runRemoteDeployment(remoteDeploymentId: string): Promise<void> {
    await this.remoteDeployer.runExisting(remoteDeploymentId);
  }

  private async runRemoteDeployStep(deploymentId: string, stepId: string): Promise<void> {
    const startedAt = Date.now();
    try {
      const deployment = await this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: { targetType: true, serverInstanceId: true },
      });
      if (!deployment) {
        throw new DeploymentEngineError(`Deployment ${deploymentId} not found`);
      }

      // Step 27.1 — managed path executes here (not local DEPLOY_APPLICATION).
      if (String(deployment.targetType || '').toUpperCase() === 'MANAGED_SERVER') {
        assertManagedServerBound({
          targetType: deployment.targetType,
          serverInstanceId: deployment.serverInstanceId,
        });
        await this.runRemoteDockerDeployStep(
          deploymentId,
          stepId,
          deployment.serverInstanceId!,
        );
        return;
      }

      const result = await this.remoteDeployer.deployForPipeline(deploymentId);
      if (result.status === 'SKIPPED') {
        await this.prisma.deploymentStep.update({
          where: { id: stepId },
          data: {
            status: DeploymentStepStatus.SKIPPED,
            finishedAt: new Date(),
            duration: Date.now() - startedAt,
          },
        });
        await this.writeLog(
          deploymentId,
          stepId,
          'info',
          'Remote Deploy skipped (no RUNNING ECS with public IP)',
        );
        return;
      }

      await this.prisma.deploymentStep.update({
        where: { id: stepId },
        data: {
          status: DeploymentStepStatus.SUCCESS,
          finishedAt: new Date(),
          duration: Date.now() - startedAt,
          exitCode: 0,
          command: 'ssh remote-deploy',
        },
      });
      await this.writeLog(
        deploymentId,
        stepId,
        'info',
        result.publicUrl
          ? `Remote Deploy completed at ${result.publicUrl}`
          : 'Remote Deploy completed',
      );
    } catch (error) {
      const message =
        error instanceof Error && (error as { code?: string }).code === 'MANAGED_SERVER_NOT_BOUND'
          ? '托管部署未绑定服务器，已拒绝本地回退。'
          : error instanceof Error
            ? error.message
            : 'Remote deploy failed';
      await this.prisma.deploymentStep.update({
        where: { id: stepId },
        data: {
          status: DeploymentStepStatus.FAILED,
          finishedAt: new Date(),
          duration: Date.now() - startedAt,
          exitCode: 1,
          command: 'ssh remote-deploy',
          errorMessage: message,
        },
      });
      await this.writeLog(deploymentId, stepId, 'error', message);
      throw error instanceof DeploymentEngineError
        ? error
        : new DeploymentEngineError(message, {
            code: (error as { code?: string })?.code,
          });
    }
  }

  private async runHealthCheckStep(
    deploymentId: string,
    stepId: string,
    delayMs: number,
  ): Promise<void> {
    const startedAt = Date.now();
    let command = 'GET /';
    try {
      // Legacy ECS public-IP path (optional). Dynamic unit ports on BYO servers are never probed publicly.
      const result = await this.remoteDeployer.checkPublicHealth(deploymentId);
      if (result === 'OK') {
        await this.prisma.deploymentStep.update({
          where: { id: stepId },
          data: {
            status: DeploymentStepStatus.SUCCESS,
            finishedAt: new Date(),
            duration: Date.now() - startedAt,
            exitCode: 0,
            command,
          },
        });
        await this.writeLog(deploymentId, stepId, 'info', 'Health Check completed via public IP');
        return;
      }

      await delay(Math.min(delayMs, 500));
      const deployment = await this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: {
          projectId: true,
          deployableUnitId: true,
          serverInstanceId: true,
          deployableUnit: { select: { type: true } },
        },
      });
      if (!deployment) {
        throw new DeploymentEngineError(`Deployment ${deploymentId} not found`);
      }

      const instance = await this.prisma.serviceInstance.findFirst({
        where: {
          projectId: deployment.projectId,
          status: ServiceStatus.RUNNING,
          ...(deployment.deployableUnitId
            ? { deployableUnitId: deployment.deployableUnitId }
            : {}),
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          port: true,
          externalPort: true,
          containerId: true,
          runtimeMode: true,
          serverInstanceId: true,
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
      const accessPort = instance?.externalPort ?? instance?.port;
      if (!instance || !accessPort) {
        throw new DeploymentEngineError('没有可探测的 Runtime 端口');
      }

      const isRemote = Boolean(instance.serverInstanceId && instance.server);
      const health = resolveUnitHealthCheck({
        unitType: deployment.deployableUnit?.type,
      });
      const healthPath = health.healthPath;
      // Remote: always probe loopback on the target server via RuntimeProvider.
      // Local: probe loopback on the LaunchOS host.
      const url = `http://127.0.0.1:${accessPort}${healthPath}`;
      command = isRemote ? `SSH GET ${url}` : `GET ${url}`;
      await this.writeLog(
        deploymentId,
        stepId,
        'info',
        `Health path source=${health.healthPathSource}`,
      );

      const provider = isRemote
        ? createRuntimeProvider('remote', {
            host: instance.server!.host,
            port: instance.server!.port,
            username: instance.server!.username,
            password: decryptCredential(instance.server!.credentialEncrypted),
          })
        : this.runtime;

      const probe = await provider.checkHttp(url);
      await this.prisma.deploymentStepLog.create({
        data: {
          deploymentId,
          stepId,
          command,
          cwd: url,
          stdout: `HTTP ${probe.status}\n${probe.body}`,
          stderr: '',
          exitCode: 0,
          duration: probe.duration,
        },
      });
      await this.prisma.serviceInstance.update({
        where: { id: instance.id },
        data: {
          healthStatus: HealthStatus.HEALTHY,
          lastHealthCheckAt: new Date(),
          responseTimeMs: probe.duration,
          healthMessage: '运行正常',
        },
      });
      await this.prisma.deploymentStep.update({
        where: { id: stepId },
        data: {
          status: DeploymentStepStatus.SUCCESS,
          finishedAt: new Date(),
          duration: Date.now() - startedAt,
          exitCode: 0,
          command,
          metadata: {
            url: probe.url,
            status: probe.status,
            containerId: instance.containerId,
            port: accessPort,
            runtimeMode: instance.runtimeMode,
            probeMode: isRemote ? 'server-local' : 'local',
          },
        },
      });
      await this.writeLog(
        deploymentId,
        stepId,
        'info',
        `Health Check completed via ${isRemote ? 'server-local' : 'local'} ${probe.url} (HTTP ${probe.status})`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Health check failed';
      await this.prisma.deploymentStep.update({
        where: { id: stepId },
        data: {
          status: DeploymentStepStatus.FAILED,
          finishedAt: new Date(),
          duration: Date.now() - startedAt,
          exitCode: 1,
          command,
          errorMessage: message,
        },
      });
      await this.writeLog(deploymentId, stepId, 'error', message);
      await this.markNewServiceInstancesFailedOnDeployFailure(deploymentId, {
        healthFailed: true,
      });
      throw error;
    }
  }

  private async runSteps(deploymentId: string): Promise<void> {
    const steps = await this.prisma.deploymentStep.findMany({
      where: { deploymentId },
      orderBy: { order: 'asc' },
    });

    for (const step of steps) {
      const definition = DEPLOYMENT_STEPS.find((item) => item.stepKey === step.stepKey);

      await this.prisma.deploymentStep.update({
        where: { id: step.id },
        data: {
          status: DeploymentStepStatus.RUNNING,
          startedAt: new Date(),
          errorMessage: null,
        },
      });

      await this.writeLog(deploymentId, step.id, 'info', `${step.name} started`);

      if (step.stepKey === 'BUILD_APPLICATION') {
        await this.runBuildStep(deploymentId, step.id);
      } else if (step.stepKey === 'STORE_ARTIFACT') {
        await this.runStoreArtifactStep(deploymentId, step.id);
      } else if (step.stepKey === 'DEPLOY_APPLICATION') {
        await this.runDeployStep(deploymentId, step.id);
      } else if (step.stepKey === 'VALIDATE_SOURCE') {
        await this.runValidateSourceStep(deploymentId, step.id, definition?.delayMs ?? 1000);
      } else if (step.stepKey === 'REMOTE_DEPLOY') {
        await this.runRemoteDeployStep(deploymentId, step.id);
      } else if (step.stepKey === 'HEALTH_CHECK') {
        await this.runHealthCheckStep(deploymentId, step.id, definition?.delayMs ?? 1000);
      } else {
        const delayMs = definition?.delayMs ?? 1000;
        await delay(delayMs);
        await this.prisma.deploymentStep.update({
          where: { id: step.id },
          data: {
            status: DeploymentStepStatus.SUCCESS,
            finishedAt: new Date(),
          },
        });
        await this.writeLog(deploymentId, step.id, 'info', `${step.name} completed`);
      }
    }
  }

  private async runValidateSourceStep(
    deploymentId: string,
    stepId: string,
    delayMs: number,
  ): Promise<void> {
    if (await this.reuseArtifactId(deploymentId)) {
      await this.skipStep(deploymentId, stepId, '回滚使用已有上线包，跳过重新拉取代码');
      return;
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { projectId: true },
    });
    if (!deployment) {
      throw new DeploymentEngineError(`Deployment ${deploymentId} not found`);
    }

    const source = await this.prisma.sourceRepository.findFirst({
      where: { projectId: deployment.projectId },
      orderBy: { createdAt: 'desc' },
    });
    if (!source) {
      const message = '请先连接代码';
      await this.prisma.deploymentStep.update({
        where: { id: stepId },
        data: {
          status: DeploymentStepStatus.FAILED,
          finishedAt: new Date(),
          errorMessage: message,
        },
      });
      await this.writeLog(deploymentId, stepId, 'error', message);
      throw new DeploymentEngineError(message);
    }

    const injected = injectedFailureMessage(source.url);
    if (injected) {
      await this.prisma.deploymentStep.update({
        where: { id: stepId },
        data: {
          status: DeploymentStepStatus.FAILED,
          finishedAt: new Date(),
          errorMessage: injected,
        },
      });
      await this.writeLog(deploymentId, stepId, 'error', injected);
      throw new DeploymentEngineError(injected);
    }

    if (isPlaceholderGitUrl(source.url)) {
      await delay(delayMs);
      await this.prisma.deploymentStep.update({
        where: { id: stepId },
        data: {
          status: DeploymentStepStatus.SUCCESS,
          finishedAt: new Date(),
        },
      });
      await this.writeLog(deploymentId, stepId, 'info', '示例项目使用内置演示代码，跳过远程拉取');
      return;
    }

    try {
      const auth = await this.resolveSourceAuth(source);
      const directory = this.git.workspaceDir(deployment.projectId);

      // Multi-unit launches share one project workspace. Reuse a fresh checkout from a
      // sibling unit instead of re-hitting GitHub detect/clone (ls-remote often flakes).
      try {
        const existing = await this.git.getCommitInfo(directory);
        if (existing.sha) {
          await this.prisma.deployment.update({
            where: { id: deploymentId },
            data: { sourceRevision: existing.sha },
          });
          await this.prisma.applicationVersion.updateMany({
            where: { deploymentId },
            data: {
              commitSha: existing.sha,
              commitMessage: existing.message,
            },
          });
          await this.writeLog(
            deploymentId,
            stepId,
            'info',
            `复用已拉取代码 ${source.fullName || source.url} @ ${existing.shortSha || existing.sha.slice(0, 7)}`,
          );
          await this.prisma.deploymentStep.update({
            where: { id: stepId },
            data: {
              status: DeploymentStepStatus.SUCCESS,
              finishedAt: new Date(),
            },
          });
          await this.writeLog(deploymentId, stepId, 'info', 'Validate Source completed');
          return;
        }
      } catch {
        // no reusable checkout — fall through to detect + clone
      }

      const detected = await this.git.detectRepository(source.url, auth);
      if (!detected.reachable) {
        throw new GitError(
          source.connectionId || source.isPrivate
            ? '无法访问该代码仓库。若为私有仓库，请重新连接 GitHub。'
            : '无法访问该 Git 仓库，请确认地址是否公开可访问',
        );
      }

      const branch = source.branch.trim() || detected.defaultBranch || 'main';
      await this.writeLog(
        deploymentId,
        stepId,
        'info',
        `正在拉取代码 ${source.fullName || source.url}（${branch}）`,
      );
      await this.git.cloneRepository(source.url, directory, branch, auth);
      await this.git.checkoutBranch(directory, branch);
      const commit = await this.git.getCommitInfo(directory);
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: { sourceRevision: commit.sha },
      });
      await this.prisma.applicationVersion.updateMany({
        where: { deploymentId },
        data: {
          commitSha: commit.sha,
          commitMessage: commit.message,
        },
      });
      await this.writeLog(
        deploymentId,
        stepId,
        'info',
        `已获取提交 ${commit.shortSha} ${commit.message}`.trim(),
      );

      const analysis = await this.projectAnalyzer.analyzeRepository(directory);
      await this.prisma.projectAnalysis.create({
        data: {
          projectId: deployment.projectId,
          repositoryPath: directory,
          framework: analysis.framework,
          packageManager: analysis.packageManager,
          buildCommand: analysis.buildCommand,
          startCommand: analysis.startCommand,
          port: analysis.port,
          confidence: analysis.confidence,
        },
      });
      if (analysis.framework !== 'UNSUPPORTED') {
        await this.prisma.project.update({
          where: { id: deployment.projectId },
          data: { framework: analysis.framework },
        });
      }
      await this.writeLog(
        deploymentId,
        stepId,
        'info',
        `项目分析：${analysis.framework}${analysis.summary ? ` — ${analysis.summary}` : ''}${analysis.buildCommand ? ` / ${analysis.buildCommand}` : ''}`,
      );

      if (isMobileFramework(analysis.framework) || analysis.projectType === 'IOS_NATIVE') {
        const message =
          '当前项目属于暂不支持的原生 iOS 应用，无法使用服务器部署流程。';
        await this.prisma.deploymentStep.update({
          where: { id: stepId },
          data: {
            status: DeploymentStepStatus.FAILED,
            finishedAt: new Date(),
            errorMessage: message,
          },
        });
        await this.writeLog(deploymentId, stepId, 'error', message);
        throw new DeploymentEngineError(message);
      }

      if (!isWebDeployableFramework(analysis.framework)) {
        const message = '当前版本暂不支持自动上线这种技术类型。';
        await this.prisma.deploymentStep.update({
          where: { id: stepId },
          data: {
            status: DeploymentStepStatus.FAILED,
            finishedAt: new Date(),
            errorMessage: message,
          },
        });
        await this.writeLog(deploymentId, stepId, 'error', message);
        throw new DeploymentEngineError(message);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '拉取代码失败';
      await this.prisma.deploymentStep.update({
        where: { id: stepId },
        data: {
          status: DeploymentStepStatus.FAILED,
          finishedAt: new Date(),
          errorMessage: message,
        },
      });
      await this.writeLog(deploymentId, stepId, 'error', message);
      throw error instanceof DeploymentEngineError
        ? error
        : new DeploymentEngineError(message);
    }

    await this.prisma.deploymentStep.update({
      where: { id: stepId },
      data: {
        status: DeploymentStepStatus.SUCCESS,
        finishedAt: new Date(),
      },
    });
    await this.writeLog(deploymentId, stepId, 'info', 'Validate Source completed');
  }

  private async resolveSourceAuth(source: {
    connectionId: string | null;
    isPrivate: boolean;
    authStatus?: string | null;
  }): Promise<GitAuthContext | undefined> {
    if (!source.connectionId) {
      return undefined;
    }

    const connection = await this.prisma.gitProviderConnection.findUnique({
      where: { id: source.connectionId },
      select: { id: true, installationId: true, status: true },
    });

    if (!connection || connection.status !== 'ACTIVE') {
      await this.markSourceNeedsReauth(source.connectionId);
      throw new GitHubAppError('GitHub 连接已失效，请重新连接。', 'REAUTH_REQUIRED');
    }

    try {
      const token = await createInstallationAccessToken(connection.installationId);
      return { token: token.token, username: 'x-access-token' };
    } catch (error) {
      // Platform misconfiguration must not invalidate the user's GitHub connection.
      if (error instanceof GitHubAppError && error.code === 'NOT_CONFIGURED') {
        throw error;
      }
      await this.markSourceNeedsReauth(connection.id);
      if (error instanceof GitHubAppError) {
        throw error;
      }
      throw new GitHubAppError('GitHub 连接已失效，请重新连接。', 'REAUTH_REQUIRED');
    }
  }

  private async markSourceNeedsReauth(connectionId: string): Promise<void> {
    await this.prisma.gitProviderConnection.updateMany({
      where: { id: connectionId },
      data: { status: 'NEEDS_REAUTH' },
    });
    await this.prisma.sourceRepository.updateMany({
      where: { connectionId },
      data: { authStatus: 'NEEDS_REAUTH' },
    });
  }

  private async diagnoseFailure(deploymentId: string, errorMessage: string): Promise<void> {
    const logs = await this.prisma.deploymentLog.findMany({
      where: { deploymentId },
      orderBy: { createdAt: 'asc' },
      select: { message: true },
    });
    const secrets = await this.secretsForRedaction(deploymentId);
    const safeError = redactSecrets(errorMessage, secrets.values, secrets.keys);
    const blob = [safeError, ...logs.map((item) => item.message)].join('\n');
    const result = await this.diagnoser.analyzeLogs(blob);
    await this.prisma.deploymentDiagnosis.create({
      data: {
        deploymentId,
        category: result.category as DiagnosisCategory,
        severity: result.severity as DiagnosisSeverity,
        title: result.title,
        description: redactSecrets(result.description, secrets.values, secrets.keys),
        solution: redactSecrets(result.solution, secrets.values, secrets.keys),
        fixPrompt: redactSecrets(result.fixPrompt, secrets.values, secrets.keys),
      },
    });
    await this.writeLog(
      deploymentId,
      null,
      'info',
      `AI diagnosis saved: ${result.category} (${result.severity})`,
    );
    console.log(`LaunchOS diagnosis ${result.category} for deployment ${deploymentId}`);
  }

  private async runBuildStep(deploymentId: string, stepId: string): Promise<void> {
    if (await this.reuseArtifactId(deploymentId)) {
      await this.skipStep(deploymentId, stepId, '回滚使用已有上线包，跳过重新构建');
      return;
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: {
        projectId: true,
        deployableUnitId: true,
        deployableUnit: {
          select: {
            id: true,
            rootPath: true,
            framework: true,
            packageManager: true,
            buildCommand: true,
            startCommand: true,
            port: true,
            outputPath: true,
            deployable: true,
            type: true,
            name: true,
          },
        },
      },
    });
    if (!deployment) {
      throw new DeploymentEngineError(`Deployment ${deploymentId} not found`);
    }

    const [project, source, analysis] = await Promise.all([
      this.prisma.project.findUnique({
        where: { id: deployment.projectId },
        select: { isDemo: true },
      }),
      this.prisma.sourceRepository.findFirst({
        where: { projectId: deployment.projectId },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.projectAnalysis.findFirst({
        where: { projectId: deployment.projectId },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    if (project?.isDemo || isPlaceholderGitUrl(source?.url ?? '')) {
      await this.runSandboxBuildStep(deploymentId, stepId);
      return;
    }

    const unit = deployment.deployableUnit;
    if (unit && !unit.deployable) {
      const message = '当前版本暂不支持上线这一部分。';
      await this.failBuildStep(deploymentId, stepId, message);
      throw new DeploymentEngineError(message);
    }

    const effectiveAnalysis = analysis
      ? {
          repositoryPath: analysis.repositoryPath,
          framework: unit?.framework || analysis.framework,
          packageManager: unit?.packageManager ?? analysis.packageManager,
          buildCommand: unit?.buildCommand ?? analysis.buildCommand,
          startCommand: unit?.startCommand ?? analysis.startCommand,
          port: unit?.port ?? analysis.port,
          unitRootPath: unit?.rootPath ?? '.',
          outputPath: unit?.outputPath ?? null,
          deployableUnitId: unit?.id ?? null,
          unitName: unit?.name ?? null,
        }
      : null;

    await this.runAnalyzedBuildStep(deploymentId, stepId, effectiveAnalysis);
  }

  private async runSandboxBuildStep(deploymentId: string, stepId: string): Promise<void> {
    await this.writeLog(deploymentId, stepId, 'info', 'Creating Node.js runner container (node:20)');

    const outputFile = join(tmpdir(), 'launchos-artifacts', `${deploymentId}.tar`);
    await mkdir(dirname(outputFile), { recursive: true });

    let result: CommandResult;
    try {
      result = await this.runner.runNodeBuild({ outputFile });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Runner execution failed';
      await this.failBuildStep(deploymentId, stepId, message);
      throw error;
    }

    await this.recordBuildResult(deploymentId, stepId, result);
    if (result.exitCode !== 0) {
      throw new DeploymentEngineError(
        `BUILD_APPLICATION failed with exit code ${result.exitCode}`,
      );
    }
    await this.storeBuildOutput(deploymentId, stepId, result);
    await this.writeLog(deploymentId, stepId, 'info', 'Build Application completed');
  }

  private async runAnalyzedBuildStep(
    deploymentId: string,
    stepId: string,
    analysis: {
      repositoryPath: string;
      framework: string;
      packageManager: string | null;
      buildCommand: string | null;
      startCommand: string | null;
      port: number | null;
    } | null,
  ): Promise<void> {
    if (!analysis) {
      await this.failBuildStep(deploymentId, stepId, '没有项目分析结果，无法构建');
      throw new DeploymentEngineError('没有项目分析结果，无法构建');
    }
    if (
      analysis.framework === 'UNSUPPORTED' ||
      isMobileFramework(analysis.framework) ||
      !isWebDeployableFramework(analysis.framework)
    ) {
      const message = isMobileFramework(analysis.framework)
        ? '当前项目属于暂不支持的原生 iOS 应用，无法使用服务器部署流程。'
        : '当前项目类型不受支持，无法构建';
      await this.failBuildStep(deploymentId, stepId, message);
      throw new DeploymentEngineError(message);
    }

    let cwd = analysis.repositoryPath;
    try {
      cwd = resolveUnitPath(analysis.repositoryPath, (analysis as { unitRootPath?: string }).unitRootPath || '.');
    } catch (error) {
      const message = error instanceof Error ? error.message : '非法 rootPath';
      await this.failBuildStep(deploymentId, stepId, message);
      throw new DeploymentEngineError(message);
    }
    if (!existsSync(cwd)) {
      await this.failBuildStep(deploymentId, stepId, `代码目录不存在：${cwd}`);
      throw new DeploymentEngineError(`代码目录不存在：${cwd}`);
    }

    await this.writeLog(
      deploymentId,
      stepId,
      'info',
      `构建单元 ${(analysis as { unitName?: string | null }).unitName || (analysis as { unitRootPath?: string }).unitRootPath || '.'}`,
    );

    const installCommand = installCommandFromManager(analysis.packageManager);
    if (!installCommand) {
      await this.failBuildStep(deploymentId, stepId, '没有可用的安装命令');
      throw new DeploymentEngineError('没有可用的安装命令');
    }

    await this.writeLog(deploymentId, stepId, 'info', `在 ${cwd} 执行真实构建命令`);

    const unitId = (
      await this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: { deployableUnitId: true, projectId: true },
      })
    );
    let buildEnv: Record<string, string> = {};
    if (unitId?.deployableUnitId) {
      try {
        const resolved = await this.runtimeConfigResolver.resolve({
          projectId: unitId.projectId,
          deployableUnitId: unitId.deployableUnitId,
          phase: 'BUILD',
        });
        buildEnv = resolved.env;
        this.rememberSecrets(deploymentId, resolved.secretPlaintexts);
        await this.persistConfigMetadata(deploymentId, resolved);
        await this.writeLog(
          deploymentId,
          stepId,
          'info',
          `注入 Build 运行配置 keys=[${resolved.keys.join(', ')}]`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : '解析 Build 配置失败';
        await this.failBuildStep(deploymentId, stepId, message);
        throw new DeploymentEngineError(message);
      }
    }

    const deploymentTarget = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { targetType: true },
    });
    const managedServer =
      String(deploymentTarget?.targetType || '').toUpperCase() === 'MANAGED_SERVER';

    try {
      // Worker process often runs with NODE_ENV=production. npm/pnpm/yarn then
      // omit devDependencies (vite, typescript, …) and BUILD fails with
      // "vite: not found". Force a full install for the BUILD phase only.
      const installEnv: Record<string, string> = {
        ...buildEnv,
        NODE_ENV: 'development',
        NPM_CONFIG_PRODUCTION: 'false',
        // Align with generated Dockerfiles (China-friendly mirror); override if already set.
        NPM_CONFIG_REGISTRY: buildEnv.NPM_CONFIG_REGISTRY || 'https://registry.npmmirror.com',
      };
      const compileEnv: Record<string, string> = {
        ...buildEnv,
        NODE_ENV: 'production',
      };
      // Managed path rebuilds inside Docker (REMOTE_DEPLOY). Local next/vite compile on
      // small Alpha hosts often SIGBUS/OOM; skip redundant local compile and pack source.
      const install = await this.runner.executeCommand({
        command: installCommand,
        cwd,
        timeoutMs: 600_000,
        env: installEnv,
      });
      await this.writeCommandLog(deploymentId, stepId, install);
      if (install.exitCode !== 0) {
        await this.recordBuildResult(deploymentId, stepId, install);
        throw new DeploymentEngineError(`${installCommand} 失败，exit code ${install.exitCode}`);
      }

      let last = install;
      if (analysis.buildCommand && !managedServer) {
        const build = await this.runner.executeCommand({
          command: analysis.buildCommand,
          cwd,
          timeoutMs: 900_000,
          env: compileEnv,
        });
        await this.writeCommandLog(deploymentId, stepId, build);
        last = {
          ...build,
          command: `${install.command} && ${build.command}`,
          duration: install.duration + build.duration,
          logs: [install.logs, build.logs].filter(Boolean).join('\n'),
          stdout: [install.stdout, build.stdout].join('\n'),
          stderr: [install.stderr, build.stderr].join('\n'),
        };
        if (build.exitCode !== 0) {
          await this.recordBuildResult(deploymentId, stepId, last);
          throw new DeploymentEngineError(
            `${analysis.buildCommand} 失败，exit code ${build.exitCode}`,
          );
        }
      } else if (analysis.buildCommand && managedServer) {
        await this.writeLog(
          deploymentId,
          stepId,
          'info',
          'Managed Server：跳过本地编译，交由 REMOTE_DEPLOY 镜像构建',
        );
      }

      const outputFile = join(tmpdir(), 'launchos-artifacts', `${deploymentId}.tar`);
      const packed = await this.packAnalyzedArtifact(
        analysis.framework,
        cwd,
        outputFile,
        (analysis as { outputPath?: string | null }).outputPath,
        { managedSourceOnly: managedServer },
      );
      if (packed.size > 500 * 1024 * 1024) {
        await this.writeLog(
          deploymentId,
          stepId,
          'warn',
          `Artifact 体积较大：${packed.size} bytes`,
        );
      }
      last = {
        ...last,
        artifactPath: packed.path,
        artifactSize: packed.size,
      };

      const runtimeConfig = {
        framework: analysis.framework,
        startCommand: analysis.startCommand ?? null,
        port: analysis.port ?? 3000,
      };
      await this.prisma.deploymentStep.update({
        where: { id: stepId },
        data: {
          metadata: { runtimeConfig, cwd, artifactSource: packed.source },
        },
      });
      await this.writeLog(
        deploymentId,
        stepId,
        'info',
        `Runtime 配置已准备：${runtimeConfig.framework} / ${runtimeConfig.startCommand} / ${runtimeConfig.port}`,
      );

      await this.recordBuildResult(deploymentId, stepId, last);
      await this.storeBuildOutput(deploymentId, stepId, last);
      await this.writeLog(deploymentId, stepId, 'info', 'Build Application completed');
    } catch (error) {
      const message = error instanceof Error ? error.message : '构建失败';
      const current = await this.prisma.deploymentStep.findUnique({
        where: { id: stepId },
        select: { status: true },
      });
      if (current?.status !== DeploymentStepStatus.FAILED) {
        await this.failBuildStep(deploymentId, stepId, message);
      }
      throw error instanceof DeploymentEngineError
        ? error
        : new DeploymentEngineError(message);
    }
  }

  private async packAnalyzedArtifact(
    framework: string,
    cwd: string,
    outputFile: string,
    outputPath?: string | null,
    opts?: { managedSourceOnly?: boolean },
  ): Promise<{ path: string; size: number; source: string }> {
    const commonExclude = [
      '.git',
      'node_modules',
      'coverage',
      'tmp',
      'temp',
      '.cache',
      '.turbo',
      'Pods',
      'DerivedData',
      '.next/cache',
      ...SECRET_ENV_ARTIFACT_EXCLUDES,
    ];

    // Managed remote path rebuilds in Docker from source; do not require local .next/dist.
    if (opts?.managedSourceOnly) {
      const packed = await this.runner.packDirectory({
        sourcePath: cwd,
        outputFile,
        contentsOnly: true,
        exclude: [...commonExclude, 'dist', 'build', '.next'],
      });
      return { ...packed, source: 'managed-source' };
    }

    if (framework === 'NEXTJS' || outputPath === '.next') {
      const sourcePath = join(cwd, '.next');
      if (!existsSync(sourcePath)) {
        throw new DeploymentEngineError('构建成功但未找到 .next 产物');
      }
      // Next runtime also needs package.json etc. Pack unit cwd with excludes, keep .next.
      const packed = await this.runner.packDirectory({
        sourcePath: cwd,
        outputFile,
        contentsOnly: true,
        exclude: commonExclude.filter((item) => item !== '.next/cache').concat(['dist', 'build']),
      });
      return { ...packed, source: outputPath || '.next+src' };
    }
    if (framework === 'VITE' || framework === 'VUE' || outputPath === 'dist') {
      const sourcePath = join(cwd, outputPath || 'dist');
      if (!existsSync(sourcePath)) {
        throw new DeploymentEngineError('构建成功但未找到 dist 产物');
      }
      const packed = await this.runner.packDirectory({ sourcePath, outputFile });
      return { ...packed, source: outputPath || 'dist' };
    }

    const packed = await this.runner.packDirectory({
      sourcePath: cwd,
      outputFile,
      contentsOnly: true,
      exclude: [...commonExclude, 'dist', 'build', '.next'],
    });
    return { ...packed, source: '.' };
  }

  private async storeBuildOutput(
    deploymentId: string,
    stepId: string,
    result: CommandResult,
  ): Promise<void> {
    if (result.exitCode !== 0) {
      throw new DeploymentEngineError(
        `BUILD_APPLICATION failed with exit code ${result.exitCode}`,
      );
    }
    if (result.artifactPath) {
      this.buildOutputs.set(deploymentId, {
        path: result.artifactPath,
        size: result.artifactSize ?? 0,
      });
      await this.writeLog(
        deploymentId,
        stepId,
        'info',
        `Collected build output (${result.artifactSize ?? 0} bytes)`,
      );
    }
  }

  private async writeCommandLog(
    deploymentId: string,
    stepId: string,
    result: CommandResult,
  ): Promise<void> {
    const secrets = await this.secretsForRedaction(deploymentId);
    const safeCommand = redactSecrets(result.command, secrets.values, secrets.keys);
    const safeStdout = redactSecrets(truncateLog(result.stdout), secrets.values, secrets.keys);
    const safeStderr = redactSecrets(truncateLog(result.stderr), secrets.values, secrets.keys);
    await this.prisma.deploymentStepLog.create({
      data: {
        deploymentId,
        stepId,
        command: safeCommand,
        cwd: result.cwd ?? '',
        stdout: safeStdout,
        stderr: safeStderr,
        exitCode: result.exitCode,
        duration: result.duration,
      },
    });
    await this.writeLog(
      deploymentId,
      stepId,
      result.exitCode === 0 ? 'info' : 'error',
      [
        `command: ${safeCommand}`,
        `cwd: ${result.cwd ?? ''}`,
        `exitCode: ${result.exitCode}`,
        `duration: ${result.duration}ms`,
        safeStdout.trim() ? `stdout:\n${safeStdout}` : '',
        safeStderr.trim() ? `stderr:\n${safeStderr}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  private async failBuildStep(deploymentId: string, stepId: string, message: string): Promise<void> {
    await this.prisma.deploymentStep.update({
      where: { id: stepId },
      data: {
        status: DeploymentStepStatus.FAILED,
        finishedAt: new Date(),
        errorMessage: message,
      },
    });
    await this.writeLog(deploymentId, stepId, 'error', message);
  }

  private async runStoreArtifactStep(deploymentId: string, stepId: string): Promise<void> {
    const reusedId = await this.reuseArtifactId(deploymentId);
    if (reusedId) {
      await this.copyReusedArtifact(deploymentId, stepId, reusedId);
      return;
    }

    const startedAt = Date.now();
    const local = this.buildOutputs.get(deploymentId);
    if (!local) {
      const message = 'No build output available to store';
      await this.prisma.deploymentStep.update({
        where: { id: stepId },
        data: {
          status: DeploymentStepStatus.FAILED,
          finishedAt: new Date(),
          errorMessage: message,
        },
      });
      await this.writeLog(deploymentId, stepId, 'error', message);
      throw new DeploymentEngineError(message);
    }

    const objectName = `deployments/${deploymentId}/build-output.tar`;
    const artifact = await this.prisma.artifact.create({
      data: {
        deploymentId,
        type: ArtifactType.BUILD_OUTPUT,
        storagePath: objectName,
        size: local.size,
        status: ArtifactStatus.CREATED,
      },
    });
    await this.writeLog(deploymentId, stepId, 'info', `Artifact ${artifact.id} created`);

    try {
      await this.prisma.artifact.update({
        where: { id: artifact.id },
        data: { status: ArtifactStatus.UPLOADING },
      });
      await this.writeLog(deploymentId, stepId, 'info', `Uploading artifact to MinIO: ${objectName}`);

      const uploaded = await this.artifactStore.upload(objectName, local.path);
      await this.prisma.artifact.update({
        where: { id: artifact.id },
        data: {
          status: ArtifactStatus.READY,
          size: uploaded.size,
          storagePath: `${uploaded.bucket}/${uploaded.objectName}`,
        },
      });

      await this.prisma.deploymentStep.update({
        where: { id: stepId },
        data: {
          command: `minio put ${uploaded.bucket}/${uploaded.objectName}`,
          exitCode: 0,
          duration: Date.now() - startedAt,
          status: DeploymentStepStatus.SUCCESS,
          finishedAt: new Date(),
        },
      });
      await this.writeLog(
        deploymentId,
        stepId,
        'info',
        `Artifact READY (${uploaded.size} bytes) at ${uploaded.bucket}/${uploaded.objectName}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Artifact upload failed';
      await this.prisma.artifact.update({
        where: { id: artifact.id },
        data: { status: ArtifactStatus.FAILED },
      });
      await this.prisma.deploymentStep.update({
        where: { id: stepId },
        data: {
          command: `minio put ${objectName}`,
          exitCode: 1,
          duration: Date.now() - startedAt,
          status: DeploymentStepStatus.FAILED,
          finishedAt: new Date(),
          errorMessage: message,
        },
      });
      await this.writeLog(deploymentId, stepId, 'error', message);
      throw error;
    }
  }

  private async runDeployStep(deploymentId: string, stepId: string): Promise<void> {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: {
        projectId: true,
        environmentId: true,
        serverInstanceId: true,
        sourceArtifactId: true,
        targetType: true,
      },
    });
    if (!deployment) {
      throw new DeploymentEngineError(`Deployment ${deploymentId} not found`);
    }

    const targetType = String(deployment.targetType || 'LOCAL').toUpperCase();

    // Step 27.1 — managed: never local Docker; execution happens in REMOTE_DEPLOY.
    if (targetType === 'MANAGED_SERVER') {
      assertManagedServerBound({
        targetType,
        serverInstanceId: deployment.serverInstanceId,
      });
      await this.skipStep(
        deploymentId,
        stepId,
        'Managed Server：跳过本地 DEPLOY_APPLICATION，交由 REMOTE_DEPLOY 执行',
      );
      return;
    }

    if (deployment.serverInstanceId) {
      // Legacy: BYO without targetType still routes remote via DEPLOY_APPLICATION.
      await this.runRemoteDockerDeployStep(deploymentId, stepId, deployment.serverInstanceId);
      return;
    }

    await this.runLocalDeployStep(deploymentId, stepId);
  }

  private async runRemoteDockerDeployStep(
    deploymentId: string,
    stepId: string,
    serverInstanceId: string,
  ): Promise<void> {
    const startedAt = Date.now();
    const targetProbe = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { targetType: true },
    });
    if (String(targetProbe?.targetType || '').toUpperCase() === 'MANAGED_SERVER') {
      await this.runManagedImageArchiveDeployStep(deploymentId, stepId, serverInstanceId, startedAt);
      return;
    }

    let command = 'docker run';
    let containerId: string | undefined;
    let instanceId: string | undefined;
    let remote: RemoteDockerRuntime | undefined;
    const tarPath = join(tmpdir(), 'launchos-runtime', `${deploymentId}.tar`);

    try {
      const deployment = await this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: {
          projectId: true,
          environmentId: true,
          deployableUnitId: true,
          targetType: true,
          sourceArtifactId: true,
          deployableUnit: {
            select: {
              id: true,
              rootPath: true,
              framework: true,
              packageManager: true,
              startCommand: true,
              port: true,
              name: true,
              type: true,
            },
          },
        },
      });
      if (!deployment) {
        throw new DeploymentEngineError(`Deployment ${deploymentId} not found`);
      }

      const [server, analysis, artifact] = await Promise.all([
        this.prisma.serverInstance.findUnique({ where: { id: serverInstanceId } }),
        this.prisma.projectAnalysis.findFirst({
          where: { projectId: deployment.projectId },
          orderBy: { createdAt: 'desc' },
        }),
        this.prisma.artifact.findFirst({
          where: {
            deploymentId,
            type: ArtifactType.BUILD_OUTPUT,
            status: ArtifactStatus.READY,
          },
          orderBy: { createdAt: 'desc' },
        }),
      ]);
      if (!server) {
        throw new DeploymentEngineError('未找到远程服务器');
      }
      if (!artifact) {
        throw new DeploymentEngineError('No READY artifact available to deploy');
      }
      const framework = deployment.deployableUnit?.framework || analysis?.framework;
      if (!analysis || !isDockerSupportedFramework(framework)) {
        throw new DeploymentEngineError('远程 Docker 仅支持 Node.js / Next.js / Vite');
      }

      await mkdir(dirname(tarPath), { recursive: true });
      let unitPath = analysis.repositoryPath;
      try {
        unitPath = resolveUnitPath(
          analysis.repositoryPath,
          deployment.deployableUnit?.rootPath || '.',
        );
      } catch (error) {
        throw new DeploymentEngineError(
          error instanceof Error ? error.message : '非法 rootPath',
        );
      }
      const packageJsonPath = join(unitPath, 'package.json');
      let packageScripts: Record<string, string> = {};
      if (existsSync(packageJsonPath)) {
        try {
          const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
            scripts?: Record<string, string>;
          };
          packageScripts = pkg.scripts || {};
        } catch {
          packageScripts = {};
        }
      }
      const startResolved = resolveRunnableStartCommand({
        unitStartCommand: deployment.deployableUnit?.startCommand,
        analyzerStartCommand: analysis.startCommand,
        packageScripts,
        hasPackageJson: existsSync(packageJsonPath),
        hasEntrypointFile:
          existsSync(join(unitPath, 'server.js')) ||
          existsSync(join(unitPath, 'dist/main.js')) ||
          existsSync(join(unitPath, 'index.js')),
      });
      if (!startResolved.artifactRunnable || !startResolved.resolvedStartCommand) {
        throw new DeploymentEngineError(
          startResolved.reasonCode === 'USER_PROJECT_START_COMMAND_MISSING'
            ? '应用缺少可用的启动命令（ARTIFACT_NOT_RUNNABLE）'
            : `ARTIFACT_NOT_RUNNABLE:${startResolved.reasonCode}`,
          { code: 'ARTIFACT_NOT_RUNNABLE' },
        );
      }
      await this.writeLog(
        deploymentId,
        stepId,
        'info',
        `resolvedStartCommand=${startResolved.resolvedStartCommand} scripts=[${startResolved.availableScripts.join(',')}]`,
      );

      const reuseExisting = Boolean(deployment.sourceArtifactId);
      const managedTarget = String(deployment.targetType || '').toUpperCase() === 'MANAGED_SERVER';
      if (!reuseExisting && !managedTarget && existsSync(packageJsonPath)) {
        await this.runner.packDirectory({
          sourcePath: unitPath,
          outputFile: tarPath,
          contentsOnly: true,
          exclude: [
            '.git',
            'node_modules',
            'coverage',
            'tmp',
            '.cache',
            'Pods',
            'DerivedData',
            ...SECRET_ENV_ARTIFACT_EXCLUDES,
          ],
        });
        await this.writeLog(
          deploymentId,
          stepId,
          'info',
          `打包单元 ${deployment.deployableUnit?.rootPath || '.'} 并上传到 ${visibleRemoteTarget(server)}`,
        );
      } else {
        await this.artifactStore.download(artifact.storagePath, tarPath);
        await this.writeLog(
          deploymentId,
          stepId,
          'info',
          reuseExisting || managedTarget
            ? `使用已选上线包 ${artifact.id} 上传到 ${visibleRemoteTarget(server)}`
            : `上传上线包 ${artifact.id} 到 ${visibleRemoteTarget(server)}`,
        );
      }

      const files = generateDockerFiles({
        framework: framework || analysis.framework,
        packageManager: deployment.deployableUnit?.packageManager ?? analysis.packageManager,
        startCommand: startResolved.resolvedStartCommand,
        port: deployment.deployableUnit?.port ?? analysis.port,
        buildArgKeys: [],
      });

      let buildEnv: Record<string, string> = {};
      let runtimeEnv: Record<string, string> = {};
      if (deployment.deployableUnitId) {
        const buildResolved = await this.runtimeConfigResolver.resolve({
          projectId: deployment.projectId,
          deployableUnitId: deployment.deployableUnitId,
          phase: 'BUILD',
        });
        const runtimeResolved = await this.runtimeConfigResolver.resolve({
          projectId: deployment.projectId,
          deployableUnitId: deployment.deployableUnitId,
          phase: 'RUNTIME',
          containerPort: files.containerPort,
        });
        buildEnv = buildResolved.env;
        runtimeEnv = runtimeResolved.env;
        this.rememberSecrets(deploymentId, [
          ...buildResolved.secretPlaintexts,
          ...runtimeResolved.secretPlaintexts,
        ]);
        await this.persistConfigMetadata(deploymentId, runtimeResolved);
        // regenerate dockerfile with ARG keys for Next.js build-time public env
        const regenerated = generateDockerFiles({
          framework: framework || analysis.framework,
          packageManager: deployment.deployableUnit?.packageManager ?? analysis.packageManager,
          startCommand: startResolved.resolvedStartCommand,
          port: deployment.deployableUnit?.port ?? analysis.port,
          buildArgKeys: Object.keys(buildEnv),
        });
        Object.assign(files, regenerated);
        await this.writeLog(
          deploymentId,
          stepId,
          'info',
          `运行配置 keys build=[${buildResolved.keys.join(', ')}] runtime=[${runtimeResolved.keys.join(', ')}]`,
        );
      }
      const imageTag = dockerImageTag(deployment.projectId, deploymentId);
      const runtimeName = dockerRuntimeName(framework || analysis.framework);

      const instance = await this.prisma.serviceInstance.create({
        data: {
          projectId: deployment.projectId,
          environmentId: deployment.environmentId,
          deployableUnitId: deployment.deployableUnitId,
          artifactId: artifact.id,
          runtime: runtimeName,
          runtimeMode: 'docker',
          status: ServiceStatus.CREATING,
          serverInstanceId: server.id,
          internalPort: files.containerPort,
        },
      });
      instanceId = instance.id;

      remote = new RemoteDockerRuntime({
        host: server.host,
        port: server.port,
        username: server.username,
        password: decryptCredential(server.credentialEncrypted),
      });

      const remoteDir = `/opt/launchos/${deploymentId}`;
      await this.setUploadStatus(deploymentId, RemoteUploadStatus.PREPARING);
      await this.writeLog(deploymentId, stepId, 'info', `[SSH] 连接 ${visibleRemoteTarget(server)}`);
      await this.writeLog(deploymentId, stepId, 'info', `[上传] 准备上传到 ${remoteDir}`);
      let artifactSize = 0;
      try {
        artifactSize = (await stat(tarPath)).size;
        await this.writeLog(
          deploymentId,
          stepId,
          'info',
          `[上传] artifact size=${artifactSize} bytes`,
        );
      } catch {
        // ignore size probe failures
      }
      const uploadTimeoutMs = readUploadTimeoutMs();
      let lastActivity = 'preparing';
      let uploaded;
      try {
        uploaded = await withTimeout(
          remote.uploadArtifact(
            tarPath,
            remoteDir,
            {
              'Dockerfile.launchos': files.dockerfile,
              '.dockerignore': files.dockerignore,
              ...files.extraFiles,
            },
            async (progress) => {
              lastActivity = progress.phase;
              if (progress.phase === 'uploading') {
                await this.setUploadStatus(deploymentId, RemoteUploadStatus.UPLOADING);
              }
              if (progress.phase === 'completed') {
                await this.setUploadStatus(deploymentId, RemoteUploadStatus.COMPLETED);
              }
              await this.writeLog(
                deploymentId,
                stepId,
                'info',
                `[上传] ${progress.message}`,
              );
            },
          ),
          uploadTimeoutMs,
          '上传应用超时。',
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : '上传失败';
        const userMessage = /超时|timeout/i.test(message) ? '上传应用超时。' : message;
        await this.setUploadStatus(deploymentId, RemoteUploadStatus.FAILED, userMessage);
        await this.writeLog(
          deploymentId,
          stepId,
          'error',
          [
            userMessage,
            `timeout=${uploadTimeoutMs}ms`,
            `step=DEPLOY_APPLICATION`,
            `duration=${Date.now() - startedAt}ms`,
            `artifactSize=${artifactSize}`,
            `lastActivity=${lastActivity}`,
          ].join(' '),
        );
        throw new DeploymentEngineError(userMessage);
      }

      await this.writeLog(deploymentId, stepId, 'info', `[部署] 远程构建 ${imageTag}`);
      const built = await remote.buildImage({
        contextPath: uploaded.contextPath,
        imageTag,
        dockerfile: 'Dockerfile.launchos',
        buildArgs: buildEnv,
      });

      const containerName = `launchos-${deploymentId.slice(0, 10).toLowerCase()}`;
      command = `docker run --env-file [redacted] ${built.imageTag}`;

      const previousInstances = await this.prisma.serviceInstance.findMany({
        where: {
          projectId: deployment.projectId,
          serverInstanceId: server.id,
          status: ServiceStatus.RUNNING,
          ...(deployment.deployableUnitId
            ? { deployableUnitId: deployment.deployableUnitId }
            : {}),
          id: { not: instance.id },
        },
        select: {
          id: true,
          containerId: true,
          externalPort: true,
          port: true,
        },
      });

      let hostPort: number;
      try {
        hostPort = await allocateHostPort({
          prisma: this.prisma,
          remote,
          serverInstanceId: server.id,
        });
        assertManagedRuntimePort(hostPort);
      } catch (error) {
        const message = error instanceof Error ? error.message : '端口分配失败';
        throw new DeploymentEngineError(toUserFacingRuntimeError(message));
      }

      // Reserve immediately so concurrent allocators / DB probes see the port.
      await this.prisma.serviceInstance.update({
        where: { id: instance.id },
        data: {
          port: hostPort,
          externalPort: hostPort,
          internalPort: files.containerPort,
        },
      });

      await this.writeLog(
        deploymentId,
        stepId,
        'info',
        `[部署] 启动应用 ${containerName} hostPort=${hostPort} containerPort=${files.containerPort}`,
      );
      let started;
      try {
        assertRuntimePublishSpec({
          publishHost: '127.0.0.1',
          hostPort,
          containerPort: files.containerPort,
        });
        started = await remote.runContainer({
          imageTag: built.imageTag,
          name: containerName,
          internalPort: files.containerPort,
          hostPort,
          publishHost: '127.0.0.1',
          env: runtimeEnv,
          labels: {
            'launchos.projectId': deployment.projectId,
            'launchos.deployableUnitId': deployment.deployableUnitId || 'none',
            'launchos.deploymentId': deploymentId,
            'launchos.serviceInstanceId': instance.id,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : '启动容器失败';
        const classified = classifyManagedDeployRuntimeFailure(message);
        throw new DeploymentEngineError(
          classified.code === 'RUNTIME_PUBLIC_BIND_FORBIDDEN'
            ? classified.userMessage
            : toUserFacingRuntimeError(classified.userMessage || message),
          { code: classified.code },
        );
      }
      containerId = started.containerId;

      const health = resolveUnitHealthCheck({
        unitType: deployment.deployableUnit?.type,
      });
      const healthPath = health.healthPath;
      await this.writeLog(
        deploymentId,
        stepId,
        'info',
        `[部署] 健康检查 http://127.0.0.1:${started.externalPort}${healthPath} (source=${health.healthPathSource})`,
      );
      try {
        await remote.checkHttp(
          `http://127.0.0.1:${started.externalPort}${healthPath}`,
          90_000,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : '健康检查失败';
        const classified = classifyManagedDeployRuntimeFailure(message);
        throw new DeploymentEngineError(classified.userMessage, { code: classified.code });
      }

      const runtimeUrl =
        String(server.scope || '').toUpperCase() === 'PLATFORM_MANAGED'
          ? `http://127.0.0.1:${started.externalPort}/`
          : `http://${server.host}:${started.externalPort}/`;
      await this.prisma.serviceInstance.update({
        where: { id: instance.id },
        data: {
          status: ServiceStatus.RUNNING,
          healthStatus: HealthStatus.HEALTHY,
          lastHealthCheckAt: new Date(),
          healthMessage: '运行正常',
          containerId,
          port: started.externalPort,
          externalPort: started.externalPort,
          internalPort: started.internalPort,
          imageTag: built.imageTag,
          imageId: built.imageId ?? started.imageId,
          ...(await this.configMetadataForService(deploymentId)),
        },
      });
      if (built.imageTag) {
        await this.prisma.artifact.create({
          data: {
            deploymentId,
            type: ArtifactType.DOCKER_IMAGE,
            storagePath: built.imageTag,
            size: 0,
            status: ArtifactStatus.READY,
          },
        });
      }

      const projectMeta = await this.prisma.project.findUnique({
        where: { id: deployment.projectId },
        select: { id: true, slug: true, name: true },
      });
      const skipPublicGateway = shouldSkipPublicGatewayForManagedDeploy({
        provider: server.provider,
        metadata: asManagedServerMeta(server.metadata),
        scope: server.scope,
      });
      if (projectMeta && !skipPublicGateway) {
        await this.publishColocatedGateway({
          deploymentId,
          stepId,
          projectId: projectMeta.id,
          slug: projectMeta.slug,
          deployableUnitId: deployment.deployableUnitId,
          unitLabel: deployment.deployableUnit?.name || deployment.deployableUnit?.rootPath,
          port: started.externalPort,
          server,
        });
      } else if (skipPublicGateway) {
        await this.writeLog(
          deploymentId,
          stepId,
          'info',
          managedAccessEntryPendingMessage(),
        );
      }

      // Stop previous containers only after new instance is healthy + routed.
      // Keep containers for a short grace window so rollback can revive them.
      const graceUntil = new Date(Date.now() + OLD_RUNTIME_GRACE_MS).toISOString();
      for (const old of previousInstances) {
        if (old.containerId) {
          await remote.stopContainer(old.containerId).catch(() => undefined);
        }
        await this.prisma.serviceInstance.update({
          where: { id: old.id },
          data: {
            status: ServiceStatus.STOPPED,
            healthStatus: HealthStatus.UNKNOWN,
            healthMessage: `已被新版本替换，宽限期至 ${graceUntil}`,
          },
        });
        await this.writeLog(
          deploymentId,
          stepId,
          'info',
          `[部署] 已停止旧实例 ${old.id.slice(0, 10)} hostPort=${old.externalPort ?? old.port ?? '-'}（保留 ${Math.round(OLD_RUNTIME_GRACE_MS / 60000)} 分钟宽限，暂不销毁）`,
        );
      }

      // Belt-and-suspenders: only one RUNNING instance per unit on this server.
      const leftovers = await this.prisma.serviceInstance.findMany({
        where: {
          projectId: deployment.projectId,
          serverInstanceId: server.id,
          status: ServiceStatus.RUNNING,
          ...(deployment.deployableUnitId
            ? { deployableUnitId: deployment.deployableUnitId }
            : {}),
          id: { not: instance.id },
        },
        select: { id: true, containerId: true },
      });
      for (const old of leftovers) {
        if (old.containerId) {
          await remote.stopContainer(old.containerId).catch(() => undefined);
        }
        await this.prisma.serviceInstance.update({
          where: { id: old.id },
          data: {
            status: ServiceStatus.STOPPED,
            healthMessage: '已被新版本替换（宽限保留）',
          },
        });
      }

      await this.prisma.deploymentStep.update({
        where: { id: stepId },
        data: {
          command,
          exitCode: 0,
          duration: Date.now() - startedAt,
          status: DeploymentStepStatus.SUCCESS,
          finishedAt: new Date(),
          metadata: {
            runtimeMode: 'docker',
            runtimeProvider: 'remote',
            serverInstanceId: server.id,
            serverName: String(server.scope || '') === 'PLATFORM_MANAGED' ? 'LaunchOS' : server.name,
            serverHost: String(server.scope || '') === 'PLATFORM_MANAGED' ? null : server.host,
            containerId,
            imageTag: built.imageTag,
            externalPort: started.externalPort,
            internalPort: started.internalPort,
            hostPort: started.externalPort,
            containerPort: started.internalPort,
            runtimeUrl,
            replacedServiceInstanceIds: previousInstances.map((item) => item.id),
          },
        },
      });
      await this.writeLog(
        deploymentId,
        stepId,
        'info',
        `RemoteDockerRuntime 部署完成 ${runtimeUrl} container ${containerId}`,
      );
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : '远程部署失败';
      const message = toUserFacingRuntimeError(rawMessage);
      const current = await this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: { uploadStatus: true },
      });
      if (
        current?.uploadStatus === RemoteUploadStatus.PREPARING ||
        current?.uploadStatus === RemoteUploadStatus.UPLOADING
      ) {
        await this.setUploadStatus(deploymentId, RemoteUploadStatus.FAILED, message);
      }
      // New container failed — destroy it; leave previous RUNNING instances untouched.
      if (containerId && remote) {
        await remote.destroyRuntime(containerId).catch(() => undefined);
      }
      if (instanceId) {
        await this.prisma.serviceInstance.update({
          where: { id: instanceId },
          data: { status: ServiceStatus.FAILED },
        });
      }
      await this.prisma.deploymentStep.update({
        where: { id: stepId },
        data: {
          command,
          exitCode: 1,
          duration: Date.now() - startedAt,
          status: DeploymentStepStatus.FAILED,
          finishedAt: new Date(),
          errorMessage: message,
        },
      });
      await this.writeLog(deploymentId, stepId, 'error', `[部署] ${message}`);
      throw new DeploymentEngineError(message);
    } finally {
      await unlink(tarPath).catch(() => undefined);
    }
  }

  /**
   * Step 27.2 — Managed Server: builder builds DOCKER_IMAGE archive → MinIO →
   * remote upload → podman/docker load → run --pull=never.
   * Never docker build / pull on the managed ECS.
   */
  private async runManagedImageArchiveDeployStep(
    deploymentId: string,
    stepId: string,
    serverInstanceId: string,
    startedAt: number,
  ): Promise<void> {
    let command = 'podman load && podman run --pull=never';
    let containerId: string | undefined;
    let instanceId: string | undefined;
    let remote: RemoteDockerRuntime | undefined;
    const artifactRoot =
      process.env.LOCAL_ARTIFACT_ROOT?.trim() ||
      process.env.LAUNCHOS_LOCAL_ARTIFACT_ROOT?.trim() ||
      tmpdir();
    const imageArchiveLocal = join(
      artifactRoot,
      'launchos-image-archives',
      `${deploymentId}.tar`,
    );

    try {
      const deployment = await this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: {
          projectId: true,
          environmentId: true,
          deployableUnitId: true,
          targetType: true,
          sourceArtifactId: true,
          deployableArtifactId: true,
          deployableUnit: {
            select: {
              id: true,
              rootPath: true,
              framework: true,
              packageManager: true,
              startCommand: true,
              port: true,
              name: true,
              type: true,
            },
          },
        },
      });
      if (!deployment) {
        throw new DeploymentEngineError(`Deployment ${deploymentId} not found`);
      }
      assertManagedServerBound({
        targetType: deployment.targetType,
        serverInstanceId,
      });

      const [server, analysis, buildOutput] = await Promise.all([
        this.prisma.serverInstance.findUnique({ where: { id: serverInstanceId } }),
        this.prisma.projectAnalysis.findFirst({
          where: { projectId: deployment.projectId },
          orderBy: { createdAt: 'desc' },
        }),
        this.prisma.artifact.findFirst({
          where: {
            deploymentId,
            type: ArtifactType.BUILD_OUTPUT,
            status: ArtifactStatus.READY,
          },
          orderBy: { createdAt: 'desc' },
        }),
      ]);
      if (!server) {
        throw new DeploymentEngineError('未找到远程服务器');
      }
      if (!buildOutput && !deployment.sourceArtifactId) {
        throw new DeploymentEngineError('No READY BUILD_OUTPUT available to deploy');
      }
      const framework = deployment.deployableUnit?.framework || analysis?.framework;
      if (!analysis || !isDockerSupportedFramework(framework)) {
        throw new DeploymentEngineError('远程 Docker 仅支持 Node.js / Next.js / Vite');
      }

      let unitPath = analysis.repositoryPath;
      try {
        unitPath = resolveUnitPath(
          analysis.repositoryPath,
          deployment.deployableUnit?.rootPath || '.',
        );
      } catch (error) {
        throw new DeploymentEngineError(
          error instanceof Error ? error.message : '非法 rootPath',
        );
      }

      const packageJsonPath = join(unitPath, 'package.json');
      let packageScripts: Record<string, string> = {};
      if (existsSync(packageJsonPath)) {
        try {
          packageScripts =
            (JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { scripts?: Record<string, string> })
              .scripts || {};
        } catch {
          packageScripts = {};
        }
      }
      const startResolved = resolveRunnableStartCommand({
        unitStartCommand: deployment.deployableUnit?.startCommand,
        analyzerStartCommand: analysis.startCommand,
        packageScripts,
        hasPackageJson: existsSync(packageJsonPath),
        hasEntrypointFile:
          existsSync(join(unitPath, 'server.js')) ||
          existsSync(join(unitPath, 'dist/main.js')) ||
          existsSync(join(unitPath, 'index.js')),
      });
      if (!startResolved.artifactRunnable || !startResolved.resolvedStartCommand) {
        throw new DeploymentEngineError(
          `ARTIFACT_NOT_RUNNABLE:${startResolved.reasonCode}`,
          { code: 'ARTIFACT_NOT_RUNNABLE' },
        );
      }

      const dockerfilePreview = generateDockerFiles({
        framework: framework || analysis.framework,
        packageManager: deployment.deployableUnit?.packageManager ?? analysis.packageManager,
        startCommand: startResolved.resolvedStartCommand,
        port: deployment.deployableUnit?.port ?? analysis.port,
        buildArgKeys: [],
      });
      const secretScan = scanImageBuildForSecrets(
        `${dockerfilePreview.dockerfile}\n${existsSync(packageJsonPath) ? readFileSync(packageJsonPath, 'utf8') : ''}`,
      );
      if (secretScan.imageBuildSecretPlaintextHits > 0) {
        throw new DeploymentEngineError(
          `Image build context contains secrets: ${secretScan.hits.join(',')}`,
          { code: 'RUNTIME_CONFIG_MISSING' },
        );
      }

      let buildEnv: Record<string, string> = {};
      let runtimeEnv: Record<string, string> = {};
      let requiredRuntimeKeys: string[] = [];
      let runtimeResolvedRevision = 0;
      let runtimeResolvedFingerprint = '';
      if (deployment.deployableUnitId) {
        const buildResolved = await this.runtimeConfigResolver.resolve({
          projectId: deployment.projectId,
          deployableUnitId: deployment.deployableUnitId,
          phase: 'BUILD',
        });
        const runtimeResolved = await this.runtimeConfigResolver.resolve({
          projectId: deployment.projectId,
          deployableUnitId: deployment.deployableUnitId,
          phase: 'RUNTIME',
          containerPort: dockerfilePreview.containerPort,
        });
        buildEnv = Object.fromEntries(
          Object.entries(buildResolved.env).filter(([k]) => /^NEXT_PUBLIC_|^VITE_/.test(k)),
        );
        // Reject secret values masquerading as public build env.
        for (const key of Object.keys(buildEnv)) {
          if (/SECRET|PASSWORD|PRIVATE_KEY|TOKEN|DATABASE_URL|REDIS_URL/i.test(key)) {
            delete buildEnv[key];
          }
        }
        runtimeEnv = runtimeResolved.env;
        // Required user/system keys expected after resolve (exclude LaunchOS managed PORT/HOST…).
        requiredRuntimeKeys = Object.keys(runtimeResolved.env).filter(
          (key) => !['PORT', 'NODE_ENV', 'HOST', 'HOSTNAME'].includes(key),
        );
        // Narrow to keys that were required by analysis when possible via missingRequired emptiness.
        // Any key still in env that came from a required requirement is already in env when configured.
        runtimeResolvedRevision = runtimeResolved.revision;
        runtimeResolvedFingerprint = runtimeResolved.fingerprint;
        this.rememberSecrets(deploymentId, [
          ...buildResolved.secretPlaintexts,
          ...runtimeResolved.secretPlaintexts,
        ]);
        if (runtimeResolved.missingRequired.length > 0) {
          throw new DeploymentEngineError(
            `上线前还需要完成运行配置：${runtimeResolved.missingRequired.map((item) => item.key).join(', ')}`,
            { code: 'RUNTIME_CONFIG_MISSING' },
          );
        }
      }

      const filteredRuntime = filterRuntimeEnvForUnitType(
        deployment.deployableUnit?.type,
        runtimeEnv,
      );
      runtimeEnv = filteredRuntime.env;
      // Persist metadata from the FINAL injected env (after web isolation), not pre-filter.
      await this.persistConfigMetadata(deploymentId, {
        revision: runtimeResolvedRevision || 0,
        fingerprint: runtimeResolvedFingerprint || filteredRuntime.allowedRuntimeKeys.join(','),
        keys: filteredRuntime.allowedRuntimeKeys,
      });
      const unitTypeUpper = String(deployment.deployableUnit?.type || '').toUpperCase();
      if (unitTypeUpper === 'WEB' || unitTypeUpper === 'STATIC') {
        // Invariant: never inject backend secrets into Web containers (keys only in logs).
        for (const key of WEB_FORBIDDEN_RUNTIME_SECRET_KEYS) {
          if (Object.prototype.hasOwnProperty.call(runtimeEnv, key)) {
            throw new DeploymentEngineError(
              `webSecretIsolation violated: forbidden key still present (${key})`,
              { code: 'RUNTIME_CONFIG_MISSING' },
            );
          }
        }
        if (!filteredRuntime.webSecretIsolation) {
          throw new DeploymentEngineError('webSecretIsolation=false', {
            code: 'RUNTIME_CONFIG_MISSING',
          });
        }
        await this.writeLog(
          deploymentId,
          stepId,
          'info',
          `webSecretIsolation=true allowedRuntimeKeys=[${filteredRuntime.allowedRuntimeKeys.join(',')}] blockedBackendSecretKeys=[${filteredRuntime.blockedBackendSecretKeys.join(',')}]`,
        );
      } else if (filteredRuntime.strippedKeys.length > 0) {
        await this.writeLog(
          deploymentId,
          stepId,
          'info',
          `webSecretIsolation stripped=[${filteredRuntime.strippedKeys.join(',')}]`,
        );
      }

      // Keys expected in the final env: required keys that are not intentionally stripped for this unit.
      const intentionallyBlocked = new Set(filteredRuntime.strippedKeys);
      const requiredAfterFilter = requiredRuntimeKeys.filter((key) => !intentionallyBlocked.has(key));
      const preInjectMissing = requiredAfterFilter.filter((key) => !(key in runtimeEnv));
      if (preInjectMissing.length > 0) {
        throw new DeploymentEngineError(
          `运行配置已保存但未能注入：${preInjectMissing.join(', ')}`,
          { code: 'RUNTIME_CONFIG_INJECTION_MISMATCH' },
        );
      }

      const imageArtifact = await this.ensureManagedDockerImageArtifact({
        deploymentId,
        stepId,
        unitPath,
        framework: framework || analysis.framework,
        packageManager: deployment.deployableUnit?.packageManager ?? analysis.packageManager,
        startCommand: startResolved.resolvedStartCommand,
        containerPort: deployment.deployableUnit?.port ?? analysis.port ?? 3000,
        buildEnv,
        sourceArtifactId: deployment.sourceArtifactId || buildOutput?.id || null,
      });

      const imageMeta = asDockerImageMetadata(imageArtifact.metadata);
      const serverArch =
        typeof asManagedServerMeta(server.metadata).architecture === 'string'
          ? String(asManagedServerMeta(server.metadata).architecture)
          : MANAGED_SERVER_ARCHITECTURE;
      try {
        assertImageArchitectureCompatible({
          imageArchitecture: imageMeta?.architecture || 'amd64',
          serverArchitecture: serverArch,
        });
      } catch (error) {
        const classified = classifyManagedDeployRuntimeFailure(
          error instanceof Error ? error.message : 'IMAGE_ARCHITECTURE_MISMATCH',
        );
        throw new DeploymentEngineError(classified.userMessage, { code: classified.code });
      }

      const runtimeName = dockerRuntimeName(framework || analysis.framework);
      const instance = await this.prisma.serviceInstance.create({
        data: {
          projectId: deployment.projectId,
          environmentId: deployment.environmentId,
          deployableUnitId: deployment.deployableUnitId,
          artifactId: imageArtifact.id,
          runtime: runtimeName,
          runtimeMode: 'docker',
          status: ServiceStatus.CREATING,
          serverInstanceId: server.id,
          internalPort: imageMeta?.containerPort || dockerfilePreview.containerPort,
        },
      });
      instanceId = instance.id;

      remote = new RemoteDockerRuntime({
        host: server.host,
        port: server.port,
        username: server.username,
        password: decryptCredential(server.credentialEncrypted),
      });

      await mkdir(dirname(imageArchiveLocal), { recursive: true });
      await this.artifactStore.download(imageArtifact.storagePath, imageArchiveLocal);
      await this.writeLog(
        deploymentId,
        stepId,
        'info',
        `[UPLOADING_IMAGE] artifact=${imageArtifact.id} size=${imageArtifact.size}`,
      );

      const remoteDir = `/opt/launchos/${deploymentId}`;
      await this.setUploadStatus(deploymentId, RemoteUploadStatus.PREPARING);
      const uploadTimeoutMs = readUploadTimeoutMs();
      let uploaded;
      const uploadHeartbeat = setInterval(() => {
        void this.touchActivity(deploymentId).catch(() => undefined);
      }, 20_000);
      try {
        uploaded = await withTimeout(
          remote.uploadImageArchive({
            localArchivePath: imageArchiveLocal,
            remoteDir,
            onProgress: async (progress) => {
              if (progress.phase === 'uploading') {
                await this.setUploadStatus(deploymentId, RemoteUploadStatus.UPLOADING);
              }
              if (progress.phase === 'completed') {
                await this.setUploadStatus(deploymentId, RemoteUploadStatus.COMPLETED);
              }
              await this.writeLog(deploymentId, stepId, 'info', `[上传] ${progress.message}`);
            },
          }),
          uploadTimeoutMs,
          '上传应用超时。',
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : '上传失败';
        await this.setUploadStatus(deploymentId, RemoteUploadStatus.FAILED, message);
        throw new DeploymentEngineError(message);
      } finally {
        clearInterval(uploadHeartbeat);
      }

      await this.writeLog(deploymentId, stepId, 'info', `[LOADING_IMAGE] ${uploaded.remoteArchivePath}`);
      const loaded = await remote.loadImageArchive({
        remoteArchivePath: uploaded.remoteArchivePath,
        expectedImageTag: imageMeta?.imageTag,
      });
      command = `podman load -i image.tar && podman run --pull=${RUNTIME_PULL_POLICY} ${loaded.loadedImageRef}`;

      const previousInstances = await this.prisma.serviceInstance.findMany({
        where: {
          projectId: deployment.projectId,
          serverInstanceId: server.id,
          status: ServiceStatus.RUNNING,
          ...(deployment.deployableUnitId
            ? { deployableUnitId: deployment.deployableUnitId }
            : {}),
          id: { not: instance.id },
        },
        select: {
          id: true,
          containerId: true,
          externalPort: true,
          port: true,
        },
      });

      let hostPort: number;
      try {
        hostPort = await allocateHostPort({
          prisma: this.prisma,
          remote,
          serverInstanceId: server.id,
        });
        assertManagedRuntimePort(hostPort);
      } catch (error) {
        const message = error instanceof Error ? error.message : '端口分配失败';
        throw new DeploymentEngineError(toUserFacingRuntimeError(message));
      }

      const containerPort = imageMeta?.containerPort || dockerfilePreview.containerPort;
      await this.prisma.serviceInstance.update({
        where: { id: instance.id },
        data: {
          port: hostPort,
          externalPort: hostPort,
          internalPort: containerPort,
        },
      });

      const containerName = `launchos-${deploymentId.slice(0, 10).toLowerCase()}`;
      await this.writeLog(
        deploymentId,
        stepId,
        'info',
        `[STARTING_SERVICE] ${containerName} pull=${RUNTIME_PULL_POLICY} ${hostPort}->${containerPort}`,
      );

      let started;
      try {
        assertRuntimePublishSpec({
          publishHost: '127.0.0.1',
          hostPort,
          containerPort,
        });
        started = await remote.runContainer({
          imageTag: loaded.loadedImageRef,
          name: containerName,
          internalPort: containerPort,
          hostPort,
          publishHost: '127.0.0.1',
          pullPolicy: RUNTIME_PULL_POLICY_NEVER,
          env: runtimeEnv,
          labels: {
            'launchos.projectId': deployment.projectId,
            'launchos.deployableUnitId': deployment.deployableUnitId || 'none',
            'launchos.deploymentId': deploymentId,
            'launchos.serviceInstanceId': instance.id,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : '启动容器失败';
        const classified = classifyManagedDeployRuntimeFailure(message);
        throw new DeploymentEngineError(
          classified.code === 'RUNTIME_PUBLIC_BIND_FORBIDDEN'
            ? classified.userMessage
            : toUserFacingRuntimeError(classified.userMessage || message),
          { code: classified.code },
        );
      }
      containerId = started.containerId;

      // Post-start: verify injected keys are present in container (keys only, never values).
      try {
        const presentKeys = await remote.listContainerEnvKeys(started.containerId);
        const expectedKeys = Object.keys(runtimeEnv);
        const presence = verifyRuntimeConfigPresence({
          requiredKeys: expectedKeys,
          presentKeys,
        });
        await this.writeLog(
          deploymentId,
          stepId,
          presence.ok ? 'info' : 'error',
          `runtimeConfigPresence required=${presence.requiredConfigCount} injected=${presence.injectedConfigCount} missing=[${presence.missingAtRuntime.join(',')}]`,
        );
        for (const key of expectedKeys) {
          const present = presentKeys.includes(key);
          await this.writeLog(
            deploymentId,
            stepId,
            'info',
            `${key}:present=${present ? 'true' : 'false'}`,
          );
        }
        if (!presence.ok) {
          throw new DeploymentEngineError(
            `运行配置注入校验失败（平台问题）：缺少 ${presence.missingAtRuntime.join(', ')}`,
            { code: 'RUNTIME_CONFIG_INJECTION_MISMATCH' },
          );
        }
      } catch (error) {
        if (error instanceof DeploymentEngineError) throw error;
        const message = error instanceof Error ? error.message : '运行配置注入校验失败';
        throw new DeploymentEngineError(message, { code: 'RUNTIME_CONFIG_INJECTION_MISMATCH' });
      }

      const health = resolveUnitHealthCheck({
        unitType: deployment.deployableUnit?.type,
      });
      const healthPath = health.healthPath;
      await this.writeLog(
        deploymentId,
        stepId,
        'info',
        `[HEALTH_CHECK] http://127.0.0.1:${started.externalPort}${healthPath} (source=${health.healthPathSource})`,
      );
      try {
        await remote.checkHttp(
          `http://127.0.0.1:${started.externalPort}${healthPath}`,
          90_000,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : '健康检查失败';
        const classified = classifyManagedDeployRuntimeFailure(message);
        throw new DeploymentEngineError(classified.userMessage, { code: classified.code });
      }

      const runtimeUrl =
        String(server.scope || '').toUpperCase() === 'PLATFORM_MANAGED'
          ? `http://127.0.0.1:${started.externalPort}/`
          : `http://${server.host}:${started.externalPort}/`;
      await this.prisma.serviceInstance.update({
        where: { id: instance.id },
        data: {
          status: ServiceStatus.RUNNING,
          healthStatus: HealthStatus.HEALTHY,
          lastHealthCheckAt: new Date(),
          healthMessage: '运行正常',
          containerId,
          port: started.externalPort,
          externalPort: started.externalPort,
          internalPort: started.internalPort,
          imageTag: loaded.loadedImageRef,
          imageId: loaded.imageId ?? started.imageId,
          ...(await this.configMetadataForService(deploymentId)),
        },
      });

      const projectMeta = await this.prisma.project.findUnique({
        where: { id: deployment.projectId },
        select: { id: true, slug: true, name: true },
      });
      const skipPublicGateway = shouldSkipPublicGatewayForManagedDeploy({
        provider: server.provider,
        metadata: asManagedServerMeta(server.metadata),
        scope: server.scope,
      });
      if (projectMeta && !skipPublicGateway) {
        await this.publishColocatedGateway({
          deploymentId,
          stepId,
          projectId: projectMeta.id,
          slug: projectMeta.slug,
          deployableUnitId: deployment.deployableUnitId,
          unitLabel: deployment.deployableUnit?.name || deployment.deployableUnit?.rootPath,
          port: started.externalPort,
          server,
        });
      } else if (skipPublicGateway) {
        await this.writeLog(
          deploymentId,
          stepId,
          'info',
          managedAccessEntryPendingMessage(),
        );
      }

      for (const old of previousInstances) {
        if (old.containerId) {
          await remote.stopContainer(old.containerId).catch(() => undefined);
        }
        await this.prisma.serviceInstance.update({
          where: { id: old.id },
          data: {
            status: ServiceStatus.STOPPED,
            healthStatus: HealthStatus.UNKNOWN,
            healthMessage: `已被新版本替换，宽限期至 ${new Date(Date.now() + OLD_RUNTIME_GRACE_MS).toISOString()}`,
          },
        });
      }

      await this.prisma.deploymentStep.update({
        where: { id: stepId },
        data: {
          command,
          exitCode: 0,
          duration: Date.now() - startedAt,
          status: DeploymentStepStatus.SUCCESS,
          finishedAt: new Date(),
          metadata: {
            runtimeMode: 'docker',
            runtimeProvider: 'remote-image-archive',
            remoteBuildRequired: false,
            remoteRegistryPullRequired: false,
            runtimePullPolicy: RUNTIME_PULL_POLICY,
            serverInstanceId: server.id,
            deployableArtifactId: imageArtifact.id,
            loadedImageRef: loaded.loadedImageRef,
            containerId,
            externalPort: started.externalPort,
            internalPort: started.internalPort,
            runtimeUrl,
          },
        },
      });
      await this.writeLog(
        deploymentId,
        stepId,
        'info',
        `Managed image-archive deploy completed ${runtimeUrl} container ${containerId}`,
      );
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : '远程部署失败';
      const classified = classifyManagedDeployRuntimeFailure(rawMessage);
      const preserveRootCause =
        classified.code === 'DEPENDENCY_INSTALL_FAILED' ||
        classified.code === 'BUILD_IMAGE_FAILED' ||
        classified.code === 'CONTAINER_START_FAILED';
      const message = preserveRootCause
        ? classified.code === 'CONTAINER_START_FAILED'
          ? toUserFacingRuntimeError(rawMessage)
          : `${classified.code}:${rawMessage.slice(0, 1800)}`
        : classified.userMessage;
      const current = await this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: { uploadStatus: true },
      });
      if (
        current?.uploadStatus === RemoteUploadStatus.PREPARING ||
        current?.uploadStatus === RemoteUploadStatus.UPLOADING
      ) {
        await this.setUploadStatus(deploymentId, RemoteUploadStatus.FAILED, message);
      }
      if (containerId && remote) {
        await remote.destroyRuntime(containerId).catch(() => undefined);
      }
      if (instanceId) {
        await this.prisma.serviceInstance.update({
          where: { id: instanceId },
          data: { status: ServiceStatus.FAILED },
        });
      }
      await this.prisma.deploymentStep.update({
        where: { id: stepId },
        data: {
          command,
          exitCode: 1,
          duration: Date.now() - startedAt,
          status: DeploymentStepStatus.FAILED,
          finishedAt: new Date(),
          errorMessage: message,
          metadata: {
            errorCode: (error as { code?: string })?.code || classified.code,
          },
        },
      });
      await this.writeLog(deploymentId, stepId, 'error', `[部署] ${classified.code}: ${message}`);
      throw new DeploymentEngineError(message, {
        code: (error as { code?: string })?.code || classified.code,
      });
    } finally {
      await unlink(imageArchiveLocal).catch(() => undefined);
    }
  }

  private async ensureManagedDockerImageArtifact(input: {
    deploymentId: string;
    stepId: string;
    unitPath: string;
    framework: string;
    packageManager?: string | null;
    startCommand: string;
    containerPort: number;
    buildEnv: Record<string, string>;
    sourceArtifactId: string | null;
  }): Promise<{
    id: string;
    storagePath: string;
    size: number;
    checksum: string | null;
    metadata: unknown;
  }> {
    const existingId = (
      await this.prisma.deployment.findUnique({
        where: { id: input.deploymentId },
        select: { deployableArtifactId: true },
      })
    )?.deployableArtifactId;

    if (existingId) {
      const existing = await this.prisma.artifact.findFirst({
        where: {
          id: existingId,
          type: ArtifactType.DOCKER_IMAGE,
          status: ArtifactStatus.READY,
          size: { gt: 0 },
        },
      });
      if (existing && asDockerImageMetadata(existing.metadata)) {
        return existing;
      }
    }

    // Reuse a READY archive built for the same source BUILD_OUTPUT (project-wide).
    if (input.sourceArtifactId) {
      const reused = await this.prisma.artifact.findFirst({
        where: {
          type: ArtifactType.DOCKER_IMAGE,
          status: ArtifactStatus.READY,
          size: { gt: 0 },
          deployment: { projectId: (await this.prisma.deployment.findUniqueOrThrow({
            where: { id: input.deploymentId },
            select: { projectId: true },
          })).projectId },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (reused && asDockerImageMetadata(reused.metadata)?.sourceArtifactId === input.sourceArtifactId) {
        await this.prisma.deployment.update({
          where: { id: input.deploymentId },
          data: { deployableArtifactId: reused.id },
        });
        await this.writeLog(
          input.deploymentId,
          input.stepId,
          'info',
          `复用 DOCKER_IMAGE ${reused.id} (source=${input.sourceArtifactId})`,
        );
        return reused;
      }
    }

    await this.writeLog(
      input.deploymentId,
      input.stepId,
      'info',
      `[BUILD_IMAGE] on LaunchOS builder (base=${MANAGED_BASE_IMAGE}) — not on managed ECS`,
    );

    const imageTag = dockerImageTag(
      (
        await this.prisma.deployment.findUniqueOrThrow({
          where: { id: input.deploymentId },
          select: { projectId: true },
        })
      ).projectId,
      input.deploymentId,
    );

    const built = await buildAndSaveImageArchive({
      contextPath: input.unitPath,
      framework: input.framework,
      packageManager: input.packageManager,
      startCommand: input.startCommand,
      containerPort: input.containerPort,
      imageTag,
      buildEnv: input.buildEnv,
      archivePath: join(tmpdir(), 'launchos-image-archives', `${input.deploymentId}-build.tar`),
    });

    const objectName = `deployments/${input.deploymentId}/docker-image.tar`;
    const uploaded = await this.artifactStore.upload(objectName, built.archivePath);
    const storagePath = `${uploaded.bucket}/${uploaded.objectName}`;

    const metadata: DockerImageArtifactMetadata = {
      kind: 'DOCKER_IMAGE_ARCHIVE',
      imageName: imageTag.split(':')[0] || 'launchos/app',
      imageTag: built.imageTag,
      architecture: built.architecture,
      os: built.os,
      containerPort: built.containerPort,
      entrypoint: built.entrypoint,
      cmd: built.cmd,
      sourceArtifactId: input.sourceArtifactId || undefined,
      checksumSha256: built.checksumSha256,
      builtOn: 'launchos-builder',
    };

    const artifact = await this.prisma.artifact.create({
      data: {
        deploymentId: input.deploymentId,
        type: ArtifactType.DOCKER_IMAGE,
        storagePath,
        size: built.size,
        checksum: built.checksumSha256,
        metadata,
        status: ArtifactStatus.READY,
      },
    });

    await this.prisma.deployment.update({
      where: { id: input.deploymentId },
      data: { deployableArtifactId: artifact.id },
    });

    await this.writeLog(
      input.deploymentId,
      input.stepId,
      'info',
      `DOCKER_IMAGE READY ${artifact.id} size=${built.size} arch=${built.architecture} sha256=${built.checksumSha256.slice(0, 12)}…`,
    );

    await unlink(built.archivePath).catch(() => undefined);
    return artifact;
  }

  private async runLocalDeployStep(deploymentId: string, stepId: string): Promise<void> {
    const startedAt = Date.now();
    let command = 'node /app/dist/index.js';
    let containerId: string | undefined;
    let instanceId: string | undefined;
    const tarPath = join(tmpdir(), 'launchos-runtime', `${deploymentId}.tar`);

    try {
      const deployment = await this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: {
          projectId: true,
          environmentId: true,
          deployableUnitId: true,
          deployableUnit: {
            select: { id: true, name: true, rootPath: true, startCommand: true },
          },
        },
      });
      if (!deployment) {
        throw new DeploymentEngineError(`Deployment ${deploymentId} not found`);
      }

      const [projectMeta, source, analysis, artifact, rollback] = await Promise.all([
        this.prisma.project.findUnique({
          where: { id: deployment.projectId },
          select: { id: true, name: true, slug: true, isDemo: true },
        }),
        this.prisma.sourceRepository.findFirst({
          where: { projectId: deployment.projectId },
          orderBy: { createdAt: 'desc' },
        }),
        this.prisma.projectAnalysis.findFirst({
          where: { projectId: deployment.projectId },
          orderBy: { createdAt: 'desc' },
        }),
        this.prisma.artifact.findFirst({
          where: {
            deploymentId,
            type: ArtifactType.BUILD_OUTPUT,
            status: ArtifactStatus.READY,
          },
          orderBy: { createdAt: 'desc' },
        }),
        this.prisma.deployment.findUnique({
          where: { id: deploymentId },
          select: { sourceArtifactId: true },
        }),
      ]);
      if (!projectMeta) {
        throw new DeploymentEngineError(`Project ${deployment.projectId} not found`);
      }
      if (!artifact) {
        throw new DeploymentEngineError('No READY artifact available to deploy');
      }

      let mode = resolveDeployRuntimeMode({
        isDemo: projectMeta.isDemo,
        gitUrl: source?.url ?? '',
        framework: analysis?.framework ?? null,
      });
      const runtimeName =
        mode === 'docker' ? dockerRuntimeName(analysis?.framework) : 'nodejs';
      const reuseExisting = Boolean(rollback?.sourceArtifactId);
      let dockerContext = analysis?.repositoryPath;
      const extractedDir = join(tmpdir(), 'launchos-rollback', deploymentId);

      if (mode === 'mock') {
        await this.writeLog(
          deploymentId,
          stepId,
          'info',
          `Reading artifact ${artifact.id} from ${artifact.storagePath}`,
        );
        await this.artifactStore.download(artifact.storagePath, tarPath);
      } else if (
        reuseExisting ||
        !dockerContext ||
        !existsSync(dockerContext)
      ) {
        await this.artifactStore.download(artifact.storagePath, tarPath);
        await this.extractTar(tarPath, extractedDir);
        if (existsSync(join(extractedDir, 'package.json'))) {
          dockerContext = extractedDir;
          await this.writeLog(
            deploymentId,
            stepId,
            'info',
            '使用已有上线包恢复运行环境',
          );
        } else {
          mode = 'mock';
          await this.writeLog(
            deploymentId,
            stepId,
            'info',
            '已有上线包不含完整源码，改用已保存的运行包启动',
          );
        }
      } else {
        await this.writeLog(
          deploymentId,
          stepId,
          'info',
          `使用已保存的运行配置构建 ${analysis?.framework ?? ''}（${analysis?.repositoryPath ?? ''}）`,
        );
      }

      const instance = await this.prisma.serviceInstance.create({
        data: {
          projectId: deployment.projectId,
          environmentId: deployment.environmentId,
          deployableUnitId: deployment.deployableUnitId,
          artifactId: artifact.id,
          runtime: runtimeName,
          runtimeMode: mode,
          status: ServiceStatus.CREATING,
        },
      });
      instanceId = instance.id;
      await this.writeLog(
        deploymentId,
        stepId,
        'info',
        `Created ServiceInstance ${instance.id} (${runtimeName}/${mode})`,
      );

      let localStartCommand = analysis?.startCommand ?? null;
      if (mode === 'docker' && dockerContext && existsSync(join(dockerContext, 'package.json'))) {
        let packageScripts: Record<string, string> = {};
        try {
          const pkg = JSON.parse(readFileSync(join(dockerContext, 'package.json'), 'utf8')) as {
            scripts?: Record<string, string>;
          };
          packageScripts = pkg.scripts || {};
        } catch {
          packageScripts = {};
        }
        const localResolved = resolveRunnableStartCommand({
          unitStartCommand: deployment.deployableUnit?.startCommand,
          analyzerStartCommand: analysis?.startCommand,
          packageScripts,
          hasPackageJson: true,
          hasEntrypointFile:
            existsSync(join(dockerContext, 'server.js')) ||
            existsSync(join(dockerContext, 'dist/main.js')) ||
            existsSync(join(dockerContext, 'index.js')),
        });
        if (!localResolved.artifactRunnable || !localResolved.resolvedStartCommand) {
          throw new DeploymentEngineError(
            `ARTIFACT_NOT_RUNNABLE:${localResolved.reasonCode}`,
            { code: 'ARTIFACT_NOT_RUNNABLE' },
          );
        }
        localStartCommand = localResolved.resolvedStartCommand;
        await this.writeLog(
          deploymentId,
          stepId,
          'info',
          `resolvedStartCommand=${localStartCommand} scripts=[${localResolved.availableScripts.join(',')}]`,
        );
      }

      const created =
        mode === 'docker'
          ? await this.runtime.createRuntime({
              mode: 'docker',
              contextPath: dockerContext,
              framework: analysis?.framework,
              packageManager: analysis?.packageManager,
              startCommand: localStartCommand,
              containerPort: analysis?.port ?? undefined,
              imageTag: dockerImageTag(deployment.projectId, deploymentId),
              ...(await this.resolveLocalInjectEnv(
                deploymentId,
                deployment.projectId,
                deployment.deployableUnitId,
                analysis?.port ?? 3000,
              )),
            })
          : await this.runtime.createRuntime({
              mode: 'mock',
              artifactTar: tarPath,
              ...(await this.resolveLocalInjectEnv(
                deploymentId,
                deployment.projectId,
                deployment.deployableUnitId,
                analysis?.port ?? 3000,
              )),
            });
      containerId = created.containerId;
      command =
        mode === 'docker'
          ? `docker run ${created.imageTag ?? ''}`.trim()
          : 'node /app/dist/index.js';
      await this.prisma.serviceInstance.update({
        where: { id: instance.id },
        data: {
          containerId,
          imageTag: created.imageTag,
          imageId: created.imageId,
          ...(await this.configMetadataForService(deploymentId)),
        },
      });
      if (created.imageTag) {
        await this.prisma.artifact.create({
          data: {
            deploymentId,
            type: ArtifactType.DOCKER_IMAGE,
            storagePath: created.imageTag,
            size: 0,
            status: ArtifactStatus.READY,
          },
        });
      }
      await this.writeLog(
        deploymentId,
        stepId,
        'info',
        created.imageTag
          ? `Runtime container created ${containerId} image ${created.imageTag}`
          : `Runtime container created ${containerId}`,
      );

      const started = await this.runtime.startRuntime(containerId);
      await this.prisma.serviceInstance.update({
        where: { id: instance.id },
        data: {
          status: ServiceStatus.RUNNING,
          port: started.port,
        },
      });

      const domainRecord = await this.domains.assignDefaultSubdomain({
        projectId: projectMeta.id,
        projectName: projectMeta.name,
        projectSlug: projectMeta.slug,
        serviceInstanceId: instance.id,
        target: '127.0.0.1',
      });
      await this.writeLog(
        deploymentId,
        stepId,
        'info',
        `Assigned domain ${domainRecord.domain} (${domainRecord.status}) with certificate ${domainRecord.certificates[0]?.status ?? 'none'}`,
      );

      if (!started.port) {
        throw new DeploymentEngineError('Runtime did not publish a host port');
      }
      const systemDomain = await this.domainManager.createSystemDomain(
        projectMeta.id,
        projectMeta.slug,
        {
          deployableUnitId: deployment.deployableUnitId,
          unitLabel: deployment.deployableUnit?.name || deployment.deployableUnit?.rootPath,
        },
      );
      await this.domainManager.activateGatewayRouting(systemDomain.domain);
      await this.domainManager.bindRuntime(systemDomain.domain, {
        host: '127.0.0.1',
        port: started.port,
      });
      await new SystemDomainService(this.prisma).syncGatewayRoutes().catch(() => undefined);
      await this.writeLog(
        deploymentId,
        stepId,
        'info',
        `Assigned system domain ${systemDomain.domain} (gateway ready, DNS pending)`,
      );

      const runtimeUrl = `http://127.0.0.1:${started.port}/`;
      await this.prisma.deploymentStep.update({
        where: { id: stepId },
        data: {
          command,
          exitCode: 0,
          duration: Date.now() - startedAt,
          status: DeploymentStepStatus.SUCCESS,
          finishedAt: new Date(),
          metadata: {
            runtimeMode: mode,
            containerId,
            port: started.port,
            imageTag: created.imageTag,
            runtimeUrl,
          },
        },
      });
      await this.writeLog(
        deploymentId,
        stepId,
        'info',
        `Deploy Application completed on ${runtimeUrl} (${mode})`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Runtime deployment failed';
      if (containerId) {
        await this.runtime.destroyRuntime(containerId).catch(() => undefined);
      }
      if (instanceId) {
        await this.prisma.serviceInstance.update({
          where: { id: instanceId },
          data: { status: ServiceStatus.FAILED },
        });
      }
      await this.prisma.deploymentStep.update({
        where: { id: stepId },
        data: {
          command,
          exitCode: 1,
          duration: Date.now() - startedAt,
          status: DeploymentStepStatus.FAILED,
          finishedAt: new Date(),
          errorMessage: message,
        },
      });
      await this.writeLog(deploymentId, stepId, 'error', message);
      throw error;
    } finally {
      await unlink(tarPath).catch(() => undefined);
    }
  }

  async failTimedOutDeployments(options?: {
    hasActiveJob?: (jobId: string | null) => Promise<boolean>;
    requeue?: (deploymentId: string, maxRetry: number) => Promise<string>;
  }): Promise<number> {
    const stepTimeoutMs = readStepTimeoutMs();
    const uploadTimeoutMs = readUploadTimeoutMs();
    const now = Date.now();
    let failed = 0;

    const uploading = await this.prisma.deployment.findMany({
      where: {
        status: DeploymentStatus.RUNNING,
        uploadStatus: { in: [RemoteUploadStatus.PREPARING, RemoteUploadStatus.UPLOADING] },
        uploadStartedAt: { not: null },
      },
      select: {
        id: true,
        uploadStartedAt: true,
        uploadStatus: true,
        steps: {
          where: { status: DeploymentStepStatus.RUNNING },
          select: { id: true, stepKey: true, startedAt: true },
        },
      },
    });

    for (const deployment of uploading) {
      const started = deployment.uploadStartedAt?.getTime() ?? 0;
      if (!started || now - started < uploadTimeoutMs) {
        continue;
      }
      const duration = now - started;
      const message = '上传应用超时。';
      const detail = [
        'timeout',
        `step=upload`,
        `duration=${duration}ms`,
        `uploadStatus=${deployment.uploadStatus}`,
        `lastActivity=upload-watchdog`,
      ].join(' ');
      await this.forceFailDeployment(deployment.id, message, detail);
      failed += 1;
    }

    const runningSteps = await this.prisma.deploymentStep.findMany({
      where: {
        status: DeploymentStepStatus.RUNNING,
        startedAt: { not: null },
        deployment: { status: DeploymentStatus.RUNNING },
      },
      select: {
        id: true,
        stepKey: true,
        startedAt: true,
        deploymentId: true,
      },
    });

    for (const step of runningSteps) {
      const started = step.startedAt?.getTime() ?? 0;
      if (!started || now - started < stepTimeoutMs) {
        continue;
      }
      const duration = now - started;
      const isUploadish =
        step.stepKey === 'DEPLOY_APPLICATION' ||
        step.stepKey === 'BUILD_APPLICATION' ||
        step.stepKey === 'STORE_ARTIFACT';
      const message = isUploadish ? '上传应用超时。' : `步骤 ${step.stepKey} 超时。`;
      const detail = [
        'timeout',
        `step=${step.stepKey}`,
        `duration=${duration}ms`,
        `lastActivity=step-watchdog`,
      ].join(' ');
      await this.forceFailDeployment(step.deploymentId, message, detail, step.id);
      failed += 1;
    }

    failed += await this.failStalledQueuedDeployments(options?.requeue);
    failed += await this.failStalledRunningDeployments(options?.hasActiveJob);

    return failed;
  }

  /**
   * QUEUED longer than QUEUE_STALL_MS without pickup:
   * re-enqueue once, then fail with a user-facing message.
   */
  async failStalledQueuedDeployments(
    requeue?: (deploymentId: string, maxRetry: number) => Promise<string>,
  ): Promise<number> {
    const cutoff = new Date(Date.now() - QUEUE_STALL_MS);
    const stalled = await this.prisma.deployment.findMany({
      where: {
        status: DeploymentStatus.QUEUED,
        OR: [{ lastActivityAt: { lt: cutoff } }, { lastActivityAt: null, updatedAt: { lt: cutoff } }],
      },
      select: { id: true, maxRetry: true, queueStallCount: true, bullmqJobId: true },
      take: 50,
    });

    let failed = 0;
    for (const item of stalled) {
      if (item.queueStallCount < 1 && requeue) {
        try {
          const jobId = await requeue(item.id, item.maxRetry);
          await this.prisma.deployment.update({
            where: { id: item.id },
            data: {
              queueStallCount: item.queueStallCount + 1,
              bullmqJobId: jobId,
              lastActivityAt: new Date(),
            },
          });
          await this.writeLog(
            item.id,
            null,
            'warn',
            `QUEUE_STALLED requeue once jobId=${jobId}`,
          );
          continue;
        } catch (error) {
          const detail = error instanceof Error ? error.message : 'requeue failed';
          await this.writeLog(item.id, null, 'error', `QUEUE_STALLED requeue failed: ${detail}`);
        }
      }

      await this.forceFailDeployment(
        item.id,
        '上线任务未能开始执行。',
        'QUEUE_STALLED',
      );
      await this.prisma.deploymentDiagnosis
        .create({
          data: {
            deploymentId: item.id,
            category: DiagnosisCategory.QUEUE_ERROR,
            severity: DiagnosisSeverity.HIGH,
            title: '上线任务未能开始',
            description: '任务在队列中等待过久，未被执行。',
            solution: '请稍后重试。管理员可在系统设置中检查上线服务状态。',
            fixPrompt: '',
          },
        })
        .catch(() => undefined);
      failed += 1;
    }
    return failed;
  }

  /**
   * RUNNING with no activity for RUNNING_STALL_MS and no active BullMQ job.
   * Long builds that keep writing logs/heartbeat are not failed.
   */
  async failStalledRunningDeployments(
    hasActiveJob?: (jobId: string | null) => Promise<boolean>,
  ): Promise<number> {
    const cutoff = new Date(Date.now() - RUNNING_STALL_MS);
    const stalled = await this.prisma.deployment.findMany({
      where: {
        status: DeploymentStatus.RUNNING,
        OR: [{ lastActivityAt: { lt: cutoff } }, { lastActivityAt: null, updatedAt: { lt: cutoff } }],
      },
      select: { id: true, bullmqJobId: true },
      take: 50,
    });

    let failed = 0;
    for (const item of stalled) {
      if (hasActiveJob) {
        const active = await hasActiveJob(item.bullmqJobId ?? deploymentJobId(item.id));
        if (active) {
          const full = await this.prisma.deployment.findUnique({
            where: { id: item.id },
            select: { uploadStatus: true, currentStage: true },
          });
          const frozenUpload =
            full?.uploadStatus === RemoteUploadStatus.UPLOADING ||
            full?.uploadStatus === RemoteUploadStatus.PREPARING;
          // Active BullMQ job with frozen upload progress is still stalled for users.
          if (!frozenUpload) {
            continue;
          }
        }
      }
      await this.forceFailDeployment(
        item.id,
        '上线任务失去响应，请重试。',
        'RUNNING_STALLED',
      );
      failed += 1;
    }
    return failed;
  }

  async reconcileStaleDeployments(options: {
    getJobState: (jobId: string) => Promise<string | null>;
    requeue: (deploymentId: string, maxRetry: number) => Promise<string>;
  }): Promise<{ fixed: number; failed: number }> {
    let fixed = 0;
    let failed = 0;

    const open = await this.prisma.deployment.findMany({
      where: {
        status: { in: [DeploymentStatus.QUEUED, DeploymentStatus.RUNNING] },
      },
      select: {
        id: true,
        status: true,
        maxRetry: true,
        bullmqJobId: true,
        lastActivityAt: true,
        updatedAt: true,
        queueStallCount: true,
      },
      take: 100,
    });

    for (const item of open) {
      const jobId = item.bullmqJobId ?? deploymentJobId(item.id);
      const state = await options.getJobState(jobId);
      if (item.status === DeploymentStatus.QUEUED) {
        if (!state || state === 'completed' || state === 'failed') {
          try {
            const newId = await options.requeue(item.id, item.maxRetry);
            await this.prisma.deployment.update({
              where: { id: item.id },
              data: { bullmqJobId: newId, lastActivityAt: new Date() },
            });
            await this.writeLog(item.id, null, 'info', `reconcile requeue jobId=${newId}`);
            fixed += 1;
          } catch {
            await this.forceFailDeployment(item.id, '上线任务未能开始执行。', 'RECONCILE_NO_JOB');
            failed += 1;
          }
        }
        continue;
      }

      // RUNNING but job gone → fail safely (do not leave zombie RUNNING)
      if (!state || state === 'completed' || state === 'failed') {
        const age = Date.now() - (item.lastActivityAt ?? item.updatedAt).getTime();
        if (age > 60_000) {
          await this.forceFailDeployment(
            item.id,
            '上线服务中断，请重新尝试。当前线上版本未改动。',
            `WORKER_INTERRUPTED RECONCILE_RUNNING_WITHOUT_JOB state=${state ?? 'missing'}`,
          );
          failed += 1;
        }
      }
    }

    return { fixed, failed };
  }

  async touchActivity(deploymentId: string): Promise<void> {
    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: { lastActivityAt: new Date() },
    }).catch(() => undefined);
  }

  async forceFailDeployment(
    deploymentId: string,
    userMessage: string,
    advancedDetail?: string,
    stepId?: string,
  ): Promise<void> {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { status: true, uploadStatus: true },
    });
    if (!deployment) {
      return;
    }
    if (
      deployment.status === DeploymentStatus.SUCCESS ||
      deployment.status === DeploymentStatus.FAILED ||
      deployment.status === DeploymentStatus.CANCELLED
    ) {
      return;
    }

    if (stepId) {
      await this.prisma.deploymentStep.update({
        where: { id: stepId },
        data: {
          status: DeploymentStepStatus.FAILED,
          finishedAt: new Date(),
          errorMessage: userMessage,
        },
      });
    } else {
      await this.prisma.deploymentStep.updateMany({
        where: {
          deploymentId,
          status: { in: [DeploymentStepStatus.RUNNING, DeploymentStepStatus.PENDING] },
        },
        data: {
          status: DeploymentStepStatus.FAILED,
          finishedAt: new Date(),
          errorMessage: userMessage,
        },
      });
    }

    if (
      deployment.uploadStatus === RemoteUploadStatus.PREPARING ||
      deployment.uploadStatus === RemoteUploadStatus.UPLOADING
    ) {
      await this.setUploadStatus(deploymentId, RemoteUploadStatus.FAILED, userMessage);
    }

    const classified = classifyDeploymentFailure(
      advancedDetail ? `${userMessage} ${advancedDetail}` : userMessage,
    );
    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        status: DeploymentStatus.FAILED,
        finishedAt: new Date(),
        errorMessage: classified.userMessage,
        failureCode: classified.code,
        currentStage: 'FAILED',
      },
    });
    await this.finalizeApplicationVersion(deploymentId, ApplicationVersionStatus.FAILED);
    await this.writeLog(
      deploymentId,
      stepId ?? null,
      'error',
      advancedDetail
        ? `${classified.userMessage} | ${sanitizeDeploymentFailureDetail(advancedDetail)}`
        : classified.userMessage,
    );
  }

  private async recordSuccessfulReleasePointers(deploymentId: string): Promise<void> {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: {
        id: true,
        environmentId: true,
        usageClass: true,
        status: true,
      },
    });
    if (!deployment || deployment.usageClass !== 'REAL_EXECUTION') return;
    if (deployment.status !== DeploymentStatus.SUCCESS) return;
    const environment = await this.prisma.projectEnvironment.findUnique({
      where: { id: deployment.environmentId },
      select: { activeDeploymentId: true, previousDeploymentId: true },
    });
    if (!environment) return;
    const pointers = planReleasePointers({
      activeDeploymentId: environment.activeDeploymentId,
      previousDeploymentId: environment.previousDeploymentId,
      nextSuccessfulDeploymentId: deployment.id,
    });
    await this.prisma.projectEnvironment.update({
      where: { id: deployment.environmentId },
      data: {
        activeDeploymentId: pointers.activeDeploymentId,
        previousDeploymentId: pointers.previousDeploymentId,
      },
    });
  }

  private async trackDeploySuccess(deploymentId: string): Promise<void> {
    try {
      const deployment = await this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: {
          id: true,
          projectId: true,
          usageClass: true,
          project: { select: { workspaceId: true, workspace: { select: { ownerId: true } } } },
        },
      });
      if (!deployment || deployment.usageClass !== 'REAL_EXECUTION') return;
      await this.prisma.productEvent.create({
        data: {
          name: 'DEPLOY_SUCCESS',
          userId: deployment.project.workspace.ownerId,
          workspaceId: deployment.project.workspaceId,
          projectId: deployment.projectId,
          metadata: { deploymentId: deployment.id },
        },
      });
    } catch {
      // Analytics must never block deployment completion.
    }
  }

  private async trackDeployFailed(
    deploymentId: string,
    errorMessage: string,
    failureCode: string,
  ): Promise<void> {
    try {
      const deployment = await this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: {
          id: true,
          projectId: true,
          usageClass: true,
          project: { select: { workspaceId: true, workspace: { select: { ownerId: true } } } },
        },
      });
      if (!deployment || deployment.usageClass !== 'REAL_EXECUTION') return;
      await this.prisma.productEvent.create({
        data: {
          name: 'DEPLOY_FAILED',
          userId: deployment.project.workspace.ownerId,
          workspaceId: deployment.project.workspaceId,
          projectId: deployment.projectId,
          metadata: {
            deploymentId: deployment.id,
            errorMessage: String(errorMessage || '').slice(0, 200),
            failureCode: String(failureCode || '').slice(0, 80),
          },
        },
      });
    } catch {
      // Analytics must never block deployment failure handling.
    }
  }

  private async setUploadStatus(
    deploymentId: string,
    status: RemoteUploadStatus,
    errorMessage?: string,
  ): Promise<void> {
    const now = new Date();
    const current = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { uploadStartedAt: true },
    });
    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        uploadStatus: status,
        uploadError: status === RemoteUploadStatus.FAILED ? errorMessage ?? '上传失败' : null,
        uploadStartedAt:
          status === RemoteUploadStatus.PREPARING || status === RemoteUploadStatus.UPLOADING
            ? (current?.uploadStartedAt ?? now)
            : current?.uploadStartedAt,
        uploadFinishedAt:
          status === RemoteUploadStatus.COMPLETED || status === RemoteUploadStatus.FAILED
            ? now
            : null,
      },
    });
  }

  private async reuseArtifactId(deploymentId: string): Promise<string | null> {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { sourceArtifactId: true },
    });
    return deployment?.sourceArtifactId ?? null;
  }

  private async markNewServiceInstancesFailedOnDeployFailure(
    deploymentId: string,
    options?: { healthFailed?: boolean; containerExited?: boolean },
  ): Promise<void> {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: {
        status: true,
        projectId: true,
        deployableUnitId: true,
        serverInstanceId: true,
        createdAt: true,
      },
    });
    if (!deployment) return;

    const next = resolveFailedServiceInstanceStatus({
      deploymentFailed: true,
      containerExited: Boolean(options?.containerExited),
      healthFailed: Boolean(options?.healthFailed),
      currentStatus: 'RUNNING',
    });
    if (!next) return;

    // Only mark instances created for this deployment attempt (CREATING/RUNNING on same unit),
    // never touch previous healthy revisions on other servers.
    await this.prisma.serviceInstance.updateMany({
      where: {
        projectId: deployment.projectId,
        ...(deployment.deployableUnitId
          ? { deployableUnitId: deployment.deployableUnitId }
          : {}),
        ...(deployment.serverInstanceId
          ? { serverInstanceId: deployment.serverInstanceId }
          : { serverInstanceId: null }),
        status: { in: [ServiceStatus.CREATING, ServiceStatus.RUNNING] },
        createdAt: { gte: deployment.createdAt },
        healthStatus: { in: [HealthStatus.UNHEALTHY, HealthStatus.UNKNOWN, HealthStatus.HEALTHY] },
      },
      data: {
        status: ServiceStatus.FAILED,
        healthStatus: HealthStatus.UNHEALTHY,
        healthMessage: '部署失败，应用未保持运行',
      },
    });
  }

  private async skipStep(deploymentId: string, stepId: string, reason: string): Promise<void> {
    await this.prisma.deploymentStep.update({
      where: { id: stepId },
      data: {
        status: DeploymentStepStatus.SKIPPED,
        finishedAt: new Date(),
        errorMessage: null,
      },
    });
    await this.writeLog(deploymentId, stepId, 'info', reason);
  }

  private async copyReusedArtifact(
    deploymentId: string,
    stepId: string,
    sourceArtifactId: string,
  ): Promise<void> {
    const source = await this.prisma.artifact.findUnique({
      where: { id: sourceArtifactId },
    });
    if (!source || source.status !== ArtifactStatus.READY) {
      const message = '没有可回滚的上线包';
      await this.prisma.deploymentStep.update({
        where: { id: stepId },
        data: {
          status: DeploymentStepStatus.FAILED,
          finishedAt: new Date(),
          errorMessage: message,
        },
      });
      await this.writeLog(deploymentId, stepId, 'error', message);
      throw new DeploymentEngineError(message);
    }

    await this.prisma.artifact.create({
      data: {
        deploymentId,
        type: source.type,
        storagePath: source.storagePath,
        size: source.size,
        status: ArtifactStatus.READY,
      },
    });
    await this.prisma.deploymentStep.update({
      where: { id: stepId },
      data: {
        status: DeploymentStepStatus.SUCCESS,
        finishedAt: new Date(),
        command: 'reuse existing package',
        exitCode: 0,
      },
    });
    await this.writeLog(deploymentId, stepId, 'info', '已复用历史上线包，跳过重新构建');
  }

  private async finalizeApplicationVersion(
    deploymentId: string,
    status: ApplicationVersionStatus,
  ): Promise<void> {
    const version = await this.prisma.applicationVersion.findUnique({
      where: { deploymentId },
      select: { id: true, projectId: true },
    });
    if (!version) {
      return;
    }

    if (status === ApplicationVersionStatus.ACTIVE) {
      const current = await this.prisma.applicationVersion.findFirst({
        where: {
          projectId: version.projectId,
          status: ApplicationVersionStatus.ACTIVE,
          id: { not: version.id },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (current) {
        const deployment = await this.prisma.deployment.findUnique({
          where: { id: deploymentId },
          select: { sourceArtifactId: true },
        });
        if (deployment?.sourceArtifactId) {
          await this.prisma.applicationVersion.update({
            where: { id: current.id },
            data: { status: ApplicationVersionStatus.ROLLED_BACK },
          });
        }
      }
    }

    await this.prisma.applicationVersion.update({
      where: { id: version.id },
      data: { status },
    });
  }

  private async extractTar(tarPath: string, targetDir: string): Promise<void> {
    await mkdir(targetDir, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const child = spawn('tar', ['-xf', tarPath, '-C', targetDir], { windowsHide: true });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        reject(error);
      });
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new DeploymentEngineError(stderr.trim() || '无法解开上线包'));
      });
    });
  }

  private async cleanupBuildOutput(deploymentId: string): Promise<void> {
    const local = this.buildOutputs.get(deploymentId);
    if (!local) {
      return;
    }
    await unlink(local.path).catch(() => undefined);
    this.buildOutputs.delete(deploymentId);
  }

  private async recordBuildResult(
    deploymentId: string,
    stepId: string,
    result: CommandResult,
  ): Promise<void> {
    const success = result.exitCode === 0;
    const secrets = await this.secretsForRedaction(deploymentId);
    await this.prisma.deploymentStep.update({
      where: { id: stepId },
      data: {
        command: redactSecrets(result.command, secrets.values, secrets.keys),
        exitCode: result.exitCode,
        duration: result.duration,
        status: success ? DeploymentStepStatus.SUCCESS : DeploymentStepStatus.FAILED,
        finishedAt: new Date(),
        errorMessage: success ? null : `exit code ${result.exitCode}`,
      },
    });

    const output = result.logs.trim().length > 0 ? result.logs : '(no output)';
    await this.writeLog(deploymentId, stepId, success ? 'info' : 'error', truncateLog(output));
  }

  private rememberSecrets(deploymentId: string, secrets: string[]): void {
    const existing = this.deploymentSecrets.get(deploymentId) ?? [];
    const merged = [...existing];
    for (const secret of secrets) {
      if (secret && !merged.includes(secret)) {
        merged.push(secret);
      }
    }
    this.deploymentSecrets.set(deploymentId, merged);
  }

  private async secretsForRedaction(deploymentId: string): Promise<{
    values: string[];
    keys: string[];
  }> {
    const remembered = this.deploymentSecrets.get(deploymentId) ?? [];
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { projectId: true },
    });
    const secrets = [...remembered];
    const keys: string[] = [];
    if (deployment?.projectId) {
      const rows = await this.prisma.runtimeConfigValue.findMany({
        where: { projectId: deployment.projectId, isSensitive: true },
        select: { key: true, valueEncrypted: true },
      });
      for (const row of rows) {
        keys.push(row.key);
        try {
          const value = decryptCredential(row.valueEncrypted);
          if (value && !secrets.includes(value)) {
            secrets.push(value);
          }
        } catch {
          // ignore
        }
      }
    }
    return { values: secrets, keys };
  }

  private async persistConfigMetadata(
    deploymentId: string,
    resolved: { revision: number; fingerprint: string; keys: string[] },
  ): Promise<void> {
    const keysMeta = resolved.keys.filter(
      (key) => !['PORT', 'NODE_ENV', 'HOST', 'HOSTNAME'].includes(key),
    );
    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        configRevision: resolved.revision,
        configFingerprint: resolved.fingerprint,
        configKeys: keysMeta,
      },
    });
    await this.prisma.applicationVersion.updateMany({
      where: { deploymentId },
      data: {
        configRevision: resolved.revision,
        configFingerprint: resolved.fingerprint,
        configKeys: keysMeta,
      },
    });
  }

  private async configMetadataForService(deploymentId: string): Promise<{
    configRevision: number | null;
    configFingerprint: string | null;
    configKeys?: string[];
  }> {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { configRevision: true, configFingerprint: true, configKeys: true },
    });
    const keys = Array.isArray(deployment?.configKeys)
      ? (deployment.configKeys as string[])
      : undefined;
    return {
      configRevision: deployment?.configRevision ?? null,
      configFingerprint: deployment?.configFingerprint ?? null,
      ...(keys ? { configKeys: keys } : {}),
    };
  }

  private async publishColocatedGateway(input: {
    deploymentId: string;
    stepId: string;
    projectId: string;
    slug: string;
    deployableUnitId: string | null;
    unitLabel: string | null | undefined;
    port: number;
    server: {
      host: string;
      port: number;
      username: string;
      credentialEncrypted: string;
      scope: string | null;
    };
  }): Promise<void> {
    const unitCount = await this.prisma.deployableUnit.count({
      where: { projectId: input.projectId },
    });
    const systemDomain = await this.domainManager.createSystemDomain(input.projectId, input.slug, {
      deployableUnitId: input.deployableUnitId,
      unitLabel: unitCount > 1 ? input.unitLabel : null,
    });
    await this.domainManager.activateGatewayRouting(systemDomain.domain);
    await this.domainManager.bindRuntime(systemDomain.domain, {
      host: '127.0.0.1',
      port: input.port,
    });

    const zone = readSystemDomainZone();
    const publicAlias = `${String(input.slug || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')}.${zone}`;
    const hostnames = new Set<string>([systemDomain.domain.toLowerCase()]);
    const unitLabel = String(input.unitLabel || '').trim().toUpperCase();
    const isPrimaryPublicAlias =
      unitCount <= 1 ||
      unitLabel === 'WEB' ||
      unitLabel === 'ADMIN' ||
      unitLabel === 'FRONTEND' ||
      unitLabel === 'STATIC';
    if (publicAlias && publicAlias !== systemDomain.domain.toLowerCase() && isPrimaryPublicAlias) {
      hostnames.add(publicAlias);
      await this.prisma.applicationDomain.upsert({
        where: { domain: publicAlias },
        create: {
          projectId: input.projectId,
          deployableUnitId: input.deployableUnitId,
          domain: publicAlias,
          type: 'CUSTOM',
          status: 'ACTIVE',
          dnsStatus: 'PENDING',
          sslStatus: 'PENDING',
          runtimeHost: '127.0.0.1',
          runtimePort: input.port,
        },
        update: {
          projectId: input.projectId,
          status: 'ACTIVE',
          runtimeHost: '127.0.0.1',
          runtimePort: input.port,
          deployableUnitId: input.deployableUnitId,
        },
      });
    }
    // Only bind domains that belong to this unit (or unscoped). Never retarget a sibling
    // unit's api-/web- hostname onto this container — that breaks multi-unit VERIFY.
    const extra = await this.prisma.applicationDomain.findMany({
      where: {
        projectId: input.projectId,
        status: 'ACTIVE',
        type: { in: ['CUSTOM', 'SYSTEM'] },
        ...(input.deployableUnitId
          ? {
              OR: [
                { deployableUnitId: input.deployableUnitId },
                { deployableUnitId: null },
              ],
            }
          : {}),
      },
      select: { domain: true, deployableUnitId: true },
    });
    for (const item of extra) {
      const domain = item.domain?.trim().toLowerCase();
      if (!domain) continue;
      if (
        input.deployableUnitId &&
        item.deployableUnitId &&
        item.deployableUnitId !== input.deployableUnitId
      ) {
        continue;
      }
      // Guard: never let a non-API unit claim an api-* hostname.
      if (!unitLabel.includes('API') && domain.startsWith('api-')) {
        continue;
      }
      // Guard: never let an API unit claim an explicit web-* hostname.
      if (unitLabel.includes('API') && domain.startsWith('web-')) {
        continue;
      }
      hostnames.add(domain);
    }

    if (String(input.server.scope || '').toUpperCase() === 'PLATFORM_MANAGED') {
      const password = decryptCredential(input.server.credentialEncrypted);
      const expectedIp =
        readGatewayPublicIp() ||
        (await this.prisma.systemDomainConfig.findFirst({
          orderBy: { createdAt: 'asc' },
          select: { gatewayPublicIp: true },
        }))?.gatewayPublicIp?.trim() ||
        input.server.host;

      const previousPorts = new Map<string, number>();
      for (const hostname of hostnames) {
        if (hostname.endsWith('.launchos.app') || hostname === 'launchos.app') {
          await this.writeLog(
            input.deploymentId,
            input.stepId,
            'warn',
            `Skip uncontrolled hostname ${hostname}; configure LAUNCHOS_SYSTEM_DOMAIN`,
          );
          continue;
        }

        const existingRoute = await this.prisma.gatewayRoute.findUnique({
          where: { hostname },
          select: { targetPort: true },
        });
        if (existingRoute?.targetPort) {
          previousPorts.set(hostname, existingRoute.targetPort);
        }

        const dnsReady = await ensurePublicDnsReady({
          prisma: this.prisma,
          hostname,
          expectedIp,
          onLog: async (message) => {
            await this.writeLog(input.deploymentId, input.stepId, 'info', message);
          },
        });
        await this.writeLog(
          input.deploymentId,
          input.stepId,
          dnsReady.matched ? 'info' : 'warn',
          `[PUBLIC_DNS] ${hostname} reused=${dnsReady.reused} matched=${dnsReady.matched} ${dnsReady.detail} addrs=${dnsReady.addresses.join(',') || 'none'}`,
        );
        if (!dnsReady.matched) {
          throw new DeploymentEngineError(
            `DNS_FAILED:首次域名解析未就绪 ${hostname} expected=${expectedIp} addrs=${dnsReady.addresses.join(',') || 'none'}`,
          );
        }

        const applied = await applyColocatedNginxRoute({
          host: input.server.host,
          port: input.server.port,
          username: input.server.username,
          password,
          hostname,
          targetPort: input.port,
          healthPath: '/',
        });
        if (
          applied.certificatePresent &&
          certificateCoversHostname({ sans: [`*.${zone}`], hostname })
        ) {
          await this.prisma.applicationDomain.updateMany({
            where: { projectId: input.projectId, domain: hostname },
            data: { sslStatus: ApplicationSslStatus.ACTIVE },
          });
        }
        await this.writeLog(
          input.deploymentId,
          input.stepId,
          'info',
          `Gateway route ${hostname} -> 127.0.0.1:${input.port} nginx reload PASS`,
        );
        if (input.deployableUnitId) {
          const healthPath = hostname.startsWith('api-') ? '/health' : '/';
          await this.prisma.gatewayRoute.upsert({
            where: { hostname },
            create: {
              projectId: input.projectId,
              unitId: input.deployableUnitId,
              hostname,
              scheme: 'https',
              targetHost: '127.0.0.1',
              targetPort: input.port,
              healthPath,
              status: 'ACTIVE',
              isDefault: !hostname.startsWith('api-'),
            },
            update: {
              projectId: input.projectId,
              unitId: input.deployableUnitId,
              targetHost: '127.0.0.1',
              targetPort: input.port,
              healthPath,
              status: 'ACTIVE',
              scheme: 'https',
            },
          });
        }
      }

      // Prefer primary non-api hostname for final public VERIFY gate.
      const publicHost =
        [...hostnames].find((h) => !h.startsWith('api-') && !h.endsWith('.launchos.app')) ||
        [...hostnames].find((h) => !h.endsWith('.launchos.app')) ||
        null;
      if (!publicHost) {
        throw new DeploymentEngineError(
          'PUBLIC_ENTRY_FAILED:无可用公网域名（系统域名未配置或仍为 launchos.app）',
        );
      }
      const verify = await verifyPublicEntryWithRetry({
        hostname: publicHost,
        path: publicHost.startsWith('api-') ? '/health' : '/',
        expectedIp,
        acceptStatuses: publicHost.startsWith('api-')
          ? [200, 201, 204]
          : [200, 201, 204, 301, 302, 307, 308],
        attempts: 8,
        backoffMs: 5_000,
      });
      await this.writeLog(
        input.deploymentId,
        input.stepId,
        verify.ok ? 'info' : 'error',
        `[PUBLIC_VERIFY] ${publicHost} ok=${verify.ok} code=${verify.failureCode || 'OK'} http=${verify.httpStatus ?? 'none'} dns=${verify.dnsCorrect} addrs=${verify.dnsAddresses.join(',') || 'none'}`,
      );
      if (!verify.ok) {
        // Safe release: roll gateway back to previous healthy upstream before failing.
        for (const [hostname, prevPort] of previousPorts) {
          if (prevPort === input.port) continue;
          try {
            await applyColocatedNginxRoute({
              host: input.server.host,
              port: input.server.port,
              username: input.server.username,
              password,
              hostname,
              targetPort: prevPort,
              healthPath: '/',
            });
            await this.prisma.gatewayRoute.updateMany({
              where: { hostname },
              data: { targetHost: '127.0.0.1', targetPort: prevPort, status: 'ACTIVE' },
            });
            await this.writeLog(
              input.deploymentId,
              input.stepId,
              'warn',
              `[SAFE_RELEASE] rollback ${hostname} -> 127.0.0.1:${prevPort}`,
            );
          } catch (rollbackError) {
            const detail =
              rollbackError instanceof Error ? rollbackError.message : 'rollback failed';
            await this.writeLog(
              input.deploymentId,
              input.stepId,
              'error',
              `[SAFE_RELEASE] rollback failed ${hostname}: ${detail}`,
            );
          }
        }
        const layer =
          !verify.dnsCorrect
            ? 'DNS_READY'
            : !verify.tcp443 || !verify.tlsOk
              ? 'HTTPS_READY'
              : 'PUBLIC_VERIFY_READY';
        throw new DeploymentEngineError(
          `PUBLIC_VERIFY_FAILED:${layer}:${verify.failureCode || 'UNKNOWN'}:${publicHost}:http=${verify.httpStatus ?? 'none'}`,
        );
      }
      await markDomainDnsFromPublicResolve(this.prisma, publicHost, expectedIp).catch(() => undefined);
    }
    await new SystemDomainService(this.prisma).syncGatewayRoutes().catch(() => undefined);
  }

  private async resolveLocalInjectEnv(
    deploymentId: string,
    projectId: string,
    deployableUnitId: string | null | undefined,
    containerPort: number,
  ): Promise<{ env?: Record<string, string>; buildEnv?: Record<string, string> }> {
    if (!deployableUnitId) {
      return {};
    }
    const buildResolved = await this.runtimeConfigResolver.resolve({
      projectId,
      deployableUnitId,
      phase: 'BUILD',
    });
    const runtimeResolved = await this.runtimeConfigResolver.resolve({
      projectId,
      deployableUnitId,
      phase: 'RUNTIME',
      containerPort,
    });
    this.rememberSecrets(deploymentId, [
      ...buildResolved.secretPlaintexts,
      ...runtimeResolved.secretPlaintexts,
    ]);
    await this.persistConfigMetadata(deploymentId, runtimeResolved);
    return { env: runtimeResolved.env, buildEnv: buildResolved.env };
  }

  private async writeLog(
    deploymentId: string,
    stepId: string | null,
    level: string,
    message: string,
  ): Promise<void> {
    const secrets = await this.secretsForRedaction(deploymentId);
    const safeMessage = redactSecrets(message, secrets.values, secrets.keys);
    await this.prisma.deploymentLog.create({
      data: {
        deploymentId,
        stepId,
        level,
        message: safeMessage,
      },
    });
    await this.touchActivity(deploymentId);
  }
}

function resolveDeployRuntimeMode(input: {
  isDemo: boolean;
  gitUrl: string;
  framework: string | null;
}): RuntimeMode {
  if (readRuntimeMode() === 'mock') {
    return 'mock';
  }
  if (input.isDemo || isPlaceholderGitUrl(input.gitUrl)) {
    return 'mock';
  }
  if (isDockerSupportedFramework(input.framework)) {
    return 'docker';
  }
  return 'mock';
}

function visibleRemoteTarget(server: { scope?: string | null; host: string; port: number }): string {
  if (String(server.scope || '').toUpperCase() === 'PLATFORM_MANAGED') return 'managed-node';
  return `${server.host}:${server.port}`;
}

function dockerRuntimeName(framework?: string | null): string {
  const value = framework?.toUpperCase();
  if (value === 'NEXTJS') {
    return 'nextjs';
  }
  if (value === 'VITE') {
    return 'vite';
  }
  return 'nodejs';
}

function dockerImageTag(projectId: string, deploymentId: string): string {
  const project = projectId.replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase() || 'app';
  const deploy = deploymentId.replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase() || 'latest';
  return `launchos/${project}:${deploy}`;
}

function truncateLog(message: string): string {
  const limit = 16_000;
  if (message.length <= limit) {
    return message;
  }
  return `${message.slice(0, limit)}\n...[truncated]`;
}

function readUploadTimeoutMs(): number {
  const raw = Number(process.env.LAUNCHOS_UPLOAD_TIMEOUT_MS ?? '');
  if (Number.isFinite(raw) && raw >= 60_000) {
    return raw;
  }
  return 30 * 60 * 1000;
}

function readStepTimeoutMs(): number {
  const raw = Number(process.env.LAUNCHOS_DEPLOY_STEP_TIMEOUT_MS ?? '');
  if (Number.isFinite(raw) && raw >= 60_000) {
    return raw;
  }
  return 45 * 60 * 1000;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new DeploymentEngineError(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function injectedFailureMessage(sourceUrl?: string): string | null {
  if (!sourceUrl) {
    return null;
  }
  const value = sourceUrl.toLowerCase();
  if (value.includes('module-not-found')) {
    return "Module not found: Can't resolve 'express'";
  }
  if (value.includes('database_url') || value.includes('database-url')) {
    return 'DATABASE_URL missing';
  }
  if (value.includes('port-error') || value.includes('port error')) {
    return 'port error: listen EADDRINUSE: address already in use :::3000';
  }
  if (value.includes('container-exit') || value.includes('container exit')) {
    return 'container exit with code 1';
  }
  return null;
}
