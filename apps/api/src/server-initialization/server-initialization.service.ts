import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { WorkspaceRole, type Prisma } from '@launchos/database';
import {
  SERVER_INIT_PHASE_LABELS,
  SERVER_INIT_PROGRESS,
  SERVER_INIT_READINESS_LABELS,
  asServerInitMeta,
  buildServerInitializationPlan,
  canStartServerInitialization,
  decryptCredential,
  isEncryptedCredential,
  redactSecrets,
  resolveServerSshUsername,
  serverInitializationJobId,
  serverInitializationLockKey,
  serverInitializationUserMessage,
  tryAcquireRedisLock,
  type ServerInitializationPhase,
} from '@launchos/shared';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import { ServerInitializationQueueService } from '../queue/server-initialization-queue.service';
import { WorkerPresenceService } from '../queue/worker-presence.service';

const WRITE_ROLES: WorkspaceRole[] = [WorkspaceRole.OWNER, WorkspaceRole.ADMIN];
const OLD_SERVER_IP = '8.138.113.134';

@Injectable()
export class ServerInitializationService {
  private readonly logger = new Logger(ServerInitializationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaceAccess: WorkspaceAccessService,
    private readonly queue: ServerInitializationQueueService,
    private readonly workerPresence: WorkerPresenceService,
  ) {}

