import {
  CloudResourceStatus,
  DatabaseSslMode,
  PrismaClient,
  type Prisma,
} from '@launchos/database';
import {
  AlibabaCloudDatabaseProvider,
  listRdsInstancesByDescription,
} from '@launchos/providers';
import {
  classifyCloudDatabaseError,
  cloudDatabaseErrorUserMessage,
  decryptCredential,
  encryptCredential,
  withRedisLock,
  type DatabaseProvisionPhase,
} from '@launchos/shared';

type PgClientLike = {
  connect(): Promise<void>;
  query(sql: string): Promise<{ rows?: Array<{ ok?: number }> }>;
  end(): Promise<void>;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Client: PgClient } = require('pg') as {
  Client: new (config: Record<string, unknown>) => PgClientLike;
};

type Meta = Record<string, unknown>;

const TOTAL_TIMEOUT_MS = 25 * 60_000;

/**
 * Executes Aliyun RDS provisioning for a CloudResource DATABASE job.
 * Secrets stay in memory / encrypted fields only — never logged.
 */
export async function executeDatabaseProvision(
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
    throw new Error('managed database password missing');
  }
  const password = decryptCredential(passwordEncrypted);
  const databaseName = String(meta.databaseName || 'launchos_app');
  const username = String(meta.username || 'lo_app');
  const unitIds = Array.isArray(meta.unitIds)
    ? meta.unitIds.filter((item): item is string => typeof item === 'string')
    : [];
  const tier = (meta.tier as 'DEV' | 'SMALL' | 'STANDARD') || 'DEV';
  const operationId = String(meta.operationId || cloudResourceId);
  const region = resource.region || String(meta.region || 'cn-hangzhou');

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
    throw new Error('RDS provision requires ProviderAccount type ALIYUN (not ALIYUN_DNS)');
  }
  const secrets = decryptProviderSecretsLocal(account.credentialEncrypted);

  const provider = new AlibabaCloudDatabaseProvider({
    accessKey: secrets.accessKey,
    secretKey: secrets.secretKey,
    region,
  });

  const updatePhase = async (phase: DatabaseProvisionPhase, patch: Meta = {}) => {
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
          // keep password encrypted only
          passwordEncrypted: current.passwordEncrypted || passwordEncrypted,
        } as Prisma.InputJsonObject,
      },
    });
  };

  try {
    if (Date.now() - started > TOTAL_TIMEOUT_MS) {
      throw new Error('Timed out provisioning database');
    }

    const instanceName = `launchos-${databaseName}`.slice(0, 64);
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
      ...(createAlreadyDone
        ? { createInstanceCompleted: true, resumedWithoutCreate: true }
        : {}),
    });

    let dbInstanceId = await resolveExistingDbInstanceId({
      prisma,
      cloudResourceId,
      provider,
      region: placement.region,
      instanceName,
    });

    // Hard rule: bound CloudResource must never call CreateDBInstance again.
    if (dbInstanceId) {
      const status = await provider.getInstanceStatus(dbInstanceId);
      if (status.status === 'DELETED' || status.status === 'FAILED') {
        throw Object.assign(
          new Error(
            `已绑定的 RDS ${dbInstanceId} 状态异常（${status.rawStatus || status.status}），禁止 CreateDBInstance。`,
          ),
          { code: 'BOUND_RDS_UNUSABLE' },
        );
      }
    } else if (createAlreadyDone || resource.providerResourceId) {
      throw Object.assign(
        new Error('providerResourceId 已存在或 createInstanceCompleted=true，但无法解析实例；禁止 CreateDBInstance。'),
        { code: 'BOUND_RDS_MISSING' },
      );
    } else {
      dbInstanceId = await withRedisLock(
        `rds-create:${cloudResourceId}`,
        120_000,
        async () => {
          // Re-check inside lock — never CreateDBInstance twice for one CloudResource.
          const existing = await resolveExistingDbInstanceId({
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
              new Error('检测到 providerResourceId / createInstanceCompleted，禁止 CreateDBInstance。'),
              { code: 'CREATE_FORBIDDEN_AFTER_BIND' },
            );
          }

          try {
            const created = await provider.createPostgresInstance({
              region: placement.region,
              zoneId: placement.zoneId,
              vpcId: placement.vpcId,
              vSwitchId: placement.vSwitchId,
              instanceName,
              securityIpList: placement.whitelist.join(','),
              clientToken,
              tier,
            });
            const id = created.dbInstanceId;
            await prisma.cloudResource.update({
              where: { id: cloudResourceId },
              data: {
                externalId: id,
                providerResourceId: id,
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
                  providerResourceId: id,
                } as Prisma.InputJsonObject,
              },
            });
            return id;
          } catch (error) {
            // Timeout / unknown failure after request may still have created the instance.
            const recovered = await resolveExistingDbInstanceId({
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
                },
              });
              return recovered;
            }
            throw error;
          }
        },
      );
    }

    if (!dbInstanceId) {
      throw new Error('RDS instance id unresolved');
    }

    await provider.waitUntilRunning(dbInstanceId, Math.max(60_000, TOTAL_TIMEOUT_MS - (Date.now() - started)));
    // VPC_PRIVATE: include VPC CIDR for private clients. PUBLIC_LIMITED: only target IPs (never 0.0.0.0/0).
    if (
      placement.networkMode === 'VPC_PRIVATE' &&
      typeof provider.ensurePrivateWhitelist === 'function'
    ) {
      await provider.ensurePrivateWhitelist(dbInstanceId, placement.whitelist);
    } else {
      await provider.setWhitelist({
        dbInstanceId,
        securityIpList: placement.whitelist.join(','),
      });
    }

    await updatePhase('CREATING_ACCOUNT', {
      providerResourceId: dbInstanceId,
      createInstanceCompleted: true,
    });
    await provider.createDatabase({ dbInstanceId, databaseName });
    await provider.createAccount({
      dbInstanceId,
      accountName: username,
      accountPassword: password,
    });
    await provider.grantAccountPrivilege({
      dbInstanceId,
      accountName: username,
      databaseName,
    });

    let connection = await provider.getConnectionInfo(
      dbInstanceId,
      placement.networkMode === 'VPC_PRIVATE',
    );
    // Same-VPC private path preferred. When placement is PUBLIC_LIMITED (ECS VPC
    // lookup failed / different network), Target Server must use the public endpoint.
    if (placement.networkMode === 'PUBLIC_LIMITED' && provider.allocatePublicConnection) {
      try {
        connection = await provider.allocatePublicConnection(dbInstanceId, 5432);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/otherendpoint\.exist|already|exists|duplicat/i.test(message)) {
          connection = await provider.getConnectionInfo(dbInstanceId, false);
        } else {
          // Last resort: keep whatever endpoint we already resolved.
          const fallback = await provider.getConnectionInfo(dbInstanceId, false).catch(() => null);
          if (fallback?.host) connection = fallback;
          else throw error;
        }
      }
    }

    await updatePhase('TESTING_CONNECTION', {
      connectionHost: connection.host,
      connectionPort: connection.port,
    });

    const testOk = await testSelectOneFromTarget({
      prisma,
      workspaceId: resource.workspaceId,
      projectId: resource.projectId,
      serverInstanceId:
        typeof meta.serverInstanceId === 'string' ? meta.serverInstanceId : server.serverInstanceId,
      host: connection.host,
      port: connection.port,
      databaseName,
      username,
      password,
    });

    if (!testOk) {
      throw Object.assign(new Error('Target Server SELECT 1 failed'), {
        code: 'CONNECTION_TEST_FAILED',
      });
    }

    await updatePhase('BINDING');

    // Bind via prisma (mirror DatabaseConnectionsService.createManagedFromProvision)
    const existingConn = await prisma.databaseConnection.findFirst({
      where: { cloudResourceId },
    });
    let connectionId = existingConn?.id;
    if (!connectionId) {
      const createdConn = await prisma.databaseConnection.create({
        data: {
          workspaceId: resource.workspaceId,
          projectId: resource.projectId,
          name: `LaunchOS RDS (${databaseName})`,
          status: 'CONNECTED',
          host: connection.host,
          port: connection.port,
          databaseName,
          username,
          passwordEncrypted: encryptCredential(password),
          sslMode: DatabaseSslMode.DISABLE,
          source: 'ALIYUN_RDS',
          cloudResourceId,
          createdBy: 'system:db-provision',
          updatedBy: 'system:db-provision',
          lastTestedAt: new Date(),
          lastTestStatus: 'SUCCESS',
          units: {
            create: unitIds.map((deployableUnitId) => ({ deployableUnitId })),
          },
        },
      });
      connectionId = createdConn.id;
      await bindDatabaseUrl(prisma, resource.projectId, connectionId, unitIds, {
        host: connection.host,
        port: connection.port,
        databaseName,
        username,
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
        externalId: dbInstanceId,
        providerResourceId: dbInstanceId,
        region: placement.region,
        metadata: {
          ...latest,
          phase: 'DONE',
          connectionHost: connection.host,
          connectionPort: connection.port,
          networkMode: placement.networkMode,
          databaseConnectionId: connectionId,
          passwordEncrypted: latest.passwordEncrypted || passwordEncrypted,
          errorCode: null,
          errorMessage: null,
        } as Prisma.InputJsonObject,
      },
    });
  } catch (error) {
    const classified =
      (error as { code?: string }).code === 'CONNECTION_TEST_FAILED'
        ? { code: 'CONNECTION_TEST_FAILED' as const, technicalMessage: 'SELECT 1 failed' }
        : (error as { code?: string }).code === 'RDS_CONNECTION_ENDPOINT_MISSING'
          ? {
              code: 'RDS_CONNECTION_ENDPOINT_MISSING' as const,
              technicalMessage: 'RDS_CONNECTION_ENDPOINT_MISSING',
            }
          : classifyCloudDatabaseError(error);
    const providerMeta = extractSafeProviderError(error);
    const latest = asMeta(
      (await prisma.cloudResource.findUnique({ where: { id: cloudResourceId } }))?.metadata,
    );
    await prisma.cloudResource.update({
      where: { id: cloudResourceId },
      data: {
        status: CloudResourceStatus.FAILED,
        metadata: {
          ...latest,
          phase: 'FAILED',
          errorCode: classified.code,
          errorMessage: cloudDatabaseErrorUserMessage(
            classified.code,
            readSafeError(error),
          ),
          technicalMessage: readSafeError(error) || classified.technicalMessage,
          providerRequestId: providerMeta.requestId,
          providerErrorCode: providerMeta.errorCode,
          passwordEncrypted: latest.passwordEncrypted || passwordEncrypted,
        } as Prisma.InputJsonObject,
      },
    });
    throw error;
  }
}

