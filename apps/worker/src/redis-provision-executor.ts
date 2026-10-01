import {
  CloudResourceStatus,
  PrismaClient,
  RedisTlsMode,
  RuntimeConfigRequirementStatus,
  RuntimeConfigScopeType,
  type Prisma,
} from '@launchos/database';
import { AlibabaCloudRedisProvider, diagnoseRedisSkuSelection, selectRedisTierFromAvailability } from '@launchos/providers';
import {
  buildRedisUrl,
  bumpRedisCreateGenerationCounters,
  classifyCloudRedisError,
  classifyRedisCreateFailureKind,
  cloudRedisErrorUserMessage,
  decryptCredential,
  encryptCredential,
  parseAliyunRedisProviderError,
  withRedisLock,
  type RedisProvisionPhase,
} from '@launchos/shared';
import { RemoteRunner } from '@launchos/remote-runner';

type Meta = Record<string, unknown>;
const TOTAL_TIMEOUT_MS = 25 * 60_000;
const PROVIDER = 'REDIS_CONNECTION';
const REDIS_URL_KEY = 'REDIS_URL';

/**
 * Executes Aliyun Redis provisioning for a CloudResource CACHE job.
 * Secrets stay encrypted / in-memory only — never logged.
 */
export async function executeRedisProvision(
  prisma: PrismaClient,
  cloudResourceId: string,
): Promise<void> {
  const started = Date.now();
  const resource = await prisma.cloudResource.findUnique({
    where: { id: cloudResourceId },
    include: { provider: true },
  });
  if (!resource || !resource.projectId) {
    throw new Error('cloud resource missing');
  }
  if (resource.status === CloudResourceStatus.RUNNING) {
    return;
  }

  const meta = asMeta(resource.metadata);
  const passwordEncrypted = String(meta.passwordEncrypted || '');
  if (!passwordEncrypted) {
    throw new Error('managed redis password missing');
  }
  const password = decryptCredential(passwordEncrypted);
  const unitIds = Array.isArray(meta.unitIds)
    ? meta.unitIds.filter((item): item is string => typeof item === 'string')
    : [];
  const tier = (meta.tier as 'DEV' | 'SMALL' | 'STANDARD') || 'DEV';
  const resolvedSku = (meta.resolvedSku && typeof meta.resolvedSku === 'object'
    ? (meta.resolvedSku as Record<string, unknown>)
    : null);
  const instanceClass = String(
    meta.instanceClass || resolvedSku?.instanceClass || '',
  ).trim();
  const engineVersion = String(
    meta.engineVersion || resolvedSku?.engineVersion || '',
  ).trim();
  const storageType = String(
    meta.storageType || resolvedSku?.storageType || '',
  ).trim();
  const capacityMbRaw = meta.capacityMb ?? resolvedSku?.capacityMb;
  const capacityMb =
    typeof capacityMbRaw === 'number'
      ? capacityMbRaw
      : typeof capacityMbRaw === 'string' && capacityMbRaw.trim()
        ? Number(capacityMbRaw)
        : undefined;
  const architecture = String(
    meta.architecture || resolvedSku?.architecture || '',
  ).trim() || undefined;
  const operationId = String(meta.operationId || cloudResourceId);
  const region = resource.region || String(meta.region || 'cn-hangzhou');
  const instanceName = String(meta.instanceName || `launchos-redis-${cloudResourceId.slice(-8)}`);

  if (!instanceClass || !engineVersion || !storageType) {
    throw Object.assign(
      new Error('REDIS_SKU_NOT_AVAILABLE: CloudResource missing resolved SKU'),
      { code: 'REDIS_SKU_NOT_AVAILABLE' },
    );
  }
  // Never allow stale Local+7.0 into Create.
  if (
    (storageType === 'Local' || /^redis\.master\./i.test(instanceClass)) &&
    engineVersion === '7.0'
  ) {
    throw Object.assign(
      new Error('REDIS_SKU_NOT_AVAILABLE: LocalDisk does not support engineVersion 7.0'),
      { code: 'REDIS_SKU_NOT_AVAILABLE' },
    );
  }

  const account = await prisma.providerAccount.findFirst({
    where: {
      workspaceId: resource.workspaceId,
      providerId: resource.providerId,
      status: 'ACTIVE',
      provider: { type: 'ALIYUN' },
    },
    include: { provider: true },
  });
  if (!account?.credentialEncrypted) {
    throw new Error('Aliyun provider account missing');
  }
  if (account.provider.type !== 'ALIYUN') {
    throw new Error('Redis provision requires ProviderAccount type ALIYUN (not ALIYUN_DNS)');
  }
  const secrets = decryptProviderSecretsLocal(account.credentialEncrypted);
  const provider = new AlibabaCloudRedisProvider({
    accessKey: secrets.accessKey,
    secretKey: secrets.secretKey,
    region,
  });

  const updatePhase = async (phase: RedisProvisionPhase, patch: Meta = {}) => {
    const latest = await prisma.cloudResource.findUnique({ where: { id: cloudResourceId } });
    const current = asMeta(latest?.metadata);
    const phases = Array.isArray(current.phases) ? [...(current.phases as Meta[])] : [];
    phases.push({ phase, at: new Date().toISOString(), status: 'running' });
    await prisma.cloudResource.update({
      where: { id: cloudResourceId },
      data: {
        status: CloudResourceStatus.CREATING,
        metadata: {
          ...current,
          ...patch,
          phase,
          phases,
          passwordEncrypted: current.passwordEncrypted || passwordEncrypted,
        } as Prisma.InputJsonObject,
      },
    });
  };

  try {
    if (Date.now() - started > TOTAL_TIMEOUT_MS) {
      throw new Error('Timed out provisioning redis');
    }

    const clientToken = operationId.slice(0, 64);
    const createAlreadyDone =
      Boolean(resource.providerResourceId?.trim()) ||
      Boolean(String(resource.externalId || '').trim() && resource.externalId !== 'pending') ||
      meta.createInstanceCompleted === true;

    if (!createAlreadyDone) {
      await updatePhase('CREATING_INSTANCE');
    }

    const server = await resolveServerTarget(prisma, resource.workspaceId, resource.projectId, meta);
    const placement = await provider.resolveNetworkPlacement({
      region,
      ecsInstanceId: server.ecsInstanceId,
      serverPublicIp: server.publicIp,
    });

    await updatePhase('PREPARING_NETWORK', {
      networkMode: placement.networkMode,
      vpcId: placement.vpcId,
      vSwitchId: placement.vSwitchId,
      region: placement.region,
      placementZoneId: placement.zoneId,
      ...(createAlreadyDone
        ? { createInstanceCompleted: true, resumedWithoutCreate: true }
        : {}),
    });

    // Align resolved SKU to placement zone before Create (vSwitch zone is authoritative).
    let effectiveClass = instanceClass;
    let effectiveVersion = engineVersion;
    let effectiveStorage = storageType;
    let effectiveCapacity = capacityMb;
    let effectiveArchitecture = architecture;
    if (!createAlreadyDone) {
      const availability = await provider.describeAllAvailableResources(placement.region);
      const diagnosis = diagnoseRedisSkuSelection(availability, {
        region: placement.region,
        zoneId: placement.zoneId,
        instanceClass: effectiveClass,
        engineVersion: effectiveVersion,
        storageType: effectiveStorage,
        capacityMb: effectiveCapacity,
        requireArchitecture: false,
      });
      if (!diagnosis.valid && diagnosis.failedField === 'zoneId') {
        const adapted = selectRedisTierFromAvailability(availability, {
          preferredZoneId: placement.zoneId,
        }).find((item) => item.tier === tier);
        if (!adapted) {
          throw Object.assign(
            new Error(
              `REDIS_SKU_NOT_AVAILABLE: no purchasable SKU in placement zone ${placement.zoneId}`,
            ),
            {
              code: 'REDIS_SKU_NOT_AVAILABLE',
              failedField: 'zoneId',
              expected: diagnosis.expected,
              actualCandidates: diagnosis.actualCandidates,
              availableZones: diagnosis.availableZones,
              match: diagnosis.match,
              checkedAt: diagnosis.checkedAt,
            },
          );
        }
        effectiveClass = adapted.instanceClass;
        effectiveVersion = adapted.engineVersion;
        effectiveStorage = adapted.storageType;
        effectiveCapacity = adapted.capacityMb;
        effectiveArchitecture = adapted.architecture;
        const adaptedSku = {
          tier,
          instanceClass: effectiveClass,
          engineVersion: effectiveVersion,
          storageType: effectiveStorage,
          capacityMb: effectiveCapacity,
          zoneId: placement.zoneId,
          architecture: effectiveArchitecture,
          selectionReason: adapted.selectionReason,
          fallbackReason: adapted.fallbackReason,
          availabilityFingerprint: [
            placement.region,
            effectiveStorage,
            effectiveClass,
            effectiveVersion,
            effectiveCapacity ?? '',
            placement.zoneId ?? '',
          ].join('|'),
        };
        await updatePhase('CREATING_INSTANCE', {
          ...adaptedSku,
          resolvedSku: adaptedSku,
          skuAdaptedForPlacementZone: true,
          previousResolvedSku: {
            instanceClass,
            engineVersion,
            storageType,
            capacityMb,
            zoneId: meta.zoneId || resolvedSku?.zoneId,
            architecture,
          },
          skuValidation: {
            failedField: 'zoneId',
            adapted: true,
            availableZones: diagnosis.availableZones,
            placementZoneId: placement.zoneId,
            checkedAt: diagnosis.checkedAt,
          },
        });
      } else if (!diagnosis.valid) {
        throw Object.assign(
          new Error(
            `REDIS_SKU_NOT_AVAILABLE: selected Redis combo is not purchasable (${diagnosis.failedField || 'unknown'})`,
          ),
          {
            code: 'REDIS_SKU_NOT_AVAILABLE',
            failedField: diagnosis.failedField,
            expected: diagnosis.expected,
            actualCandidates: diagnosis.actualCandidates,
            availableZones: diagnosis.availableZones,
            match: diagnosis.match,
            checkedAt: diagnosis.checkedAt,
          },
        );
      }
    }
    let instanceId = await resolveExistingRedisInstanceId({
      prisma,
      cloudResourceId,
      provider,
      region: placement.region,
      instanceName,
    });

    if (instanceId) {
      const status = await provider.getInstanceStatus(instanceId);
      if (status.status === 'DELETED' || status.status === 'FAILED') {
        throw Object.assign(
          new Error(
            `已绑定的 Redis ${instanceId} 状态异常（${status.rawStatus || status.status}），禁止 CreateInstance。`,
          ),
          { code: 'BOUND_REDIS_UNUSABLE' },
        );
      }
      if (status.status === 'LOCKED') {
        throw Object.assign(new Error(`Redis locked: ${status.rawStatus || 'LOCKED'}`), {
          code: 'PROVIDER_LOCKED',
        });
      }
    } else if (createAlreadyDone || resource.providerResourceId) {
      throw Object.assign(
        new Error(
          'providerResourceId 已存在或 createInstanceCompleted=true，但无法解析实例；禁止 CreateInstance。',
        ),
        { code: 'BOUND_REDIS_MISSING' },
      );
    } else {
      instanceId = await withRedisLock(`redis-create:${cloudResourceId}`, 120_000, async () => {
        const existing = await resolveExistingRedisInstanceId({
          prisma,
          cloudResourceId,
          provider,
          region: placement.region,
          instanceName,
        });
        if (existing) return existing;

        const fresh = await prisma.cloudResource.findUnique({
          where: { id: cloudResourceId },
          select: { providerResourceId: true, externalId: true, metadata: true },
        });
        const freshMeta = asMeta(fresh?.metadata);
        if (
          fresh?.providerResourceId ||
          (fresh?.externalId && fresh.externalId !== 'pending') ||
          freshMeta.createInstanceCompleted === true
        ) {
          throw Object.assign(
            new Error('检测到 providerResourceId / createInstanceCompleted，禁止 CreateInstance。'),
            { code: 'CREATE_FORBIDDEN_AFTER_BIND' },
          );
        }

        try {
          const attemptBefore = provider.createInstanceAttemptCount;
          const created = await provider.createInstance({
            region: placement.region,
            zoneId: placement.zoneId,
            vpcId: placement.vpcId,
            vSwitchId: placement.vSwitchId,
            instanceName,
            password,
            securityIpList: placement.whitelist.join(','),
            clientToken,
            tier,
            instanceClass: effectiveClass,
            engineVersion: effectiveVersion,
            storageType: effectiveStorage,
            capacityMb: Number.isFinite(effectiveCapacity as number)
              ? effectiveCapacity
              : undefined,
            architecture: effectiveArchitecture,
          });
          const id = created.instanceId;
          const attemptsDelta = provider.createInstanceAttemptCount - attemptBefore;
          const latestMeta = asMeta(
            (
              await prisma.cloudResource.findUnique({
                where: { id: cloudResourceId },
                select: { metadata: true },
              })
            )?.metadata,
          );
          const genAttempts =
            Number(latestMeta.generationAttemptCount || 0) + attemptsDelta;
          const genSuccesses =
            Number(latestMeta.generationSuccessCount || 0) +
            Math.max(provider.createInstanceSuccessCount, 1);
          const createGenerations = bumpRedisCreateGenerationCounters(
            Array.isArray(latestMeta.createGenerations)
              ? (latestMeta.createGenerations as Parameters<
                  typeof bumpRedisCreateGenerationCounters
                >[0])
              : undefined,
            {
              attemptDelta: attemptsDelta,
              successDelta: Math.max(provider.createInstanceSuccessCount, 1),
            },
          );
          await prisma.cloudResource.update({
            where: { id: cloudResourceId },
            data: {
              externalId: id,
              providerResourceId: id,
              metadata: {
                ...latestMeta,
                createInstanceCompleted: true,
                providerResourceId: id,
                createInstanceAttemptCount:
                  Number(latestMeta.createInstanceAttemptCount || 0) + attemptsDelta,
                createInstanceSuccessCount:
                  Number(latestMeta.createInstanceSuccessCount || 0) +
                  Math.max(provider.createInstanceSuccessCount, 1),
                createInstanceCallCount:
                  Number(latestMeta.createInstanceAttemptCount || 0) + attemptsDelta,
                generationAttemptCount: genAttempts,
                generationSuccessCount: genSuccesses,
                createGenerations,
                createFailureKind: null,
                instanceClass: effectiveClass,
                engineVersion: effectiveVersion,
                storageType: effectiveStorage,
                capacityMb: effectiveCapacity,
                architecture: effectiveArchitecture,
              } as Prisma.InputJsonObject,
            },
          });
          return id;
        } catch (error) {
          if (provider.createInstanceAttemptCount > 0) {
            const latestMeta = asMeta(
              (
                await prisma.cloudResource.findUnique({
                  where: { id: cloudResourceId },
                  select: { metadata: true },
                })
              )?.metadata,
            );
            const attemptsDelta = provider.createInstanceAttemptCount;
            const failureKind = classifyRedisCreateFailureKind({
              errorCode: (error as { code?: string }).code,
              providerErrorCode: parseAliyunRedisProviderError(error).providerErrorCode,
              technicalMessage: readSafeError(error),
            });
            const createGenerations = bumpRedisCreateGenerationCounters(
              Array.isArray(latestMeta.createGenerations)
                ? (latestMeta.createGenerations as Parameters<
                    typeof bumpRedisCreateGenerationCounters
                  >[0])
                : undefined,
              { attemptDelta: attemptsDelta },
            );
            await prisma.cloudResource.update({
              where: { id: cloudResourceId },
              data: {
                metadata: {
                  ...latestMeta,
                  createInstanceAttemptCount:
                    Number(latestMeta.createInstanceAttemptCount || 0) + attemptsDelta,
                  createInstanceSuccessCount: Number(
                    latestMeta.createInstanceSuccessCount || 0,
                  ),
                  createInstanceCallCount: attemptsDelta,
                  generationAttemptCount:
                    Number(latestMeta.generationAttemptCount || 0) + attemptsDelta,
                  generationSuccessCount: Number(
                    latestMeta.generationSuccessCount || 0,
                  ),
                  createGenerations,
                  createFailureKind: failureKind,
                  instanceClass: effectiveClass,
                  engineVersion: effectiveVersion,
                  storageType: effectiveStorage,
                  capacityMb: effectiveCapacity,
                  architecture: effectiveArchitecture,
                } as Prisma.InputJsonObject,
              },
            });
          }
          const recovered = await resolveExistingRedisInstanceId({
            prisma,
            cloudResourceId,
            provider,
            region: placement.region,
            instanceName,
          });
          if (recovered) {
            await prisma.cloudResource.update({
              where: { id: cloudResourceId },
              data: {
                externalId: recovered,
                providerResourceId: recovered,
                metadata: {
                  ...asMeta(
                    (
                      await prisma.cloudResource.findUnique({
                        where: { id: cloudResourceId },
                        select: { metadata: true },
                      })
                    )?.metadata,
                  ),
                  createInstanceCompleted: true,
                  providerResourceId: recovered,
                  recoveredAfterTimeout: true,
                } as Prisma.InputJsonObject,
              },
            });
            return recovered;
          }
          throw error;
        }
      });
    }

    if (!instanceId) {
      throw new Error('Redis instance id unresolved');
    }

    await updatePhase('WAITING_INSTANCE', {
      providerResourceId: instanceId,
      createInstanceCompleted: true,
    });
    await provider.waitUntilRunning(
      instanceId,
      Math.max(60_000, TOTAL_TIMEOUT_MS - (Date.now() - started)),
    );

    // Whitelist: PUBLIC_LIMITED = target IPs only; VPC_PRIVATE may include VPC CIDR.
    await provider.setWhitelist({
      instanceId,
      securityIpList: placement.whitelist.join(','),
    });

    await updatePhase('PREPARING_AUTH', {
      providerResourceId: instanceId,
      createInstanceCompleted: true,
    });

    let connection = await provider.getConnectionInfo(
      instanceId,
      placement.networkMode === 'VPC_PRIVATE',
    );
    if (placement.networkMode === 'PUBLIC_LIMITED' && provider.allocatePublicConnection) {
      try {
        connection = await provider.allocatePublicConnection(instanceId, 6379);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/otherendpoint\.exist|already|exists|duplicat/i.test(message)) {
          connection = await provider.getConnectionInfo(instanceId, false);
        } else {
          const fallback = await provider.getConnectionInfo(instanceId, false).catch(() => null);
          if (fallback?.host) connection = fallback;
          else throw error;
        }
      }
    }

    await updatePhase('TESTING_CONNECTION', {
      connectionHost: connection.host,
      connectionPort: connection.port,
      networkMode: placement.networkMode,
    });

    const pingOk = await testPingFromTarget({
      prisma,
      workspaceId: resource.workspaceId,
      projectId: resource.projectId,
      serverInstanceId:
        typeof meta.serverInstanceId === 'string' ? meta.serverInstanceId : server.serverInstanceId,
      host: connection.host,
      port: connection.port,
      password,
    });
    if (!pingOk) {
      throw Object.assign(new Error('Target Server Redis PING failed'), {
        code: 'CONNECTION_TEST_FAILED',
      });
    }

    await updatePhase('BINDING');

    const existingConn = await prisma.redisConnection.findFirst({
      where: { cloudResourceId },
    });
    let connectionId = existingConn?.id;
    if (!connectionId) {
      const createdConn = await prisma.redisConnection.create({
        data: {
          workspaceId: resource.workspaceId,
          projectId: resource.projectId,
          name: `LaunchOS Redis (${instanceName})`,
          status: 'CONNECTED',
          host: connection.host,
          port: connection.port,
          passwordEncrypted: encryptCredential(password),
          databaseIndex: 0,
          tlsMode: RedisTlsMode.DISABLE,
          source: 'ALIYUN_REDIS',
          cloudResourceId,
          createdBy: 'system:redis-provision',
          updatedBy: 'system:redis-provision',
          lastTestedAt: new Date(),
          lastTestStatus: 'SUCCESS',
          units: {
            create: unitIds.map((deployableUnitId) => ({ deployableUnitId })),
          },
        },
      });
      connectionId = createdConn.id;
      await bindRedisUrl(prisma, resource.projectId, connectionId, unitIds, {
        host: connection.host,
        port: connection.port,
        password,
      });
    } else {
      await prisma.redisConnection.update({
        where: { id: connectionId },
        data: {
          host: connection.host,
          port: connection.port,
          passwordEncrypted: encryptCredential(password),
          status: 'CONNECTED',
          source: 'ALIYUN_REDIS',
          lastTestedAt: new Date(),
          lastTestStatus: 'SUCCESS',
        },
      });
      await bindRedisUrl(prisma, resource.projectId, connectionId, unitIds, {
        host: connection.host,
        port: connection.port,
        password,
      });
    }

    const latest = asMeta(
      (await prisma.cloudResource.findUnique({ where: { id: cloudResourceId } }))?.metadata,
    );
    await prisma.cloudResource.update({
      where: { id: cloudResourceId },
      data: {
        status: CloudResourceStatus.RUNNING,
        externalId: instanceId,
        providerResourceId: instanceId,
        region: placement.region,
        metadata: {
          ...latest,
          phase: 'DONE',
          connectionHost: connection.host,
          connectionPort: connection.port,
          networkMode: placement.networkMode,
          redisConnectionId: connectionId,
          passwordEncrypted: latest.passwordEncrypted || passwordEncrypted,
          errorCode: null,
          errorMessage: null,
        } as Prisma.InputJsonObject,
      },
    });
  } catch (error) {
    const classified = classifyCloudRedisError(error);
    const parsed = parseAliyunRedisProviderError(error);
    const latest = asMeta(
      (await prisma.cloudResource.findUnique({ where: { id: cloudResourceId } }))?.metadata,
    );
    const technicalMessage =
      classified.technicalMessage || parsed.providerErrorMessage || readSafeError(error);
    const createFailureKind = classifyRedisCreateFailureKind({
      errorCode: classified.code,
      providerErrorCode:
        classified.providerErrorCode || parsed.providerErrorCode || null,
      technicalMessage,
      httpStatus: classified.httpStatus ?? parsed.httpStatus ?? null,
    });
    await prisma.cloudResource.update({
      where: { id: cloudResourceId },
      data: {
        status: CloudResourceStatus.FAILED,
        metadata: {
          ...latest,
          phase: 'FAILED',
          errorCode: classified.code,
          errorMessage: cloudRedisErrorUserMessage(classified.code, technicalMessage),
          technicalMessage,
          providerErrorCode:
            classified.providerErrorCode || parsed.providerErrorCode || latest.providerErrorCode || null,
          providerErrorMessage: parsed.providerErrorMessage || technicalMessage,
          providerRequestId:
            classified.providerRequestId || parsed.providerRequestId || latest.providerRequestId || null,
          httpStatus: classified.httpStatus ?? parsed.httpStatus ?? null,
          createFailureKind,
          failedOperation:
            !latest.createInstanceCompleted &&
            (latest.phase === 'CREATING_INSTANCE' ||
              Number(latest.createInstanceAttemptCount || 0) > 0 ||
              /CreateInstance|PAY\.|ORDER\./i.test(technicalMessage))
              ? 'CreateInstance'
              : latest.phase || 'FAILED',
          retryableAfterUserAction: Boolean(classified.retryableAfterUserAction),
          passwordEncrypted: latest.passwordEncrypted || passwordEncrypted,
          ...(((error as { code?: string }).code === 'REDIS_SKU_NOT_AVAILABLE'
            ? {
                failedField: (error as { failedField?: string }).failedField || null,
                skuValidation: {
                  failedField: (error as { failedField?: string }).failedField || null,
                  expected: (error as { expected?: unknown }).expected || null,
                  actualCandidates: (
                    (error as { actualCandidates?: unknown[] }).actualCandidates || []
                  ).slice(0, 30),
                  availableZones: (error as { availableZones?: string[] }).availableZones || [],
                  match: (error as { match?: unknown }).match || null,
                  checkedAt:
                    (error as { checkedAt?: string }).checkedAt || new Date().toISOString(),
                },
              }
            : {}) as Record<string, unknown>),
        } as Prisma.InputJsonObject,
      },
    });
    throw error;
  }
}

