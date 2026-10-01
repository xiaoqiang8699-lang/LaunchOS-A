import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CloudResourceStatus,
  CloudResourceType,
  Prisma,
  WorkspaceRole,
} from '@launchos/database';
import {
  DATABASE_PROVISION_PHASE_LABELS,
  DATABASE_PROVISION_QUEUE_STALL_USER_MESSAGE,
  QUEUE_STALL_MS,
  cloudDatabaseErrorUserMessage,
  databaseProvisionJobId,
  encryptCredential,
  generateManagedDbPassword,
  generateManagedDbUsername,
  sanitizeDatabaseName,
  type CloudDatabaseErrorCode,
  type DatabaseProvisionPhase,
  type DatabaseProvisionTier,
} from '@launchos/shared';
import { AlibabaCloudDatabaseProvider } from '@launchos/providers';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { ProviderAccountsService } from '../provider-accounts/provider-accounts.service';
import { ALIYUN_PROVIDER_TYPE } from '../provider-accounts/dto/create-provider-account.dto';
import { DatabaseConnectionsService } from '../database-connections/database-connections.service';
import { DatabaseProvisionQueueService } from '../queue/database-provision-queue.service';
import { WorkerPresenceService } from '../queue/worker-presence.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import type {
  CreateDatabaseProvisionDto,
  DeleteDatabaseProvisionDto,
} from './dto/database-provision.dto';

const SECRET_WRITE_ROLES: WorkspaceRole[] = [WorkspaceRole.OWNER, WorkspaceRole.ADMIN];

type Meta = {
  resourceKind?: string;
  operationId?: string;
  phase?: DatabaseProvisionPhase;
  phases?: Array<{ phase: DatabaseProvisionPhase; at: string; status: string }>;
  tier?: DatabaseProvisionTier;
  databaseName?: string;
  username?: string;
  passwordEncrypted?: string;
  unitIds?: string[];
  region?: string;
  networkMode?: string;
  vpcId?: string;
  vSwitchId?: string;
  connectionHost?: string;
  connectionPort?: number;
  databaseConnectionId?: string;
  errorCode?: string;
  errorMessage?: string;
  technicalMessage?: string;
  providerRequestId?: string;
  providerErrorCode?: string;
  serverInstanceId?: string;
  displayName?: string;
  retryingAt?: string;
  attemptStartedAt?: string;
  createInstanceCompleted?: boolean;
  errorHistory?: Array<Record<string, unknown>>;
  reconciledFromProvider?: boolean;
};

