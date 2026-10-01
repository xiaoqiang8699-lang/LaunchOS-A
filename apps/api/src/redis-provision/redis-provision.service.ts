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
  REDIS_PROVISION_PHASE_LABELS,
  REDIS_PROVISION_QUEUE_STALL_USER_MESSAGE,
  QUEUE_STALL_MS,
  REDIS_BILLING_EXTRA_VALIDATION_NOTICE,
  advanceRedisCreateGeneration,
  classifyRedisCreateFailureKind,
  cloudRedisErrorUserMessage,
  formatRedisPriceHint,
  redisProvisionJobId,
  encryptCredential,
  generateManagedRedisPassword,
  newRedisOperationId,
  peekCurrentRedisCreateGeneration,
  sanitizeRedisInstanceName,
  shouldRotateRedisCreateClientToken,
  type CloudRedisErrorCode,
  type RedisCreateFailureKind,
  type RedisCreateGeneration,
  type RedisProvisionPhase,
  type RedisProvisionTier,
} from '@launchos/shared';
import { AlibabaCloudRedisProvider } from '@launchos/providers';
import { PrismaService } from '../database/prisma.service';
import { ProviderAccountsService } from '../provider-accounts/provider-accounts.service';
import { ALIYUN_PROVIDER_TYPE } from '../provider-accounts/dto/create-provider-account.dto';
import { RedisConnectionsService } from '../redis-connections/redis-connections.service';
import { RedisProvisionQueueService } from '../queue/redis-provision-queue.service';
import { WorkerPresenceService } from '../queue/worker-presence.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import type {
  CreateRedisProvisionDto,
  DeleteRedisProvisionDto,
} from './dto/redis-provision.dto';

const SECRET_WRITE_ROLES: WorkspaceRole[] = [WorkspaceRole.OWNER, WorkspaceRole.ADMIN];

type Meta = {
  resourceKind?: string;
  operationId?: string;
  phase?: RedisProvisionPhase;
  phases?: Array<{ phase: RedisProvisionPhase; at: string; status: string }>;
  tier?: RedisProvisionTier;
  instanceClass?: string;
  engineVersion?: string;
  storageType?: string;
  capacityMb?: number;
  zoneId?: string;
  architecture?: string;
  selectionReason?: string;
  fallbackReason?: string;
  availabilityFingerprint?: string;
  resolvedSku?: {
    tier: RedisProvisionTier;
    instanceClass: string;
    engineVersion: string;
    storageType: string;
    capacityMb?: number;
    zoneId?: string;
    architecture?: string;
    selectionReason?: string;
    fallbackReason?: string;
    availabilityFingerprint?: string;
  };
  instanceName?: string;
  username?: string;
  passwordEncrypted?: string;
  unitIds?: string[];
  region?: string;
  networkMode?: string;
  vpcId?: string;
  vSwitchId?: string;
  connectionHost?: string;
  connectionPort?: number;
  redisConnectionId?: string;
  errorCode?: string;
  errorMessage?: string;
  technicalMessage?: string;
  providerRequestId?: string;
  providerErrorCode?: string;
  providerErrorMessage?: string;
  httpStatus?: number | null;
  failedOperation?: string;
  retryableAfterUserAction?: boolean;
  serverInstanceId?: string;
  displayName?: string;
  retryingAt?: string;
  attemptStartedAt?: string;
  createInstanceCompleted?: boolean;
  createInstanceAttemptCount?: number;
  createInstanceSuccessCount?: number;
  createInstanceCallCount?: number;
  createGeneration?: number;
  createGenerations?: RedisCreateGeneration[];
  generationAttemptCount?: number;
  generationSuccessCount?: number;
  createFailureKind?: RedisCreateFailureKind | null;
  previousOperationId?: string | null;
  clientTokenRotateReason?: string | null;
  errorHistory?: Array<Record<string, unknown>>;
  reconciledFromProvider?: boolean;
};