async function resolveExistingRedisInstanceId(input: {
  prisma: PrismaClient;
  cloudResourceId: string;
  provider: AlibabaCloudRedisProvider;
  region: string;
  instanceName: string;
}): Promise<string | undefined> {
  const fresh = await input.prisma.cloudResource.findUnique({
    where: { id: input.cloudResourceId },
  });
  const bound = fresh?.providerResourceId?.trim();
  if (bound) return bound;
  if (fresh?.externalId && fresh.externalId !== 'pending') {
    return fresh.externalId;
  }
  const ids = await input.provider.listInstancesByName(input.region, input.instanceName);
  if (ids.length > 1) {
    throw Object.assign(
      new Error(
        `检测到多个同名 Redis（${ids.join(',')}），已禁止再次 CreateInstance。请人工确认绑定哪一台后再 resume。`,
      ),
      { code: 'REDIS_RECONCILE_AMBIGUOUS' },
    );
  }
  if (ids.length === 1) {
    const id = ids[0]!;
    await input.prisma.cloudResource.update({
      where: { id: input.cloudResourceId },
      data: {
        externalId: id,
        providerResourceId: id,
        metadata: {
          ...asMeta(fresh?.metadata),
          createInstanceCompleted: true,
          reconciledFromProvider: true,
          providerResourceId: id,
        } as Prisma.InputJsonObject,
      },
    });
    return id;
  }
  return undefined;
}