function readSafeError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 300);
  return String(error ?? '').slice(0, 300);
}

function extractSafeProviderError(error: unknown): {
  requestId?: string;
  errorCode?: string;
} {
  if (!error || typeof error !== 'object') {
    const text = String(error ?? '');
    const fromText = text.match(/request id:\s*([A-Za-z0-9-]+)/i);
    return { requestId: fromText?.[1]?.slice(0, 120) };
  }
  const record = error as {
    data?: { RequestId?: string; Code?: string; requestId?: string };
    requestId?: string;
    code?: string;
    message?: string;
  };
  const message = record.message || '';
  const requestId =
    record.data?.RequestId ||
    record.data?.requestId ||
    (typeof record.requestId === 'string' ? record.requestId : undefined) ||
    message.match(/request id:\s*([A-Za-z0-9-]+)/i)?.[1];
    const errorCode =
    record.data?.Code ||
    (typeof record.code === 'string' ? record.code : undefined) ||
    message.match(/\b(ServiceLinkedRole\.NotExist|InvalidConcurrentOperate|[A-Za-z]+(?:\.[A-Za-z]+)+)\b/)?.[1];
  const safe = (value?: string) => {
    if (!value) return undefined;
    if (/accesskey|secret|authorization|signature|password|postgres:\/\//i.test(value)) {
      return undefined;
    }
    return value.slice(0, 120);
  };
  return { requestId: safe(requestId), errorCode: safe(errorCode) };
}