@Injectable()
export class DatabaseProvisionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaceAccess: WorkspaceAccessService,
    private readonly providerAccounts: ProviderAccountsService,
    private readonly databaseConnections: DatabaseConnectionsService,
    private readonly queue: DatabaseProvisionQueueService,
    private readonly workerPresence: WorkerPresenceService,
  ) {}

  async getOptions(userId: string, projectId: string) {
    const { membership, project } = await this.workspaceAccess.requireProjectAccess(
      userId,
      projectId,
    );
    const region = await this.suggestRegion(project.workspaceId, projectId);
    const eligibleUnits = await this.databaseConnections.listEligibleUnitsPublic(projectId);
    let specs: Array<{ tier: string; label: string; instanceClass: string; storageGb: number }> = [
      { tier: 'DEV', label: '开发测试', instanceClass: '自动选择', storageGb: 20 },
      { tier: 'SMALL', label: '小型生产', instanceClass: '自动选择', storageGb: 50 },
      { tier: 'STANDARD', label: '标准生产', instanceClass: '自动选择', storageGb: 100 },
    ];
    try {
      const account = await this.requireAliyunAccount(project.workspaceId);
      const secrets = await this.providerAccounts.decryptSecrets(account.credentialEncrypted);
      const provider = new AlibabaCloudDatabaseProvider({
        accessKey: secrets.accessKey,
        secretKey: secrets.secretKey,
        region,
      });
      const available = await provider.listAvailableSpecs(region);
      specs = available.map((item) => ({
        tier: item.tier,
        label: item.label,
        instanceClass: item.instanceClass,
        storageGb: item.storageGb,
      }));
    } catch {
      // keep static tiers when credentials missing
    }

    return {
      canEdit: SECRET_WRITE_ROLES.includes(membership.role),
      engine: 'PostgreSQL',
      suggestedRegion: region,
      suggestedDatabaseName: sanitizeDatabaseName(project.slug),
      eligibleUnits,
      tiers: specs,
      billingNotice:
        '将会在你的阿里云账号中创建并产生费用。实际费用以阿里云账单为准。',
      costHint: '预计规格与计费方式以阿里云控制台为准（按量付费）。',
    };
  }

  async create(userId: string, projectId: string, dto: CreateDatabaseProvisionDto) {
    const { membership, project } = await this.workspaceAccess.requireProjectAccess(
      userId,
      projectId,
    );
    this.requireWrite(membership.role);
    if (!dto.confirmBilling) {
      throw new BadRequestException('请确认将在阿里云账号产生费用');
    }

    const existing = await this.prisma.cloudResource.findFirst({
      where: {
        projectId,
        type: CloudResourceType.DATABASE,
        status: { in: [CloudResourceStatus.CREATING, CloudResourceStatus.RUNNING] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existing?.status === CloudResourceStatus.CREATING) {
      throw new BadRequestException({
        message: '数据库正在创建中',
        code: 'DATABASE_PROVISION_IN_PROGRESS',
        cloudResourceId: existing.id,
      });
    }
    if (existing?.status === CloudResourceStatus.RUNNING) {
      return await this.toPublicStatus(existing);
    }

    const failedRecoverable = await this.prisma.cloudResource.findFirst({
      where: {
        projectId,
        type: CloudResourceType.DATABASE,
        status: CloudResourceStatus.FAILED,
        providerResourceId: { not: null },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (failedRecoverable) {
      return this.retry(userId, projectId, failedRecoverable.id);
    }

    await this.databaseConnections.assertUnitsForProvision(
      projectId,
      dto.unitIds,
      dto.confirmReplaceManual,
    );

    const account = await this.requireAliyunAccount(project.workspaceId);
    if (account.provider.type !== ALIYUN_PROVIDER_TYPE) {
      throw new BadRequestException({
        message: '数据库创建只能使用阿里云云资源账户，不能使用 DNS 账户。',
        code: 'WRONG_PROVIDER_TYPE',
      });
    }

    const readiness = await this.providerAccounts.getCapabilities(
      userId,
      account.id,
    );
    const createStatus =
      (readiness.capabilities as { rds?: { actions?: { create?: string }; status?: string } })
        .rds?.actions?.create ||
      (readiness.capabilities as { rds?: { status?: string } }).rds?.status;
    if (createStatus === 'MISSING_PERMISSION' || createStatus === 'NOT_CONFIGURED') {
      throw new BadRequestException({
        message: '当前阿里云账号缺少数据库创建权限。',
        code: 'RDS_PERMISSION_DENIED',
        missingCapabilities:
          (readiness.capabilities as { rds?: { missingCapabilities?: string[] } }).rds
            ?.missingCapabilities || ['创建数据库'],
        action: 'CHECK_ALIYUN_PERMISSIONS',
      });
    }

    const region = dto.region?.trim() || (await this.suggestRegion(project.workspaceId, projectId));
    const databaseName = sanitizeDatabaseName(
      dto.databaseName || project.slug,
      `app_${project.slug}`,
    );
    const username = generateManagedDbUsername(project.slug);
    const password = generateManagedDbPassword();
    const operationId = `op_${randomBytes(8).toString('hex')}`;

    const created = await this.prisma.cloudResource.create({
      data: {
        workspaceId: project.workspaceId,
        projectId,
        providerId: account.providerId,
        type: CloudResourceType.DATABASE,
        externalId: 'pending',
        providerResourceId: null,
        region,
        instanceType: dto.tier,
        status: CloudResourceStatus.CREATING,
        metadata: {
          resourceKind: 'RDS_POSTGRESQL',
          displayName: 'PostgreSQL 数据库',
          operationId,
          phase: 'QUEUED',
          phases: [{ phase: 'QUEUED', at: new Date().toISOString(), status: 'running' }],
          tier: dto.tier,
          databaseName,
          username,
          passwordEncrypted: encryptCredential(password),
          unitIds: [...new Set(dto.unitIds)],
          region,
          serverInstanceId: dto.serverInstanceId || null,
        } as Prisma.InputJsonObject,
      },
    });

    await this.queue.enqueue(created.id, operationId);
    return await this.toPublicStatus(created);
  }

  async getStatus(userId: string, projectId: string, id: string) {
    await this.workspaceAccess.requireProjectAccess(userId, projectId);
    const resource = await this.requireProjectDatabase(projectId, id);
    return await this.toPublicStatus(resource);
  }

  async list(userId: string, projectId: string) {
    await this.workspaceAccess.requireProjectAccess(userId, projectId);
    const rows = await this.prisma.cloudResource.findMany({
      where: { projectId, type: CloudResourceType.DATABASE },
      orderBy: { createdAt: 'desc' },
    });
    const resources = [];
    for (const item of rows) {
      resources.push(await this.toPublicStatus(item));
    }
    return { resources };
  }

  async retry(userId: string, projectId: string, id: string) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    this.requireWrite(membership.role);
    const resource = await this.requireProjectDatabase(projectId, id);

    if (
      resource.status === CloudResourceStatus.RUNNING ||
      resource.status === CloudResourceStatus.DELETED ||
      resource.status === CloudResourceStatus.DELETING
    ) {
      throw new BadRequestException('当前数据库状态不可重试');
    }

    const jobState = await this.queue.getJobState(resource.id);
    if (jobState === 'waiting' || jobState === 'active' || jobState === 'delayed') {
      // Already in flight — return current status without double enqueue.
      return await this.toPublicStatus(resource);
    }

    if (resource.status === CloudResourceStatus.CREATING && jobState === 'active') {
      throw new BadRequestException('数据库正在创建中');
    }

    // Only recover FAILED (or CREATING left without an active job, e.g. stalled).
    if (
      resource.status !== CloudResourceStatus.FAILED &&
      resource.status !== CloudResourceStatus.CREATING
    ) {
      throw new BadRequestException('当前数据库状态不可重试');
    }

    const meta = asMeta(resource.metadata);
    // Always reuse original operationId / clientToken for Aliyun idempotency.
    const operationId =
      typeof meta.operationId === 'string' && meta.operationId.trim()
        ? meta.operationId.trim()
        : `op_${randomBytes(8).toString('hex')}`;

    const resumeWithoutCreate =
      Boolean(resource.providerResourceId?.trim()) || meta.createInstanceCompleted === true;
    const resumePhase = resumeWithoutCreate ? 'PREPARING_NETWORK' : 'QUEUED';

    // Preserve prior failure codes in errorHistory before clearing active error fields.
    const priorHistory = Array.isArray(meta.errorHistory) ? [...meta.errorHistory] : [];
    if (meta.errorCode || meta.providerErrorCode || meta.errorMessage) {
      priorHistory.push({
        code: meta.errorCode || meta.providerErrorCode || 'UNKNOWN',
        providerErrorCode: meta.providerErrorCode || null,
        message: meta.errorMessage || null,
        providerRequestId: meta.providerRequestId || null,
        retainedAt: new Date().toISOString(),
        from: 'retry_snapshot',
      });
    }

    const updated = await this.prisma.cloudResource.update({
      where: { id: resource.id },
      data: {
        status: CloudResourceStatus.CREATING,
        // Keep providerResourceId as-is so resume skips CreateDBInstance when present.
        metadata: {
          ...meta,
          operationId,
          phase: resumePhase,
          errorCode: null,
          errorMessage: null,
          technicalMessage: null,
          providerErrorCode: null,
          providerRequestId: null,
          errorHistory: priorHistory,
          createInstanceCompleted:
            resumeWithoutCreate || meta.createInstanceCompleted === true,
          retryingAt: new Date().toISOString(),
          attemptStartedAt: new Date().toISOString(),
          phases: [
            ...(meta.phases || []),
            { phase: resumePhase, at: new Date().toISOString(), status: 'running' },
          ],
        } as Prisma.InputJsonObject,
      },
    });
    await this.queue.enqueue(updated.id, operationId);
    return await this.toPublicStatus(updated);
  }

  async unlink(userId: string, projectId: string, id: string) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    this.requireWrite(membership.role);
    const resource = await this.requireProjectDatabase(projectId, id);
    const connections = await this.prisma.databaseConnection.findMany({
      where: { cloudResourceId: resource.id },
    });
    for (const connection of connections) {
      await this.databaseConnections.unlinkManaged(userId, projectId, connection.id);
    }
    const meta = asMeta(resource.metadata);
    await this.prisma.cloudResource.update({
      where: { id: resource.id },
      data: {
        metadata: {
          ...meta,
          databaseConnectionId: null,
          unboundAt: new Date().toISOString(),
        } as Prisma.InputJsonObject,
      },
    });
    return {
      message: '已解除绑定。云数据库仍保留在阿里云，不会被删除。',
      cloudResourceId: resource.id,
    };
  }

  async destroy(userId: string, projectId: string, id: string, dto: DeleteDatabaseProvisionDto) {
    const { membership, project } = await this.workspaceAccess.requireProjectAccess(
      userId,
      projectId,
    );
    this.requireWrite(membership.role);
    if (!dto.confirmDestroy) {
      throw new BadRequestException(
        '删除云数据库会永久删除其中的数据，且无法通过 LaunchOS 恢复。请确认。',
      );
    }
    const resource = await this.requireProjectDatabase(projectId, id);
    const meta = asMeta(resource.metadata);
    await this.prisma.cloudResource.update({
      where: { id: resource.id },
      data: {
        status: CloudResourceStatus.DELETING,
        metadata: {
          ...meta,
          phase: 'FAILED',
          deletingAt: new Date().toISOString(),
        } as Prisma.InputJsonObject,
      },
    });

    const connections = await this.prisma.databaseConnection.findMany({
      where: { cloudResourceId: resource.id },
    });
    for (const connection of connections) {
      await this.databaseConnections.markUnavailable(userId, projectId, connection.id);
    }

    if (resource.providerResourceId) {
      try {
        const account = await this.requireAliyunAccount(project.workspaceId);
        const secrets = await this.providerAccounts.decryptSecrets(account.credentialEncrypted);
        const provider = new AlibabaCloudDatabaseProvider({
          accessKey: secrets.accessKey,
          secretKey: secrets.secretKey,
          region: resource.region || meta.region || 'cn-hangzhou',
        });
        await provider.deleteInstance(resource.providerResourceId);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'delete failed';
        await this.prisma.cloudResource.update({
          where: { id: resource.id },
          data: {
            status: CloudResourceStatus.FAILED,
            metadata: {
              ...meta,
              errorCode: 'PROVIDER_ERROR',
              errorMessage: message,
            } as Prisma.InputJsonObject,
          },
        });
        throw new BadRequestException('删除云数据库失败，请稍后在阿里云控制台确认。');
      }
    }

    const deleted = await this.prisma.cloudResource.update({
      where: { id: resource.id },
      data: {
        status: CloudResourceStatus.DELETED,
        metadata: {
          ...meta,
          databaseConnectionId: null,
          deletedAt: new Date().toISOString(),
        } as Prisma.InputJsonObject,
      },
    });
    return await this.toPublicStatus(deleted);
  }

  private async toPublicStatus(resource: {
    id: string;
    status: CloudResourceStatus;
    region: string | null;
    instanceType: string | null;
    providerResourceId: string | null;
    metadata: unknown;
    createdAt: Date;
    updatedAt: Date;
  }) {
    const meta = asMeta(resource.metadata);
    const phase = (meta.phase || 'QUEUED') as DatabaseProvisionPhase;
    const queueHint = await this.resolveQueueHint(resource);
    const errorCode = (meta.errorCode as CloudDatabaseErrorCode | undefined) || null;
    let technicalForUi =
      meta.technicalMessage || meta.providerErrorCode || meta.errorMessage || null;
    let providerErrorCode = meta.providerErrorCode || null;
    let providerRequestId = meta.providerRequestId || null;
    if (resource.status === CloudResourceStatus.FAILED) {
      const latestJobReason = await this.queue.getFailedReason(resource.id).catch(() => null);
      if (latestJobReason) {
        technicalForUi = latestJobReason;
        const codeMatch = latestJobReason.match(
          /\b(ServiceLinkedRole\.NotExist|InvalidConcurrentOperate|[A-Za-z]+(?:\.[A-Za-z]+)+)\b/,
        );
        const reqMatch = latestJobReason.match(/request id:\s*([A-Za-z0-9-]+)/i);
        if (codeMatch?.[1]) providerErrorCode = codeMatch[1];
        if (reqMatch?.[1]) providerRequestId = reqMatch[1];
      }
    }
    const errorMessage =
      resource.status === CloudResourceStatus.FAILED || meta.errorMessage
        ? cloudDatabaseErrorUserMessage(
            (errorCode as CloudDatabaseErrorCode) || 'PROVIDER_ERROR',
            technicalForUi,
          )
        : null;
    const attemptStartedAt = meta.retryingAt || meta.attemptStartedAt || null;
    const currentAction = resolveCurrentAction(phase, resource.status, queueHint);
    const lastActivityAt = resource.updatedAt;
    const elapsedSeconds = Math.max(
      0,
      Math.floor(
        (Date.now() -
          (attemptStartedAt ? Date.parse(attemptStartedAt) : resource.createdAt.getTime())) /
          1000,
      ),
    );
    const staleStep =
      resource.status === CloudResourceStatus.CREATING &&
      Date.now() - resource.updatedAt.getTime() > 60_000;
    return {
      id: resource.id,
      displayName: meta.displayName || 'PostgreSQL 数据库',
      resourceType: 'PostgreSQL 数据库',
      status: mapUserStatus(resource.status, phase, queueHint),
      statusRaw: resource.status,
      phase,
      phaseLabel:
        queueHint === 'QUEUE_STALLED' || queueHint === 'CONSUMER_OFFLINE'
          ? DATABASE_PROVISION_QUEUE_STALL_USER_MESSAGE
          : currentAction,
      steps: buildSteps(phase, resource.status, {
        phases: meta.phases,
        attemptStartedAt,
      }),
      region: resource.region || meta.region || null,
      tier: meta.tier || resource.instanceType || null,
      databaseName: meta.databaseName || null,
      usernameConfigured: Boolean(meta.username),
      networkMode: meta.networkMode || null,
      connectionHost: meta.connectionHost || null,
      connectionPort: meta.connectionPort || null,
      databaseConnectionId: meta.databaseConnectionId || null,
      providerResourceId: resource.providerResourceId,
      errorCode: errorCode || (queueHint === 'QUEUE_STALLED' ? 'QUEUE_STALLED' : null),
      errorMessage,
      providerRequestId,
      providerErrorCode,
      canRetry:
        resource.status === CloudResourceStatus.FAILED ||
        (resource.status === CloudResourceStatus.CREATING &&
          (queueHint === 'QUEUE_STALLED' || queueHint === 'CONSUMER_OFFLINE')),
      queueHint,
      jobId: databaseProvisionJobId(resource.id),
      currentAction,
      attemptStartedAt,
      elapsedSeconds,
      lastActivityAt,
      lastActivityLabel: formatActivityAgo(lastActivityAt),
      staleStepHint: staleStep
        ? '这一步比平时需要更长时间，LaunchOS 仍在等待云服务响应。'
        : null,
      createdAt: resource.createdAt,
      updatedAt: resource.updatedAt,
    };
  }

  /**
   * Detect waiting jobs that never start when consumer is offline/stalled.
   * Does not mark CloudResource FAILED — waiting jobs remain recoverable.
   */
  private async resolveQueueHint(resource: {
    id: string;
    status: CloudResourceStatus;
    providerResourceId: string | null;
    metadata: unknown;
    updatedAt: Date;
    createdAt: Date;
  }): Promise<'OK' | 'WAITING' | 'QUEUE_STALLED' | 'CONSUMER_OFFLINE' | null> {
    if (resource.status !== CloudResourceStatus.CREATING) return null;
    const meta = asMeta(resource.metadata);
    const phase = (meta.phase || 'QUEUED') as DatabaseProvisionPhase;
    if (phase !== 'QUEUED' && resource.providerResourceId) return 'OK';

    const [jobState, presence, paused] = await Promise.all([
      this.queue.getJobState(resource.id),
      this.workerPresence.getOnlineConsumer('databaseProvision'),
      this.queue.isPaused(),
    ]);
    const consumerReady = presence.online && presence.queueReady.databaseProvision && !paused;
    const waitingTooLong =
      Date.now() - (resource.updatedAt?.getTime?.() || resource.createdAt.getTime()) >
      QUEUE_STALL_MS;

    if (jobState === 'active') return 'OK';
    if (jobState === 'waiting' || jobState === 'delayed' || phase === 'QUEUED') {
      if (!consumerReady) return waitingTooLong ? 'QUEUE_STALLED' : 'CONSUMER_OFFLINE';
      if (waitingTooLong && jobState === 'waiting') return 'QUEUE_STALLED';
      return 'WAITING';
    }
    return null;
  }

  private async requireProjectDatabase(projectId: string, id: string) {
    const resource = await this.prisma.cloudResource.findFirst({
      where: { id, projectId, type: CloudResourceType.DATABASE },
    });
    if (!resource) throw new NotFoundException('未找到数据库资源');
    return resource;
  }

  private async suggestRegion(workspaceId: string, projectId: string): Promise<string> {
    const server = await this.prisma.cloudResource.findFirst({
      where: {
        projectId,
        type: CloudResourceType.SERVER,
        status: CloudResourceStatus.RUNNING,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (server?.region) return server.region;
    const account = await this.prisma.providerAccount.findFirst({
      where: { workspaceId, status: 'ACTIVE', provider: { type: ALIYUN_PROVIDER_TYPE } },
      orderBy: { createdAt: 'asc' },
    });
    return account?.region?.trim() || process.env.ALIYUN_REGION?.trim() || 'cn-hangzhou';
  }

  private async requireAliyunAccount(workspaceId: string) {
    const existing = await this.prisma.providerAccount.findFirst({
      where: {
        workspaceId,
        status: 'ACTIVE',
        provider: { type: ALIYUN_PROVIDER_TYPE },
      },
      include: { provider: true },
      orderBy: { createdAt: 'asc' },
    });
    if (existing) {
      // Hard rule: never treat ALIYUN_DNS as cloud resource credentials.
      if (existing.provider.type !== ALIYUN_PROVIDER_TYPE) {
        throw new BadRequestException('请先配置阿里云云资源账户（ProviderAccount ALIYUN）');
      }
      return existing;
    }

    // Env fallback creates ALIYUN only — never ALIYUN_DNS.
    const accessKey = process.env.ALIYUN_ACCESS_KEY_ID?.trim();
    const secretKey = process.env.ALIYUN_ACCESS_KEY_SECRET?.trim();
    const region = process.env.ALIYUN_REGION?.trim() || 'cn-hangzhou';
    if (!accessKey || !secretKey) {
      throw new BadRequestException({
        message: '请先配置阿里云云资源账户（ProviderAccount ALIYUN）',
        code: 'ALIYUN_ACCOUNT_MISSING',
        action: 'CHECK_ALIYUN_PERMISSIONS',
      });
    }
    const provider = await this.prisma.provider.upsert({
      where: { type: ALIYUN_PROVIDER_TYPE },
      create: { name: 'Aliyun', type: ALIYUN_PROVIDER_TYPE },
      update: {},
    });
    const { encryptProviderSecrets } = await import('../security/credential-cipher');
    return this.prisma.providerAccount.create({
      data: {
        workspaceId,
        providerId: provider.id,
        label: 'Aliyun',
        region,
        status: 'ACTIVE',
        credentialEncrypted: encryptProviderSecrets({ accessKey, secretKey }),
      },
      include: { provider: true },
    });
  }

  private requireWrite(role: WorkspaceRole) {
    if (!SECRET_WRITE_ROLES.includes(role)) {
      throw new ForbiddenException('无权限创建或管理云数据库');
    }
  }
}

function asMeta(value: unknown): Meta {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Meta;
  }
  return {};
}

function mapUserStatus(
  status: CloudResourceStatus,
  phase?: DatabaseProvisionPhase,
  queueHint?: string | null,
): string {
  if (status === CloudResourceStatus.CREATING) {
    if (queueHint === 'QUEUE_STALLED' || queueHint === 'CONSUMER_OFFLINE') {
      return '创建服务暂不可用';
    }
    if (phase === 'QUEUED') {
      return '等待开始';
    }
    return '正在创建';
  }
  switch (status) {
    case CloudResourceStatus.RUNNING:
      return '可用';
    case CloudResourceStatus.FAILED:
      return '创建失败';
    case CloudResourceStatus.DELETING:
      return '正在删除';
    case CloudResourceStatus.DELETED:
      return '已删除';
    default:
      return status;
  }
}

const STEP_ORDER: DatabaseProvisionPhase[] = [
  'CREATING_INSTANCE',
  'PREPARING_NETWORK',
  'CREATING_ACCOUNT',
  'TESTING_CONNECTION',
  'BINDING',
];

const STEP_LABELS = [
  '创建云数据库',
  '准备网络',
  '创建数据库账号',
  '测试数据库连接',
  '绑定应用',
];

function resolveProgressPhase(
  phase: DatabaseProvisionPhase,
  options?: {
    phases?: Array<{ phase: DatabaseProvisionPhase; at: string; status: string }>;
    attemptStartedAt?: string | null;
  },
): DatabaseProvisionPhase {
  if (phase !== 'FAILED' && phase !== 'DONE') {
    return phase;
  }
  const attemptStart = options?.attemptStartedAt
    ? Date.parse(options.attemptStartedAt)
    : Number.NaN;
  const events = (options?.phases || []).filter((event) => {
    if (!Number.isFinite(attemptStart)) return true;
    const at = Date.parse(event.at);
    return Number.isFinite(at) ? at >= attemptStart - 2000 : true;
  });
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const candidate = events[i]?.phase;
    if (candidate && STEP_ORDER.includes(candidate)) {
      return candidate;
    }
  }
  return 'QUEUED';
}

function buildSteps(
  phase: DatabaseProvisionPhase,
  status: CloudResourceStatus,
  options?: {
    phases?: Array<{ phase: DatabaseProvisionPhase; at: string; status: string }>;
    attemptStartedAt?: string | null;
  },
) {
  const progressPhase = resolveProgressPhase(phase, options);
  const currentIndex =
    progressPhase === 'QUEUED' ? -1 : STEP_ORDER.indexOf(progressPhase);
  const failed = status === CloudResourceStatus.FAILED;

  return STEP_ORDER.map((item, index) => {
    let state: 'pending' | 'running' | 'done' | 'failed' = 'pending';
    if (phase === 'DONE' || status === CloudResourceStatus.RUNNING) {
      state = 'done';
    } else if (failed) {
      if (currentIndex < 0) {
        state = index === 0 ? 'failed' : 'pending';
      } else if (index < currentIndex) {
        state = 'done';
      } else if (index === currentIndex) {
        state = 'failed';
      } else {
        state = 'pending';
      }
    } else if (currentIndex < 0) {
      state = 'pending';
    } else if (index < currentIndex) {
      state = 'done';
    } else if (index === currentIndex) {
      state = 'running';
    }
    return { key: item, label: STEP_LABELS[index], status: state };
  });
}

function resolveCurrentAction(
  phase: DatabaseProvisionPhase,
  status: CloudResourceStatus,
  queueHint?: string | null,
): string {
  if (queueHint === 'QUEUE_STALLED' || queueHint === 'CONSUMER_OFFLINE') {
    return DATABASE_PROVISION_QUEUE_STALL_USER_MESSAGE;
  }
  if (status === CloudResourceStatus.FAILED || phase === 'FAILED') {
    return '数据库创建失败';
  }
  if (status === CloudResourceStatus.RUNNING || phase === 'DONE') {
    return '数据库已就绪';
  }
  switch (phase) {
    case 'QUEUED':
      return '等待重试任务开始…';
    case 'CREATING_INSTANCE':
      return '正在创建 PostgreSQL 数据库…';
    case 'PREPARING_NETWORK':
      return '正在配置数据库网络…';
    case 'CREATING_ACCOUNT':
      return '正在创建数据库账号…';
    case 'TESTING_CONNECTION':
      return '正在测试数据库连接…';
    case 'BINDING':
      return '正在绑定 API 服务…';
    default:
      return DATABASE_PROVISION_PHASE_LABELS[phase] || '正在处理数据库任务…';
  }
}

function formatActivityAgo(at: Date): string {
  const seconds = Math.max(0, Math.floor((Date.now() - at.getTime()) / 1000));
  if (seconds < 10) return '刚刚';
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时前`;
}