async function resolveServerTarget(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  meta: Meta,
): Promise<{ serverInstanceId?: string; publicIp?: string; ecsInstanceId?: string }> {
  const preferredId =
    typeof meta.serverInstanceId === 'string' ? meta.serverInstanceId : undefined;
  const server = preferredId
    ? await prisma.serverInstance.findFirst({ where: { id: preferredId, workspaceId } })
    : await prisma.serverInstance.findFirst({
        where: { workspaceId },
        orderBy: { updatedAt: 'desc' },
      });
  if (!server) return {};
  const publicIp = server.host?.trim();
  const ecsId =
    typeof (server as { providerInstanceId?: string }).providerInstanceId === 'string'
      ? (server as { providerInstanceId?: string }).providerInstanceId
      : undefined;
  // Prefer running service's server for this project when available.
  const running = await prisma.serviceInstance.findFirst({
    where: { projectId, status: 'RUNNING', serverInstanceId: { not: null } },
    orderBy: { updatedAt: 'desc' },
  });
  if (running?.serverInstanceId && running.serverInstanceId !== server.id) {
    const alt = await prisma.serverInstance.findFirst({
      where: { id: running.serverInstanceId, workspaceId },
    });
    if (alt) {
      return {
        serverInstanceId: alt.id,
        publicIp: alt.host?.trim(),
        ecsInstanceId: ecsId,
      };
    }
  }
  return { serverInstanceId: server.id, publicIp, ecsInstanceId: ecsId };
}