function asMeta(value: unknown): Meta {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Meta)
    : {};
}

/**
 * Resume-safe: never CreateDBInstance when this CloudResource already has an ID,
 * or when Aliyun already has exactly one instance matching our description.
 * Multiple matches → stop for human decision (do not create, do not guess).
 */
async function resolveExistingDbInstanceId(input: {
  prisma: PrismaClient;
  cloudResourceId: string;
  provider: AlibabaCloudDatabaseProvider;
  region: string;
  instanceName: string;
}): Promise<string | undefined> {
  const fresh = await input.prisma.cloudResource.findUnique({
    where: { id: input.cloudResourceId },
    select: { providerResourceId: true, externalId: true },
  });
  const bound = fresh?.providerResourceId?.trim() || fresh?.externalId?.trim();
  if (bound) return bound;

  const matches = await listRdsInstancesByDescription(
    input.provider,
    input.region,
    input.instanceName,
  );
  const exact = matches.filter(
    (item) =>
      item.description === input.instanceName ||
      item.description?.startsWith(input.instanceName),
  );
  const candidates = exact.length > 0 ? exact : matches;
  if (candidates.length === 0) return undefined;

  if (candidates.length > 1) {
    const ids = candidates.map((item) => item.dbInstanceId).join(', ');
    throw Object.assign(
      new Error(
        `检测到多个同名 RDS（${ids}），已禁止再次 CreateDBInstance。请人工确认绑定哪一台后再 resume。`,
      ),
      {
        code: 'RDS_RECONCILE_AMBIGUOUS',
        providerResourceIds: candidates.map((item) => item.dbInstanceId),
      },
    );
  }

  const chosen = candidates[0]?.dbInstanceId;
  if (!chosen) return undefined;

  await input.prisma.cloudResource.update({
    where: { id: input.cloudResourceId },
    data: {
      externalId: chosen,
      providerResourceId: chosen,
    },
  });
  return chosen;
}