@Injectable()
export class RedisProvisionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaceAccess: WorkspaceAccessService,
    private readonly providerAccounts: ProviderAccountsService,
    private readonly redisConnections: RedisConnectionsService,
    private readonly queue: RedisProvisionQueueService,
    private readonly workerPresence: WorkerPresenceService,
  ) {}

  async getOptions(userId: string, projectId: string) {
    const { membership, project } = await this.workspaceAccess.requireProjectAccess(
      userId,
      projectId,
    );
    const region = await this.suggestRegion(project.workspaceId, projectId);
    const eligibleUnits = await this.redisConnections.listEligibleUnitsPublic(projectId);
    let specs: Array<{
      tier: string;
      label: string;
      instanceClass: string;
      engineVersion?: string;
      storageType?: string;
      capacityMb?: number;
      zoneId?: string;
      selectionReason?: string;
      fallbackReason?: string;
    }> = [
      { tier: 'DEV', label: '开发测试', instanceClass: '自动选择' },
      { tier: 'SMALL', label: '小型生产', instanceClass: '自动选择' },
      { tier: 'STANDARD', label: '标准生产', instanceClass: '自动选择' },
    ];
    try {
      const account = await this.requireAliyunAccount(project.workspaceId);
      const secrets = await this.providerAccounts.decryptSecrets(account.credentialEncrypted);
      const provider = new AlibabaCloudRedisProvider({
        accessKey: secrets.accessKey,
        secretKey: secrets.secretKey,
        region,
      });
      const available = await provider.listAvailableSpecs(region);
      specs = available.map((item) => ({
        tier: item.tier,
        label: item.label,
        instanceClass: item.instanceClass,
        engineVersion: item.engineVersion,
        storageType: item.storageType,
        capacityMb: item.capacityMb,
        zoneId: item.zoneId,
        selectionReason: item.selectionReason,
        fallbackReason: item.fallbackReason,
      }));
    } catch {
      // keep static tiers when credentials missing (no hardcoded engineVersion)
    }

    let priceEstimate: Record<string, unknown> | null = null;
    let billingReadiness: Record<string, unknown> | null = null;
    const preferred =
      specs.find((item) => item.tier === 'DEV' && item.instanceClass !== '自动选择') ||
      specs.find((item) => item.instanceClass !== '自动选择');
    if (preferred?.instanceClass && preferred.instanceClass !== '自动选择') {
      try {
        const account = await this.requireAliyunAccount(project.workspaceId);
        const secrets = await this.providerAccounts.decryptSecrets(account.credentialEncrypted);
        const provider = new AlibabaCloudRedisProvider({
          accessKey: secrets.accessKey,
          secretKey: secrets.secretKey,
          region,
        });
        const estimate = await provider.getPriceEstimate({
          region,
          zoneId: preferred.zoneId,
          instanceClass: preferred.instanceClass,
          engineVersion: preferred.engineVersion,
          capacityMb: preferred.capacityMb,
          storageType: preferred.storageType,
          chargeType: 'PostPaid',
        });
        priceEstimate = estimate as unknown as Record<string, unknown>;
        billingReadiness = provider.checkBillingReadiness({
          priceEstimate: estimate,
        }) as unknown as Record<string, unknown>;
      } catch {
        billingReadiness = {
          status: 'BALANCE_UNKNOWN',
          priceEstimate: null,
          canConfirmSufficientBalance: false,
          minimumBalanceRequirement: 'UNKNOWN',
          accountBalanceReadable: false,
          unpaidOrderCheck: 'UNKNOWN',
          unsettledBillCheck: 'UNKNOWN',
          reason: 'DescribePrice 暂时不可用，无法确认报价与账户余额。',
        };
      }
    }

    const costHint = formatRedisPriceHint({
      tradePrice: (priceEstimate?.tradePrice as string | null) || null,
      hourlyPrice: (priceEstimate?.hourlyPrice as string | null) || null,
      currency: (priceEstimate?.currency as string | null) || null,
      billingCycle: (priceEstimate?.billingCycle as string | null) || null,
      capacityMb: preferred?.capacityMb ?? null,
    });

    return {
      canEdit: SECRET_WRITE_ROLES.includes(membership.role),
      engine: 'Redis',
      suggestedRegion: region,
      suggestedInstanceName: sanitizeRedisInstanceName(project.slug),
      eligibleUnits,
      tiers: specs,
      firstUseNotice: '首次使用阿里云 Redis 可能需要完成云服务授权。',
      billingNotice:
        '将会在你的阿里云账号中创建 Redis 并产生费用。实际费用以阿里云账单为准。',
      costHint,
      billingExtraValidationNotice: REDIS_BILLING_EXTRA_VALIDATION_NOTICE,
      priceEstimate,
      billingReadiness,
      productSummary: preferred
        ? {
            title:
              preferred.tier === 'DEV'
                ? '开发测试 Redis'
                : preferred.label || '阿里云 Redis',
            capacityLabel:
              typeof preferred.capacityMb === 'number'
                ? `${Math.round(preferred.capacityMb / 1024)} GB`
                : null,
            chargeType: '按量付费',
            estimatedHourlyPrice: (priceEstimate?.hourlyPrice as string | null) || null,
            currency: (priceEstimate?.currency as string | null) || null,
          }
        : null,
    };
  }

  async create(userId: string, projectId: string, dto: CreateRedisProvisionDto) {
    const { membership, project } = await this.workspaceAccess.requireProjectAccess(
      userId,
      projectId,
    );
    this.requireWrite(membership.role);
    if (!dto.confirmBilling) {
      throw new BadRequestException('请确认将在阿里云账号产生费用');
    }

    // Explicit resume target (E2E / ops) — never invent a third FAILED CloudResource.
    if (dto.cloudResourceId?.trim()) {
      const target = await this.requireProjectCache(projectId, dto.cloudResourceId.trim());
      if (target.status === CloudResourceStatus.RUNNING) {
        return await this.toPublicStatus(target);
      }
      return this.retry(userId, projectId, target.id);
    }

    const existing = await this.prisma.cloudResource.findFirst({
      where: {
        projectId,
        type: CloudResourceType.CACHE,
        status: { in: [CloudResourceStatus.CREATING, CloudResourceStatus.RUNNING] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existing?.status === CloudResourceStatus.CREATING) {
      throw new BadRequestException({
        message: 'Redis 正在创建中',
        code: 'REDIS_PROVISION_IN_PROGRESS',
        cloudResourceId: existing.id,
      });
    }
    if (existing?.status === CloudResourceStatus.RUNNING) {
      return await this.toPublicStatus(existing);
    }

    // Resume latest FAILED CACHE even when providerResourceId is null (pre-create reject).
    const failedRecoverable = await this.prisma.cloudResource.findFirst({
      where: {
        projectId,
        type: CloudResourceType.CACHE,
        status: CloudResourceStatus.FAILED,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (failedRecoverable) {
      return this.retry(userId, projectId, failedRecoverable.id);
    }

    await this.redisConnections.assertUnitsForProvision(
      projectId,
      dto.unitIds,
      dto.confirmReplaceManual,
    );

    const account = await this.requireAliyunAccount(project.workspaceId);
    if (account.provider.type !== ALIYUN_PROVIDER_TYPE) {
      throw new BadRequestException({
        message: 'Redis 创建只能使用阿里云云资源账户，不能使用 DNS 账户。',
        code: 'WRONG_PROVIDER_TYPE',
      });
    }

    const readiness = await this.providerAccounts.getCapabilities(
      userId,
      account.id,
    );
    const createStatus =
      (readiness.capabilities as { redis?: { actions?: { create?: string }; status?: string } })
        .redis?.actions?.create ||
      (readiness.capabilities as { redis?: { status?: string } }).redis?.status;
    if (createStatus === 'MISSING_PERMISSION' || createStatus === 'NOT_CONFIGURED') {
      throw new BadRequestException({
        message: '当前阿里云账号缺少 Redis 创建权限。',
        code: 'REDIS_PERMISSION_DENIED',
        missingCapabilities:
          (readiness.capabilities as { redis?: { missingCapabilities?: string[] } }).redis
            ?.missingCapabilities || ['创建 Redis'],
        action: 'CHECK_ALIYUN_PERMISSIONS',
      });
    }

    const region = dto.region?.trim() || (await this.suggestRegion(project.workspaceId, projectId));
    const instanceName = sanitizeRedisInstanceName(dto.instanceName || project.slug);
    const password = generateManagedRedisPassword();
    const operationId = newRedisOperationId();
    const createdAtIso = new Date().toISOString();

    const secrets = await this.providerAccounts.decryptSecrets(account.credentialEncrypted);
    const provider = new AlibabaCloudRedisProvider({
      accessKey: secrets.accessKey,
      secretKey: secrets.secretKey,
      region,
    });
    const resolved = await this.resolveSkuForTier(provider, region, dto.tier);

    const created = await this.prisma.cloudResource.create({
      data: {
        workspaceId: project.workspaceId,
        projectId,
        providerId: account.providerId,
        type: CloudResourceType.CACHE,
        externalId: 'pending',
        providerResourceId: null,
        region,
        instanceType: dto.tier,
        status: CloudResourceStatus.CREATING,
        metadata: {
          resourceKind: 'ALIYUN_REDIS',
          displayName: '阿里云 Redis',
          operationId,
          createGeneration: 1,
          createGenerations: [
            {
              generation: 1,
              operationId,
              attemptCount: 0,
              successCount: 0,
              createdAt: createdAtIso,
              closedAt: null,
            },
          ],
          generationAttemptCount: 0,
          generationSuccessCount: 0,
          phase: 'QUEUED',
          phases: [{ phase: 'QUEUED', at: createdAtIso, status: 'running' }],
          ...resolved,
          tier: dto.tier,
          resolvedSku: resolved,
          instanceName,
          passwordEncrypted: encryptCredential(password),
          unitIds: [...new Set(dto.unitIds)],
          region,
          serverInstanceId: dto.serverInstanceId || null,
          createInstanceAttemptCount: 0,
          createInstanceSuccessCount: 0,
        } as Prisma.InputJsonObject,
      },
    });

    await this.queue.enqueue(created.id, operationId, {
      tier: resolved.tier,
      instanceClass: resolved.instanceClass,
      engineVersion: resolved.engineVersion,
      storageType: resolved.storageType,
      capacityMb: resolved.capacityMb,
      zoneId: resolved.zoneId,
      architecture: resolved.architecture,
      availabilityFingerprint: resolved.availabilityFingerprint,
    });
    return await this.toPublicStatus(created);
  }

  async getStatus(userId: string, projectId: string, id: string) {
    await this.workspaceAccess.requireProjectAccess(userId, projectId);
    const resource = await this.requireProjectCache(projectId, id);
    return await this.toPublicStatus(resource);
  }

  async list(userId: string, projectId: string) {
    await this.workspaceAccess.requireProjectAccess(userId, projectId);
    const rows = await this.prisma.cloudResource.findMany({
      where: { projectId, type: CloudResourceType.CACHE },
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
    const resource = await this.requireProjectCache(projectId, id);

    if (
      resource.status === CloudResourceStatus.RUNNING ||
      resource.status === CloudResourceStatus.DELETED ||
      resource.status === CloudResourceStatus.DELETING
    ) {
      throw new BadRequestException('当前 Redis 状态不可重试');
    }

    const jobState = await this.queue.getJobState(resource.id);
    if (jobState === 'waiting' || jobState === 'active' || jobState === 'delayed') {
      // Already in flight — return current status without double enqueue.
      return await this.toPublicStatus(resource);
    }

    if (resource.status === CloudResourceStatus.CREATING && jobState === 'active') {
      throw new BadRequestException('Redis 正在创建中');
    }

    // Only recover FAILED (or CREATING left without an active job, e.g. stalled).
    if (
      resource.status !== CloudResourceStatus.FAILED &&
      resource.status !== CloudResourceStatus.CREATING
    ) {
      throw new BadRequestException('当前 Redis 状态不可重试');
    }

    const meta = asMeta(resource.metadata);

    // Reconcile before any ClientToken decision (DescribeInstances by name).
    const account = await this.requireAliyunAccount(resource.workspaceId);
    const secrets = await this.providerAccounts.decryptSecrets(account.credentialEncrypted);
    const region = resource.region || meta.region || 'cn-hangzhou';
    const reconcileProvider = new AlibabaCloudRedisProvider({
      accessKey: secrets.accessKey,
      secretKey: secrets.secretKey,
      region,
    });
    const instanceName = String(meta.instanceName || '').trim();
    const reconcileIds = instanceName
      ? await reconcileProvider.listInstancesByName(region, instanceName)
      : [];
    const reconcileMatchCount = reconcileIds.length;

    if (reconcileMatchCount > 1) {
      throw new BadRequestException({
        message: `检测到多个同名 Redis（${reconcileIds.join(',')}），已禁止再次 CreateInstance。请人工确认后再继续。`,
        code: 'REDIS_RECONCILE_AMBIGUOUS',
        matchCount: reconcileMatchCount,
        instanceIds: reconcileIds,
      });
    }

    let claimedProviderResourceId: string | null = null;
    if (reconcileMatchCount === 1 && !resource.providerResourceId?.trim()) {
      claimedProviderResourceId = reconcileIds[0]!;
    }

    const failureKind: RedisCreateFailureKind | null =
      meta.createFailureKind ||
      (meta.errorCode || meta.providerErrorCode || meta.technicalMessage
        ? classifyRedisCreateFailureKind({
            errorCode: meta.errorCode,
            providerErrorCode: meta.providerErrorCode,
            technicalMessage: meta.technicalMessage,
            httpStatus: meta.httpStatus,
          })
        : null);

    const rotateDecision = shouldRotateRedisCreateClientToken({
      providerResourceId:
        resource.providerResourceId || claimedProviderResourceId || null,
      createInstanceCompleted: meta.createInstanceCompleted === true,
      reconcileMatchCount,
      failureKind,
      userRequestedRetry: true,
    });

    let operationId =
      typeof meta.operationId === 'string' && meta.operationId.trim()
        ? meta.operationId.trim()
        : newRedisOperationId();
    let createGeneration = Number(meta.createGeneration || 1);
    let createGenerations = Array.isArray(meta.createGenerations)
      ? meta.createGenerations
      : undefined;
    let previousOperationId: string | null = meta.previousOperationId || null;
    let generationAttemptCount = Number(meta.generationAttemptCount || 0);
    let generationSuccessCount = Number(meta.generationSuccessCount || 0);
    let clientTokenRotateReason: string | null = rotateDecision.reason;

    if (rotateDecision.rotate) {
      const current = peekCurrentRedisCreateGeneration(createGenerations);
      const closedAttemptCount =
        current && !current.closedAt
          ? Number(current.attemptCount || meta.generationAttemptCount || 0)
          : Number(
              meta.generationAttemptCount ??
                meta.createInstanceAttemptCount ??
                0,
            );
      const closedSuccessCount =
        current && !current.closedAt
          ? Number(current.successCount || meta.generationSuccessCount || 0)
          : Number(
              meta.generationSuccessCount ??
                meta.createInstanceSuccessCount ??
                0,
            );
      const advanced = advanceRedisCreateGeneration({
        generations: createGenerations,
        currentOperationId: operationId,
        closedAttemptCount,
        closedSuccessCount,
        totalAttemptCount: Number(meta.createInstanceAttemptCount || 0),
        totalSuccessCount: Number(meta.createInstanceSuccessCount || 0),
        terminalErrorCode: meta.providerErrorCode || meta.errorCode || null,
        lastRequestId: meta.providerRequestId || null,
      });
      previousOperationId = advanced.previousOperationId;
      operationId = advanced.operationId;
      createGeneration = advanced.createGeneration;
      createGenerations = advanced.createGenerations;
      generationAttemptCount = 0;
      generationSuccessCount = 0;
    } else if (!createGenerations?.length && operationId) {
      // Bootstrap audit for legacy CRs that never recorded generations.
      createGenerations = [
        {
          generation: 1,
          operationId,
          attemptCount: Number(meta.createInstanceAttemptCount || 0),
          successCount: Number(meta.createInstanceSuccessCount || 0),
          createdAt: undefined,
          closedAt: null,
        },
      ];
      createGeneration = 1;
      generationAttemptCount = Number(
        meta.generationAttemptCount ?? meta.createInstanceAttemptCount ?? 0,
      );
      generationSuccessCount = Number(
        meta.generationSuccessCount ?? meta.createInstanceSuccessCount ?? 0,
      );
    }

    const resumeWithoutCreate =
      Boolean(resource.providerResourceId?.trim()) ||
      Boolean(claimedProviderResourceId) ||
      meta.createInstanceCompleted === true;
    const resumePhase = resumeWithoutCreate ? 'PREPARING_NETWORK' : 'QUEUED';

    // Preserve prior failure codes in errorHistory before clearing active error fields.
    const priorHistory = Array.isArray(meta.errorHistory) ? [...meta.errorHistory] : [];
    if (meta.errorCode || meta.providerErrorCode || meta.errorMessage) {
      priorHistory.push({
        code: meta.errorCode || meta.providerErrorCode || 'UNKNOWN',
        providerErrorCode: meta.providerErrorCode || null,
        message: meta.errorMessage || null,
        providerRequestId: meta.providerRequestId || null,
        createFailureKind: failureKind,
        operationId: meta.operationId || null,
        createGeneration: meta.createGeneration || null,
        retainedAt: new Date().toISOString(),
        from: 'retry_snapshot',
      });
    }

    // Ensure a full resolved SKU is persisted before Worker runs (never tier-only).
    // Never rewrite instanceClass / engineVersion / capacity / zone when already present.
    let resolvedPatch: Meta = {};
    if (!meta.instanceClass || !meta.engineVersion || !meta.storageType) {
      const provider = reconcileProvider;
      const tier = (meta.tier || resource.instanceType || 'DEV') as RedisProvisionTier;
      const resolved = await this.resolveSkuForTier(provider, region, tier);
      resolvedPatch = { ...resolved, resolvedSku: resolved, tier };
    } else {
      resolvedPatch = {
        resolvedSku: meta.resolvedSku || {
          tier: (meta.tier || 'DEV') as RedisProvisionTier,
          instanceClass: meta.instanceClass,
          engineVersion: meta.engineVersion,
          storageType: meta.storageType,
          capacityMb: meta.capacityMb,
          zoneId: meta.zoneId,
          architecture: meta.architecture,
          selectionReason: meta.selectionReason,
          fallbackReason: meta.fallbackReason,
          availabilityFingerprint: meta.availabilityFingerprint,
        },
      };
    }

    const mergedResolved = {
      ...(meta.resolvedSku || {}),
      ...resolvedPatch.resolvedSku,
    } as NonNullable<Meta['resolvedSku']>;

    const updated = await this.prisma.cloudResource.update({
      where: { id: resource.id },
      data: {
        status: CloudResourceStatus.CREATING,
        ...(claimedProviderResourceId
          ? {
              providerResourceId: claimedProviderResourceId,
              externalId: claimedProviderResourceId,
            }
          : {}),
        // Keep providerResourceId as-is so resume skips CreateInstance when present.
        metadata: {
          ...meta,
          ...resolvedPatch,
          resolvedSku: mergedResolved,
          operationId,
          createGeneration,
          createGenerations,
          generationAttemptCount,
          generationSuccessCount,
          previousOperationId,
          clientTokenRotateReason,
          createFailureKind: null,
          phase: resumePhase,
          errorCode: null,
          errorMessage: null,
          technicalMessage: null,
          providerErrorCode: null,
          providerRequestId: null,
          errorHistory: priorHistory,
          createInstanceCompleted:
            resumeWithoutCreate || meta.createInstanceCompleted === true,
          ...(claimedProviderResourceId
            ? {
                providerResourceId: claimedProviderResourceId,
                reconciledFromProvider: true,
              }
            : {}),
          retryingAt: new Date().toISOString(),
          attemptStartedAt: new Date().toISOString(),
          phases: [
            ...(meta.phases || []),
            { phase: resumePhase, at: new Date().toISOString(), status: 'running' },
          ],
        } as Prisma.InputJsonObject,
      },
    });
    await this.queue.enqueue(updated.id, operationId, {
      tier: mergedResolved.tier,
      instanceClass: mergedResolved.instanceClass,
      engineVersion: mergedResolved.engineVersion,
      storageType: mergedResolved.storageType,
      capacityMb: mergedResolved.capacityMb,
      zoneId: mergedResolved.zoneId,
      architecture: mergedResolved.architecture,
      availabilityFingerprint: mergedResolved.availabilityFingerprint,
    });
    return await this.toPublicStatus(updated);
  }

  async unlink(userId: string, projectId: string, id: string) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    this.requireWrite(membership.role);
    const resource = await this.requireProjectCache(projectId, id);
    const connections = await this.prisma.redisConnection.findMany({
      where: { cloudResourceId: resource.id },
    });
    for (const connection of connections) {
      await this.redisConnections.unlinkManaged(userId, projectId, connection.id);
    }
    const meta = asMeta(resource.metadata);
    await this.prisma.cloudResource.update({
      where: { id: resource.id },
      data: {
        metadata: {
          ...meta,
          redisConnectionId: null,
          unboundAt: new Date().toISOString(),
        } as Prisma.InputJsonObject,
      },
    });
    return {
      message: '已解除绑定。云 Redis 仍保留在阿里云，不会被删除。',
      cloudResourceId: resource.id,
    };
  }

  async destroy(userId: string, projectId: string, id: string, dto: DeleteRedisProvisionDto) {
    const { membership, project } = await this.workspaceAccess.requireProjectAccess(
      userId,
      projectId,
    );
    this.requireWrite(membership.role);
    if (!dto.confirmDestroy) {
      throw new BadRequestException(
        '删除云 Redis 会永久删除其中的数据，且无法通过 LaunchOS 恢复。请确认。',
      );
    }
    const resource = await this.requireProjectCache(projectId, id);
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

    const connections = await this.prisma.redisConnection.findMany({
      where: { cloudResourceId: resource.id },
    });
    for (const connection of connections) {
      await this.redisConnections.markUnavailable(userId, projectId, connection.id);
    }

    if (resource.providerResourceId) {
      try {
        const account = await this.requireAliyunAccount(project.workspaceId);
        const secrets = await this.providerAccounts.decryptSecrets(account.credentialEncrypted);
        const provider = new AlibabaCloudRedisProvider({
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
        throw new BadRequestException('删除云 Redis 失败，请稍后在阿里云控制台确认。');
      }
    }

    const deleted = await this.prisma.cloudResource.update({
      where: { id: resource.id },
      data: {
        status: CloudResourceStatus.DELETED,
        metadata: {
          ...meta,
          redisConnectionId: null,
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
    const phase = (meta.phase || 'QUEUED') as RedisProvisionPhase;
    const queueHint = await this.resolveQueueHint(resource);
    const errorCode = (meta.errorCode as CloudRedisErrorCode | undefined) || null;
    let technicalForUi =
      meta.technicalMessage || meta.providerErrorCode || meta.errorMessage || null;
    let providerErrorCode = meta.providerErrorCode || null;
    let providerRequestId = meta.providerRequestId || null;
    if (resource.status === CloudResourceStatus.FAILED) {
      const latestJobReason = await this.queue.getFailedReason(resource.id).catch(() => null);
      if (latestJobReason) {
        technicalForUi = latestJobReason;
        // Prefer real Aliyun codes like PAY.INSUFFICIENT_BALANCE — never "order.but".
        const codeMatch = latestJobReason.match(
          /\b((?:PAY|ORDER|Forbidden|Invalid|ServiceLinkedRole|EngineVersion)[A-Za-z0-9_.]*)\b/,
        );
        const reqMatch = latestJobReason.match(/request id:\s*([A-Za-z0-9-]+)/i);
        if (codeMatch?.[1] && !/\.but$/i.test(codeMatch[1])) {
          providerErrorCode = codeMatch[1];
        }
        if (reqMatch?.[1]) providerRequestId = reqMatch[1];
      }
      if (!providerErrorCode && technicalForUi) {
        const parsedCode = technicalForUi.match(
          /\b((?:PAY|ORDER|Forbidden|Invalid|ServiceLinkedRole|EngineVersion)[A-Za-z0-9_.]*)\b/,
        );
        if (parsedCode?.[1] && !/\.but$/i.test(parsedCode[1])) {
          providerErrorCode = parsedCode[1];
        }
      }
    }
    const errorMessage =
      resource.status === CloudResourceStatus.FAILED || meta.errorMessage
        ? cloudRedisErrorUserMessage(
            (errorCode as CloudRedisErrorCode) || 'PROVIDER_ERROR',
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
      displayName: meta.displayName || '阿里云 Redis',
      resourceType: '阿里云 Redis',
      status: mapUserStatus(resource.status, phase, queueHint),
      statusRaw: resource.status,
      phase,
      phaseLabel:
        queueHint === 'QUEUE_STALLED' || queueHint === 'CONSUMER_OFFLINE'
          ? REDIS_PROVISION_QUEUE_STALL_USER_MESSAGE
          : currentAction,
      steps: buildSteps(phase, resource.status, {
        phases: meta.phases,
        attemptStartedAt,
      }),
      region: resource.region || meta.region || null,
      tier: meta.tier || resource.instanceType || null,
      instanceClass: meta.instanceClass || meta.resolvedSku?.instanceClass || null,
      engineVersion: meta.engineVersion || meta.resolvedSku?.engineVersion || null,
      storageType: meta.storageType || meta.resolvedSku?.storageType || null,
      capacityMb: meta.capacityMb ?? meta.resolvedSku?.capacityMb ?? null,
      resolvedSku: meta.resolvedSku || null,
      createInstanceAttemptCount: meta.createInstanceAttemptCount ?? 0,
      createInstanceSuccessCount: meta.createInstanceSuccessCount ?? 0,
      createGeneration: meta.createGeneration ?? 1,
      generationAttemptCount: meta.generationAttemptCount ?? 0,
      generationSuccessCount: meta.generationSuccessCount ?? 0,
      createFailureKind: meta.createFailureKind ?? null,
      instanceName: meta.instanceName || null,
      passwordConfigured: Boolean(meta.passwordEncrypted),
      networkMode: meta.networkMode || null,
      connectionHost: meta.connectionHost || null,
      connectionPort: meta.connectionPort || null,
      redisConnectionId: meta.redisConnectionId || null,
      providerResourceId: resource.providerResourceId,
      errorCode: errorCode || (queueHint === 'QUEUE_STALLED' ? 'QUEUE_STALLED' : null),
      errorMessage,
      providerRequestId,
      providerErrorCode,
      providerErrorMessage: meta.providerErrorMessage || technicalForUi || null,
      httpStatus: meta.httpStatus ?? null,
      failedOperation: meta.failedOperation || null,
      retryableAfterUserAction: Boolean(
        meta.retryableAfterUserAction ||
          (errorCode &&
            [
              'REDIS_BILLING_INSUFFICIENT_BALANCE',
              'REDIS_BILLING_ACCOUNT_INVALID',
              'REDIS_BILLING_UNSETTLED_BILL',
              'REDIS_BILLING_ORDER_FAILED',
            ].includes(String(errorCode))),
      ),
      canRetry:
        resource.status === CloudResourceStatus.FAILED ||
        (resource.status === CloudResourceStatus.CREATING &&
          (queueHint === 'QUEUE_STALLED' || queueHint === 'CONSUMER_OFFLINE')),
      queueHint,
      jobId: redisProvisionJobId(resource.id),
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
    const phase = (meta.phase || 'QUEUED') as RedisProvisionPhase;
    if (phase !== 'QUEUED' && resource.providerResourceId) return 'OK';

    const [jobState, presence, paused] = await Promise.all([
      this.queue.getJobState(resource.id),
      this.workerPresence.getOnlineConsumer('redisProvision'),
      this.queue.isPaused(),
    ]);
    const consumerReady = presence.online && presence.queueReady.redisProvision && !paused;
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

  private async requireProjectCache(projectId: string, id: string) {
    const resource = await this.prisma.cloudResource.findFirst({
      where: { id, projectId, type: CloudResourceType.CACHE },
    });
    if (!resource) throw new NotFoundException('未找到 Redis 资源');
    return resource;
  }

  private async resolveSkuForTier(
    provider: AlibabaCloudRedisProvider,
    region: string,
    tier: RedisProvisionTier,
  ): Promise<NonNullable<Meta['resolvedSku']>> {
    const specs = await provider.listAvailableSpecs(region, tier);
    const spec = specs[0];
    if (!spec?.instanceClass || !spec.engineVersion || !spec.storageType) {
      throw new BadRequestException({
        message: '当前选择的 Redis 规格暂时不可用，LaunchOS 正在重新选择可用规格。',
        code: 'REDIS_SKU_NOT_AVAILABLE',
      });
    }
    const fingerprint = [
      region,
      spec.storageType,
      spec.instanceClass,
      spec.engineVersion,
      spec.capacityMb ?? '',
      spec.zoneId ?? '',
    ].join('|');
    return {
      tier,
      instanceClass: spec.instanceClass,
      engineVersion: spec.engineVersion,
      storageType: spec.storageType,
      capacityMb: spec.capacityMb,
      zoneId: spec.zoneId,
      architecture: spec.architecture,
      selectionReason: spec.selectionReason,
      fallbackReason: spec.fallbackReason,
      availabilityFingerprint: fingerprint,
    };
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
      throw new ForbiddenException('无权限创建或管理云 Redis');
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
  phase?: RedisProvisionPhase,
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

const STEP_ORDER: RedisProvisionPhase[] = [
  'CREATING_INSTANCE',
  'PREPARING_NETWORK',
  'PREPARING_AUTH',
  'TESTING_CONNECTION',
  'BINDING',
];

const STEP_LABELS = [
  '创建 Redis',
  '准备网络',
  '准备访问凭证',
  '测试 Redis 连接',
  '绑定应用',
];

function resolveProgressPhase(
  phase: RedisProvisionPhase,
  options?: {
    phases?: Array<{ phase: RedisProvisionPhase; at: string; status: string }>;
    attemptStartedAt?: string | null;
  },
): RedisProvisionPhase {
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
  phase: RedisProvisionPhase,
  status: CloudResourceStatus,
  options?: {
    phases?: Array<{ phase: RedisProvisionPhase; at: string; status: string }>;
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
  phase: RedisProvisionPhase,
  status: CloudResourceStatus,
  queueHint?: string | null,
): string {
  if (queueHint === 'QUEUE_STALLED' || queueHint === 'CONSUMER_OFFLINE') {
    return REDIS_PROVISION_QUEUE_STALL_USER_MESSAGE;
  }
  if (status === CloudResourceStatus.FAILED || phase === 'FAILED') {
    return 'Redis 创建失败';
  }
  if (status === CloudResourceStatus.RUNNING || phase === 'DONE') {
    return 'Redis 已就绪';
  }
  switch (phase) {
    case 'QUEUED':
      return '等待重试任务开始…';
    case 'CREATING_INSTANCE':
      return '正在创建 阿里云 Redis…';
    case 'PREPARING_NETWORK':
      return '正在配置 Redis 网络…';
    case 'PREPARING_AUTH':
      return '正在准备访问凭证…';
    case 'TESTING_CONNECTION':
      return '正在测试 Redis 连接…';
    case 'BINDING':
      return '正在绑定 API 服务…';
    default:
      return REDIS_PROVISION_PHASE_LABELS[phase] || '正在处理数据库任务…';
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