async function testPingFromTarget(input: {
  prisma: PrismaClient;
  workspaceId: string;
  projectId: string;
  serverInstanceId?: string;
  host: string;
  port: number;
  password: string;
}): Promise<boolean> {
  const server = input.serverInstanceId
    ? await input.prisma.serverInstance.findFirst({
        where: { id: input.serverInstanceId, workspaceId: input.workspaceId },
      })
    : await input.prisma.serverInstance.findFirst({
        where: { workspaceId: input.workspaceId },
        orderBy: { updatedAt: 'desc' },
      });
  if (!server) return false;

  const host = String(input.host || '')
    .trim()
    .replace(/[\r\n\s]/g, '');
  const port = Number(input.port) || 6379;
  if (!host || !/^[A-Za-z0-9._-]+$/.test(host)) {
    return false;
  }

  const runner = new RemoteRunner();
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const passPath = `/tmp/launchos-redis-pass-${stamp}`;
  const scriptPath = `/tmp/launchos-redis-ping-${stamp}.sh`;
  try {
    await runner.connect({
      host: server.host,
      port: server.port,
      username: server.username,
      password: decryptCredential(server.credentialEncrypted),
    });
    // Keep password out of process argv / shell history: file mount into container.
    await runner.writeTextFile(passPath, input.password.replace(/[\r\n]/g, ''), 0o600);
    const script = [
      '#!/bin/sh',
      'set -e',
      `HOST=${shellSingleQuote(host)}`,
      `PORT=${shellSingleQuote(String(port))}`,
      `PASSFILE=${shellSingleQuote(passPath)}`,
      'docker run --rm --network host \\',
      '  -v "$PASSFILE:/run/redis-pass:ro,Z" \\',
      '  redis:7-alpine \\',
      '  sh -c \'redis-cli -h "$1" -p "$2" -a "$(cat /run/redis-pass)" --no-auth-warning PING\' _ "$HOST" "$PORT"',
      '',
    ].join('\n');
    await runner.writeTextFile(scriptPath, script, 0o700);
    const result = await runner.execute(`sh ${scriptPath}`, { timeoutMs: 90_000 });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    return result.exitCode === 0 && /\bPONG\b/i.test(output);
  } catch {
    return false;
  } finally {
    try {
      await runner.execute(`rm -f ${passPath} ${scriptPath}`, { timeoutMs: 5_000 });
    } catch {
      /* ignore */
    }
    try {
      await runner.disconnect();
    } catch {
      /* ignore */
    }
  }
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function bindRedisUrl(
  prisma: PrismaClient,
  projectId: string,
  connectionId: string,
  unitIds: string[],
  fields: { host: string; port: number; password: string },
): Promise<void> {
  const redisUrl = buildRedisUrl({
    host: fields.host,
    port: fields.port,
    password: fields.password,
    databaseIndex: 0,
    tlsMode: 'DISABLE',
  });
  const encrypted = encryptCredential(redisUrl);
  const now = new Date();
  for (const unitId of unitIds) {
    const requirement = await prisma.runtimeConfigRequirement.findUnique({
      where: { deployableUnitId_key: { deployableUnitId: unitId, key: REDIS_URL_KEY } },
    });
    await prisma.runtimeConfigValue.upsert({
      where: {
        scopeType_scopeId_key: {
          scopeType: RuntimeConfigScopeType.UNIT,
          scopeId: unitId,
          key: REDIS_URL_KEY,
        },
      },
      create: {
        projectId,
        scopeType: RuntimeConfigScopeType.UNIT,
        scopeId: unitId,
        deployableUnitId: unitId,
        scope: 'UNIT',
        requirementId: requirement?.id ?? null,
        key: REDIS_URL_KEY,
        valueEncrypted: encrypted,
        isSensitive: true,
        source: PROVIDER,
        provider: PROVIDER,
        providerRef: connectionId,
        createdBy: 'system:redis-provision',
        updatedBy: 'system:redis-provision',
        lastRotatedAt: now,
      },
      update: {
        valueEncrypted: encrypted,
        isSensitive: true,
        source: PROVIDER,
        provider: PROVIDER,
        providerRef: connectionId,
        requirementId: requirement?.id ?? null,
        updatedBy: 'system:redis-provision',
        lastRotatedAt: now,
      },
    });
    if (requirement) {
      await prisma.runtimeConfigRequirement.update({
        where: { id: requirement.id },
        data: { status: RuntimeConfigRequirementStatus.CONFIGURED },
      });
    }
    await prisma.deployableUnit.update({
      where: { id: unitId },
      data: { configRevision: { increment: 1 } },
    });
  }
}

function decryptProviderSecretsLocal(encrypted: string): {
  accessKey: string;
  secretKey: string;
} {
  const parsed = JSON.parse(decryptCredential(encrypted)) as {
    accessKey?: string;
    secretKey?: string;
  };
  if (!parsed.accessKey || !parsed.secretKey) {
    throw new Error('Aliyun credentials incomplete');
  }
  return { accessKey: parsed.accessKey, secretKey: parsed.secretKey };
}

function asMeta(value: unknown): Meta {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Meta) : {};
}

function readSafeError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 1500);
  return String(error ?? '').slice(0, 1500);
}