  async initialize(userId: string, projectId: string, serverInstanceId: string) {
    const { membership, project } = await this.workspaceAccess.requireProjectAccess(
      userId,
      projectId,
    );
    if (!WRITE_ROLES.includes(membership.role)) {
      throw new BadRequestException('无权限初始化服务器');
    }

    const ctx = await this.loadContext(project.workspaceId, projectId, serverInstanceId);

    if (ctx.server.status === 'READY') {
      return {
        alreadyReady: true,
        alreadyInProgress: false,
        serverInstanceId: ctx.server.id,
        serverReadiness: 'READY',
        serverReadinessLabel: SERVER_INIT_READINESS_LABELS.READY,
        phase: 'READY' as const,
        phaseLabel: SERVER_INIT_PHASE_LABELS.READY,
        progress: 100,
        jobId: serverInitializationJobId(ctx.server.id),
      };
    }

    if (ctx.server.status === 'INITIALIZING') {
      return {
        alreadyReady: false,
        alreadyInProgress: true,
        serverInstanceId: ctx.server.id,
        serverReadiness: 'INITIALIZING',
        serverReadinessLabel: SERVER_INIT_READINESS_LABELS.INITIALIZING,
        phase: (ctx.meta.phase || 'CONNECTING') as ServerInitializationPhase,
        phaseLabel: SERVER_INIT_PHASE_LABELS[(ctx.meta.phase || 'CONNECTING') as ServerInitializationPhase],
        progress: SERVER_INIT_PROGRESS[(ctx.meta.phase || 'CONNECTING') as ServerInitializationPhase] ?? 10,
        jobId: serverInitializationJobId(ctx.server.id),
      };
    }

    if (!canStartServerInitialization(ctx.server.status)) {
      throw new BadRequestException(
        `当前状态不可初始化：${ctx.server.status}`,
      );
    }

    this.assertInitializeGates(ctx);

    const queueProbe = await this.queue.probeReadiness(ctx.server.id);
    if (!queueProbe.redisReady || !queueProbe.serverInitializationQueueReady) {
      this.logger.error(
        redactSecrets(
          JSON.stringify({
            code: queueProbe.errorCode || 'SERVER_INITIALIZATION_QUEUE_UNAVAILABLE',
            operation: 'queue.probeReadiness',
            redisReady: queueProbe.redisReady,
            serverInitializationQueueReady: queueProbe.serverInitializationQueueReady,
            errorMessage: queueProbe.errorMessage,
          }),
        ),
      );
      throw new ServiceUnavailableException({
        statusCode: 503,
        message: '服务器初始化服务暂时不可用，请稍后重试。',
        code: queueProbe.errorCode || 'SERVER_INITIALIZATION_QUEUE_UNAVAILABLE',
        failedOperation: 'queue.probeReadiness',
        diagnosis: {
          redisReady: queueProbe.redisReady,
          serverInitializationQueueReady: queueProbe.serverInitializationQueueReady,
        },
      });
    }

    const presence = await this.workerPresence.getOnlineConsumer('serverInitialization');
    if (!presence.online || !presence.queueReady.serverInitialization) {
      const code = !presence.online
        ? 'SERVER_INITIALIZATION_WORKER_OFFLINE'
        : 'SERVER_INITIALIZATION_WORKER_CONSUMER_UNAVAILABLE';
      this.logger.error(
        redactSecrets(
          JSON.stringify({
            code,
            operation: 'workerPresence.serverInitialization',
            workerOnline: presence.online,
            workerId: presence.workerId,
            consumedQueues: presence.consumedQueues,
            queueReady: presence.queueReady,
            lastSeenAt: presence.lastSeenAt,
          }),
        ),
      );
      throw new ServiceUnavailableException({
        statusCode: 503,
        message: '服务器初始化服务暂时不可用，请稍后重试。',
        code,
        failedOperation: 'workerPresence.serverInitialization',
        diagnosis: {
          workerOnline: presence.online,
          workerConsumerReady: Boolean(presence.queueReady.serverInitialization),
          consumedQueues: presence.consumedQueues,
        },
      });
    }

    let lockProbe;
    try {
      lockProbe = await tryAcquireRedisLock(
        serverInitializationLockKey(ctx.server.id),
        5_000,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        redactSecrets(
          JSON.stringify({
            code: 'SERVER_INITIALIZATION_LOCK_UNAVAILABLE',
            operation: 'tryAcquireRedisLock',
            errorMessage: message,
          }),
        ),
      );
      throw new ServiceUnavailableException({
        statusCode: 503,
        message: '服务器初始化服务暂时不可用，请稍后重试。',
        code: 'SERVER_INITIALIZATION_LOCK_UNAVAILABLE',
        failedOperation: 'tryAcquireRedisLock',
      });
    }
    if (!lockProbe) {
      return {
        alreadyReady: false,
        alreadyInProgress: true,
        serverInstanceId: ctx.server.id,
        serverReadiness: ctx.server.status,
        serverReadinessLabel:
          SERVER_INIT_READINESS_LABELS[
            ctx.server.status as keyof typeof SERVER_INIT_READINESS_LABELS
          ] || ctx.server.status,
        phase: ctx.meta.phase || 'PENDING_INITIALIZATION',
        phaseLabel:
          SERVER_INIT_PHASE_LABELS[
            (ctx.meta.phase || 'PENDING_INITIALIZATION') as ServerInitializationPhase
          ],
        progress: 0,
        jobId: serverInitializationJobId(ctx.server.id),
      };
    }
    await lockProbe.release();

    const operationId = `sinit-${randomUUID().slice(0, 12)}`;
    let enqueued;
    try {
      enqueued = await this.queue.enqueue({
        serverInstanceId: ctx.server.id,
        projectId,
        workspaceId: project.workspaceId,
        operationId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack =
        error instanceof Error ? redactSecrets(error.stack || '').slice(0, 800) : undefined;
      this.logger.error(
        redactSecrets(
          JSON.stringify({
            code: 'SERVER_INITIALIZATION_ENQUEUE_FAILED',
            operation: 'queue.enqueue',
            errorClass: error?.constructor?.name,
            errorMessage: message,
            stack,
          }),
        ),
      );
      throw new ServiceUnavailableException({
        statusCode: 503,
        message: '服务器初始化服务暂时不可用，请稍后重试。',
        code: 'SERVER_INITIALIZATION_ENQUEUE_FAILED',
        failedOperation: 'queue.enqueue',
      });
    }

    if (enqueued.alreadyInProgress) {
      return {
        alreadyReady: false,
        alreadyInProgress: true,
        serverInstanceId: ctx.server.id,
        serverReadiness: 'INITIALIZING',
        serverReadinessLabel: SERVER_INIT_READINESS_LABELS.INITIALIZING,
        phase: 'CONNECTING' as const,
        phaseLabel: SERVER_INIT_PHASE_LABELS.CONNECTING,
        progress: 10,
        jobId: enqueued.jobId,
      };
    }

    const nextMeta = {
      ...ctx.meta,
      initializationId: operationId,
      phase: 'PENDING_INITIALIZATION' as const,
      status: 'PENDING' as const,
      progress: 0,
      startedAt: new Date().toISOString(),
      completedAt: null,
      failedAt: null,
      errorCode: null,
      errorMessage: null,
      failedPhase: null,
      failedOperation: null,
      cloudResourceId: ctx.cloudResource?.id || null,
      providerResourceId: ctx.providerResourceId,
      privateIp: ctx.privateIp,
      passwordPresent: ctx.credentialReady,
      passwordLength: ctx.passwordLength,
    };

    await this.prisma.serverInstance.update({
      where: { id: ctx.server.id },
      data: {
        status: 'INITIALIZING',
        metadata: nextMeta as Prisma.InputJsonObject,
      },
    });

    return {
      alreadyReady: false,
      alreadyInProgress: false,
      serverInstanceId: ctx.server.id,
      serverReadiness: 'INITIALIZING',
      serverReadinessLabel: SERVER_INIT_READINESS_LABELS.INITIALIZING,
      phase: 'PENDING_INITIALIZATION' as const,
      phaseLabel: SERVER_INIT_PHASE_LABELS.PENDING_INITIALIZATION,
      progress: 0,
      jobId: enqueued.jobId,
      publicIp: ctx.publicIp,
      retryActionLabel: null,
    };
  }

  async getStatus(userId: string, projectId: string, serverInstanceId?: string) {
    const { project } = await this.workspaceAccess.requireProjectAccess(userId, projectId);

    let server;
    if (serverInstanceId) {
      server = await this.prisma.serverInstance.findFirst({
        where: { id: serverInstanceId, workspaceId: project.workspaceId },
      });
      if (!server) throw new NotFoundException('服务器实例不存在');
    } else {
      server = await this.prisma.serverInstance.findFirst({
        where: {
          workspaceId: project.workspaceId,
          provider: 'ALIYUN',
          status: {
            in: [
              'READY_FOR_INITIALIZATION',
              'INITIALIZING',
              'READY',
              'INITIALIZATION_FAILED',
            ],
          },
        },
        orderBy: { updatedAt: 'desc' },
      });
      if (!server) {
        return {
          found: false,
          serverInstanceId: null,
          serverReadiness: null,
          phase: null,
        };
      }
    }

    const meta = asServerInitMeta(server.metadata);
    const phase = (meta.phase ||
      (server.status === 'READY'
        ? 'READY'
        : server.status === 'INITIALIZATION_FAILED'
          ? 'FAILED'
          : 'PENDING_INITIALIZATION')) as ServerInitializationPhase;
    const job = await this.queue.getJobState(server.id);

    return {
      found: true,
      serverInstanceId: server.id,
      publicIp: server.host,
      serverReadiness: server.status,
      serverReadinessLabel:
        SERVER_INIT_READINESS_LABELS[
          server.status as keyof typeof SERVER_INIT_READINESS_LABELS
        ] || server.status,
      phase,
      phaseLabel: SERVER_INIT_PHASE_LABELS[phase] || phase,
      progress: meta.progress ?? SERVER_INIT_PROGRESS[phase] ?? 0,
      lastSuccessfulPhase: meta.lastSuccessfulPhase || null,
      osName: meta.osName || null,
      runtimeType: meta.runtimeType || null,
      runtimeVersion: meta.runtimeVersion || null,
      dockerCompatibility: meta.dockerCompatibility ?? null,
      firewallStatus: meta.firewallStatus || null,
      launchosRoot: meta.launchosRoot || null,
      dynamicPortRangeStart: meta.dynamicPortRangeStart ?? null,
      dynamicPortRangeEnd: meta.dynamicPortRangeEnd ?? null,
      bindAddress: meta.bindAddress || null,
      errorCode: meta.errorCode || null,
      errorMessage: meta.errorMessage || null,
      failedPhase: meta.failedPhase || null,
      failedOperation: meta.failedOperation || null,
      retryActionLabel:
        server.status === 'INITIALIZATION_FAILED' ? '重新初始化服务器' : null,
      jobId: job.jobId,
      jobState: job.state,
      passwordPresent: Boolean(meta.passwordPresent),
      productSteps: this.productSteps(phase, server.status === 'INITIALIZATION_FAILED'),
    };
  }

  private productSteps(phase: ServerInitializationPhase, failed: boolean) {
    const steps: Array<{ key: ServerInitializationPhase; label: string }> = [
      { key: 'CONNECTING', label: '连接服务器' },
      { key: 'DETECTING_SYSTEM', label: '检查服务器环境' },
      { key: 'PREPARING_DIRECTORIES', label: '准备运行环境' },
      { key: 'CONFIGURING_FIREWALL', label: '配置安全规则' },
      { key: 'VERIFYING_RUNTIME', label: '检查运行环境' },
    ];
    const order: ServerInitializationPhase[] = [
      'CONNECTING',
      'DETECTING_SYSTEM',
      'PREPARING_DIRECTORIES',
      'INSTALLING_RUNTIME',
      'CONFIGURING_FIREWALL',
      'CONFIGURING_RUNTIME',
      'VERIFYING_RUNTIME',
      'READY',
    ];
    const idx = order.indexOf(phase === 'FAILED' ? 'CONNECTING' : phase);
    return steps.map((s) => {
      const sIdx = order.indexOf(s.key);
      const reached = phase === 'READY' || (idx >= 0 && sIdx >= 0 && sIdx <= idx);
      return {
        label: s.label,
        reached: phase === 'READY' ? true : reached,
        failed: failed && sIdx === idx,
      };
    });
  }

  private assertInitializeGates(ctx: Awaited<ReturnType<ServerInitializationService['loadContext']>>) {
    const blockers: string[] = [];
    if (!ctx.providerResourceId) blockers.push('providerResourceId missing');
    if (!ctx.publicIp) blockers.push('publicIp missing');
    if (ctx.server.provider !== 'ALIYUN') blockers.push('provider must be ALIYUN');
    if (!ctx.credentialReady) blockers.push('credentialReady=false');
    if (ctx.publicIp === OLD_SERVER_IP) blockers.push('old server must not be targeted');
    if (blockers.length) {
      throw new BadRequestException({
        message: '无法初始化服务器',
        code: 'INITIALIZE_BLOCKED',
        blockers,
        userMessage: blockers.includes('credentialReady=false')
          ? serverInitializationUserMessage('CREDENTIAL_MISSING')
          : '服务器尚未满足初始化条件',
      });
    }
  }

  private async loadContext(workspaceId: string, projectId: string, serverInstanceId: string) {
    const server = await this.prisma.serverInstance.findFirst({
      where: { id: serverInstanceId, workspaceId },
    });
    if (!server) throw new NotFoundException('服务器实例不存在');

    const linkedByMeta = await this.prisma.cloudResource.findMany({
      where: { workspaceId, projectId },
      orderBy: { updatedAt: 'desc' },
      take: 40,
    });
    let linked =
      linkedByMeta.find((r) => {
        const m =
          r.metadata && typeof r.metadata === 'object' && !Array.isArray(r.metadata)
            ? (r.metadata as Record<string, unknown>)
            : {};
        return m.serverInstanceId === server.id;
      }) || null;
    if (!linked) {
      linked =
        (await this.prisma.cloudResource.findFirst({
          where: {
            workspaceId,
            projectId,
            publicIp: server.host,
          },
          orderBy: { updatedAt: 'desc' },
        })) || null;
    }

    const crMeta =
      linked?.metadata && typeof linked.metadata === 'object' && !Array.isArray(linked.metadata)
        ? (linked.metadata as Record<string, unknown>)
        : {};
    const providerResourceId =
      linked?.providerResourceId ||
      (typeof crMeta.instanceId === 'string' ? crMeta.instanceId : null);
    const privateIp =
      typeof crMeta.privateIp === 'string'
        ? crMeta.privateIp
        : typeof crMeta.PrivateIpAddress === 'string'
          ? crMeta.PrivateIpAddress
          : null;
    const imageName =
      typeof crMeta.imageId === 'string'
        ? crMeta.imageId
        : typeof crMeta.imageName === 'string'
          ? crMeta.imageName
          : null;

    let credentialReady = false;
    let passwordLength = 0;
    const enc = server.credentialEncrypted?.trim() || '';
    if (enc && isEncryptedCredential(enc)) {
      try {
        const plain = decryptCredential(enc);
        credentialReady = plain.length > 0;
        passwordLength = plain.length;
      } catch {
        credentialReady = false;
      }
    }

    const username = resolveServerSshUsername({
      serverUsername: server.username,
      imageName,
      provider: server.provider,
    });

    const meta = asServerInitMeta(server.metadata);
    const plan = buildServerInitializationPlan({
      publicIp: server.host,
      privateIp,
      providerResourceId,
      username,
      passwordPresent: credentialReady,
    });

    return {
      server,
      cloudResource: linked,
      providerResourceId,
      publicIp: server.host,
      privateIp,
      imageName,
      credentialReady,
      passwordLength,
      username,
      meta,
      plan,
    };
  }
}