function decryptProviderSecretsLocal(encrypted: string): {
  accessKey: string;
  secretKey: string;
} {
  const raw = decryptCredential(encrypted);
  const parsed = JSON.parse(raw) as { accessKey?: string; secretKey?: string };
  if (!parsed.accessKey || !parsed.secretKey) {
    throw new Error('Invalid provider secrets');
  }
  return { accessKey: parsed.accessKey, secretKey: parsed.secretKey };
}

async function resolveServerTarget(
  prisma: PrismaClient,
  workspaceId: string,
  projectId: string,
  meta: Meta,
): Promise<{ publicIp?: string; ecsInstanceId?: string; serverInstanceId?: string }> {
  if (typeof meta.serverInstanceId === 'string') {
    const server = await prisma.serverInstance.findFirst({
      where: { id: meta.serverInstanceId, workspaceId },
    });
    if (server) {
      return { publicIp: server.host, serverInstanceId: server.id };
    }
  }
  const cloudServer = await prisma.cloudResource.findFirst({
    where: {
      projectId,
      type: 'SERVER',
      status: CloudResourceStatus.RUNNING,
    },
    orderBy: { createdAt: 'desc' },
  });
  if (cloudServer?.providerResourceId) {
    return {
      ecsInstanceId: cloudServer.providerResourceId,
      publicIp: cloudServer.publicIp || undefined,
    };
  }
  const running = await prisma.serviceInstance.findFirst({
    where: { projectId, status: 'RUNNING', serverInstanceId: { not: null } },
    orderBy: { updatedAt: 'desc' },
  });
  if (running?.serverInstanceId) {
    const server = await prisma.serverInstance.findFirst({
      where: { id: running.serverInstanceId, workspaceId },
    });
    if (server) {
      return { publicIp: server.host, serverInstanceId: server.id };
    }
  }
  const anyServer = await prisma.serverInstance.findFirst({
    where: { workspaceId },
    orderBy: { updatedAt: 'desc' },
  });
  return anyServer
    ? { publicIp: anyServer.host, serverInstanceId: anyServer.id }
    : {};
}

async function testSelectOneFromTarget(input: {
  prisma: PrismaClient;
  workspaceId: string;
  projectId: string;
  serverInstanceId?: string;
  host: string;
  port: number;
  databaseName: string;
  username: string;
  password: string;
}): Promise<boolean> {
  // Prefer Target Server path when known — Control Plane often cannot reach VPC/private RDS.
  if (input.serverInstanceId) {
    try {
      const { decryptCredential: dec } = await import('@launchos/shared');
      const { RemoteRunner } = await import('@launchos/remote-runner');
      const server = await input.prisma.serverInstance.findUnique({
        where: { id: input.serverInstanceId },
      });
      if (server) {
        const runner = new RemoteRunner();
        await runner.connect({
          host: server.host,
          port: server.port,
          username: server.username,
          password: dec(server.credentialEncrypted),
        });
        const envPath = `/tmp/launchos-pg-test-${Date.now()}.env`;
        const envBody = [
          `PGHOST=${input.host}`,
          `PGPORT=${input.port}`,
          `PGDATABASE=${input.databaseName}`,
          `PGUSER=${input.username}`,
          `PGPASSWORD=${input.password}`,
        ].join('\n');
        try {
          await runner.writeTextFile(envPath, envBody, 0o600);
          const result = await runner.execute(
            `docker run --rm --env-file ${envPath} postgres:16-alpine psql -c "SELECT 1"`,
            { timeoutMs: 90_000 },
          );
          if (result.exitCode === 0 && /1 row/i.test(result.stdout + result.stderr)) {
            return true;
          }
        } finally {
          await runner.execute(`rm -f ${envPath}`, { timeoutMs: 5_000 }).catch(() => undefined);
          await runner.disconnect().catch(() => undefined);
        }
      }
    } catch {
      // fall through to control-plane probe
    }
  }

  try {
    const client = new PgClient({
      host: input.host,
      port: input.port,
      database: input.databaseName,
      user: input.username,
      password: input.password,
      connectionTimeoutMillis: 8000,
      ssl: false,
    });
    await client.connect();
    const result = await client.query('SELECT 1 as ok');
    await client.end();
    return Number(result.rows?.[0]?.ok) === 1;
  } catch {
    return false;
  }
}

async function bindDatabaseUrl(
  prisma: PrismaClient,
  projectId: string,
  connectionId: string,
  unitIds: string[],
  fields: {
    host: string;
    port: number;
    databaseName: string;
    username: string;
    password: string;
  },
): Promise<void> {
  const { buildPostgresDatabaseUrl } = await import('@launchos/shared');
  const databaseUrl = buildPostgresDatabaseUrl({
    ...fields,
    sslMode: 'DISABLE',
  });
  const encrypted = encryptCredential(databaseUrl);
  const now = new Date();
  for (const unitId of unitIds) {
    const requirement = await prisma.runtimeConfigRequirement.findUnique({
      where: { deployableUnitId_key: { deployableUnitId: unitId, key: 'DATABASE_URL' } },
    });
    await prisma.runtimeConfigValue.upsert({
      where: {
        scopeType_scopeId_key: {
          scopeType: 'UNIT',
          scopeId: unitId,
          key: 'DATABASE_URL',
        },
      },
      create: {
        projectId,
        scopeType: 'UNIT',
        scopeId: unitId,
        deployableUnitId: unitId,
        scope: 'UNIT',
        requirementId: requirement?.id ?? null,
        key: 'DATABASE_URL',
        valueEncrypted: encrypted,
        isSensitive: true,
        source: 'DATABASE_CONNECTION',
        provider: 'DATABASE_CONNECTION',
        providerRef: connectionId,
        createdBy: 'system:db-provision',
        updatedBy: 'system:db-provision',
        lastRotatedAt: now,
      },
      update: {
        valueEncrypted: encrypted,
        isSensitive: true,
        source: 'DATABASE_CONNECTION',
        provider: 'DATABASE_CONNECTION',
        providerRef: connectionId,
        requirementId: requirement?.id ?? null,
        updatedBy: 'system:db-provision',
        lastRotatedAt: now,
      },
    });
    if (requirement) {
      await prisma.runtimeConfigRequirement.update({
        where: { id: requirement.id },
        data: { status: 'CONFIGURED' },
      });
    }
    await prisma.deployableUnit.update({
      where: { id: unitId },
      data: { configRevision: { increment: 1 } },
    });
  }
}
