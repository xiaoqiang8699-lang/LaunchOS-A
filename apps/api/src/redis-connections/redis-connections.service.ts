import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DatabaseTestStatus,
  RedisConnectionStatus,
  RedisTlsMode,
  RuntimeConfigRequirementStatus,
  RuntimeConfigScopeType,
  SecretAuditAction,
  WorkspaceRole,
} from '@launchos/database';
import {
  buildRedisUrl,
  decryptCredential,
  encryptCredential,
  type RedisTlsModeInput,
} from '@launchos/shared';
import { PrismaService } from '../database/prisma.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import {
  testRedisControlPlane,
  type RedisTestInput,
  type RedisTestResult,
} from './redis-control-plane-tester';
import { testRedisTargetServer } from './redis-target-server-tester';
import type {
  CreateRedisConnectionDto,
  TestRedisConnectionDto,
  UpdateRedisConnectionDto,
} from './dto/redis-connection.dto';

const SECRET_WRITE_ROLES: WorkspaceRole[] = [WorkspaceRole.OWNER, WorkspaceRole.ADMIN];
const PROVIDER = 'REDIS_CONNECTION';
const REDIS_URL_KEY = 'REDIS_URL';

@Injectable()
export class RedisConnectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaceAccess: WorkspaceAccessService,
  ) {}

  async list(userId: string, projectId: string) {
    const { membership, project } = await this.workspaceAccess.requireProjectAccess(
      userId,
      projectId,
    );
    const connections = await this.prisma.redisConnection.findMany({
      where: { projectId, workspaceId: project.workspaceId },
      orderBy: { createdAt: 'desc' },
      include: {
        units: {
          include: {
            deployableUnit: { select: { id: true, name: true, type: true } },
          },
        },
      },
    });
    return {
      canEdit: SECRET_WRITE_ROLES.includes(membership.role),
      eligibleUnits: await this.listEligibleUnits(projectId),
      connections: connections.map((item) => this.toPublic(item)),
    };
  }

  async getSummary(userId: string, projectId: string) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    const [eligibleUnits, connections, configuredValues] = await Promise.all([
      this.listEligibleUnits(projectId),
      this.prisma.redisConnection.findMany({
        where: { projectId },
        include: {
          units: {
            include: { deployableUnit: { select: { id: true, name: true } } },
          },
        },
        orderBy: { updatedAt: 'desc' },
      }),
      this.prisma.runtimeConfigValue.findMany({
        where: { projectId, key: REDIS_URL_KEY },
        select: {
          scopeType: true,
          scopeId: true,
          provider: true,
          providerRef: true,
          source: true,
        },
      }),
    ]);

    const missingUnits = eligibleUnits.filter((unit) => {
      const hasUnitValue = configuredValues.some(
        (value) =>
          value.scopeType === RuntimeConfigScopeType.UNIT && value.scopeId === unit.id,
      );
      const hasProjectValue = configuredValues.some(
        (value) => value.scopeType === RuntimeConfigScopeType.PROJECT,
      );
      return !hasUnitValue && !hasProjectValue;
    });

    const primary = connections[0] ?? null;
    return {
      canEdit: SECRET_WRITE_ROLES.includes(membership.role),
      needsRedis: eligibleUnits.length > 0,
      missingRequired: missingUnits.length > 0,
      missingUnits,
      connection: primary ? this.toPublic(primary) : null,
      connectionCount: connections.length,
    };
  }

  async test(userId: string, projectId: string, dto: TestRedisConnectionDto) {
    const { membership, project } = await this.workspaceAccess.requireProjectAccess(
      userId,
      projectId,
    );
    this.requireSecretWrite(membership.role);
    return this.runTest(project.workspaceId, {
      host: dto.host,
      port: dto.port,
      username: dto.username,
      password: dto.password,
      databaseIndex: dto.databaseIndex ?? 0,
      tlsMode: dto.tlsMode ?? 'AUTO',
      testLocation: dto.testLocation ?? 'AUTO',
      serverInstanceId: dto.serverInstanceId,
    });
  }

  async create(userId: string, projectId: string, dto: CreateRedisConnectionDto) {
    const { membership, project } = await this.workspaceAccess.requireProjectAccess(
      userId,
      projectId,
    );
    this.requireSecretWrite(membership.role);
    const unitIds = [...new Set(dto.unitIds)];
    await this.assertEligibleUnits(projectId, unitIds);
    await this.assertManualReplaceConfirmed(projectId, unitIds, dto.confirmReplaceManual);

    const testResult = await this.runTest(project.workspaceId, {
      host: dto.host,
      port: dto.port,
      username: dto.username,
      password: dto.password,
      databaseIndex: dto.databaseIndex ?? 0,
      tlsMode: dto.tlsMode ?? 'AUTO',
      testLocation: dto.testLocation ?? 'AUTO',
      serverInstanceId: dto.serverInstanceId,
    });
    if (!testResult.success) {
      throw new BadRequestException({
        message: testResult.message,
        code: testResult.errorCode ?? 'UNKNOWN',
        location: testResult.location,
      });
    }

    const connection = await this.prisma.redisConnection.create({
      data: {
        workspaceId: project.workspaceId,
        projectId,
        name: dto.name.trim(),
        status: RedisConnectionStatus.CONNECTED,
        host: dto.host.trim(),
        port: dto.port,
        usernameEncrypted: dto.username?.trim()
          ? encryptCredential(dto.username.trim())
          : null,
        passwordEncrypted: dto.password ? encryptCredential(dto.password) : null,
        databaseIndex: dto.databaseIndex ?? 0,
        tlsMode: (dto.tlsMode ?? 'AUTO') as RedisTlsMode,
        createdBy: userId,
        updatedBy: userId,
        lastTestedAt: new Date(),
        lastTestStatus: DatabaseTestStatus.SUCCESS,
        lastTestErrorCode: null,
        lastTestLatencyMs: testResult.latencyMs,
        lastTestLocation: testResult.location,
        units: {
          create: unitIds.map((deployableUnitId) => ({ deployableUnitId })),
        },
      },
      include: {
        units: {
          include: { deployableUnit: { select: { id: true, name: true, type: true } } },
        },
      },
    });

    await this.bindRedisUrl(userId, projectId, connection.id, unitIds, {
      host: connection.host,
      port: connection.port,
      username: dto.username?.trim() || null,
      password: dto.password || null,
      databaseIndex: connection.databaseIndex,
      tlsMode: connection.tlsMode as RedisTlsModeInput,
    });

    return {
      connection: this.toPublic(connection),
      message: 'Redis 连接已保存，重新上线后生效。',
      test: {
        success: true,
        latencyMs: testResult.latencyMs,
        location: testResult.location,
      },
    };
  }

  async update(userId: string, projectId: string, id: string, dto: UpdateRedisConnectionDto) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    this.requireSecretWrite(membership.role);
    const existing = await this.requireConnection(projectId, id);

    const username =
      dto.username !== undefined
        ? dto.username.trim() || null
        : existing.usernameEncrypted
          ? decryptCredential(existing.usernameEncrypted)
          : null;
    const password =
      dto.password !== undefined && dto.password.length > 0
        ? dto.password
        : existing.passwordEncrypted
          ? decryptCredential(existing.passwordEncrypted)
          : null;

    const fields = {
      host: (dto.host ?? existing.host).trim(),
      port: dto.port ?? existing.port,
      username,
      password,
      databaseIndex: dto.databaseIndex ?? existing.databaseIndex,
      tlsMode: (dto.tlsMode ?? existing.tlsMode) as RedisTlsModeInput,
    };

    const unitIds = dto.unitIds
      ? [...new Set(dto.unitIds)]
      : existing.units.map((item) => item.deployableUnitId);
    await this.assertEligibleUnits(projectId, unitIds);
    await this.assertManualReplaceConfirmed(projectId, unitIds, dto.confirmReplaceManual);

    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { workspaceId: true },
    });
    const testResult = await this.runTest(project.workspaceId, {
      ...fields,
      testLocation: dto.testLocation ?? 'AUTO',
      serverInstanceId: dto.serverInstanceId,
    });
    if (!testResult.success) {
      await this.prisma.redisConnection.update({
        where: { id },
        data: {
          status: RedisConnectionStatus.FAILED,
          lastTestedAt: new Date(),
          lastTestStatus: DatabaseTestStatus.FAILED,
          lastTestErrorCode: testResult.errorCode ?? 'UNKNOWN',
          lastTestLatencyMs: testResult.latencyMs,
          lastTestLocation: testResult.location,
          updatedBy: userId,
        },
      });
      throw new BadRequestException({
        message: testResult.message,
        code: testResult.errorCode ?? 'UNKNOWN',
        location: testResult.location,
      });
    }

    await this.prisma.redisConnectionUnit.deleteMany({ where: { redisConnectionId: id } });
    const updated = await this.prisma.redisConnection.update({
      where: { id },
      data: {
        name: dto.name?.trim() || existing.name,
        host: fields.host,
        port: fields.port,
        usernameEncrypted: fields.username ? encryptCredential(fields.username) : null,
        passwordEncrypted: fields.password ? encryptCredential(fields.password) : null,
        databaseIndex: fields.databaseIndex,
        tlsMode: fields.tlsMode as RedisTlsMode,
        status: RedisConnectionStatus.CONNECTED,
        updatedBy: userId,
        lastTestedAt: new Date(),
        lastTestStatus: DatabaseTestStatus.SUCCESS,
        lastTestErrorCode: null,
        lastTestLatencyMs: testResult.latencyMs,
        lastTestLocation: testResult.location,
        units: {
          create: unitIds.map((deployableUnitId) => ({ deployableUnitId })),
        },
      },
      include: {
        units: {
          include: { deployableUnit: { select: { id: true, name: true, type: true } } },
        },
      },
    });

    await this.clearProviderBindings(id);
    await this.bindRedisUrl(userId, projectId, id, unitIds, fields);
    return {
      connection: this.toPublic(updated),
      message: 'Redis 连接已更新，重新上线后生效。',
    };
  }

  async getDeleteImpact(userId: string, projectId: string, id: string) {
    await this.workspaceAccess.requireProjectAccess(userId, projectId);
    const connection = await this.requireConnection(projectId, id);
    return {
      id,
      message: '删除后，以下组成下一次上线将缺少 Redis 连接：',
      affectedUnits: connection.units.map((item) => ({
        id: item.deployableUnit.id,
        name: item.deployableUnit.name,
      })),
      currentInstancesKeepRunning: true,
    };
  }

  async remove(userId: string, projectId: string, id: string) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    this.requireSecretWrite(membership.role);
    const connection = await this.requireConnection(projectId, id);
    const unitIds = connection.units.map((item) => item.deployableUnitId);

    await this.clearProviderBindings(id);
    for (const unitId of unitIds) {
      await this.prisma.runtimeConfigValue.deleteMany({
        where: {
          projectId,
          scopeType: RuntimeConfigScopeType.UNIT,
          scopeId: unitId,
          key: REDIS_URL_KEY,
          provider: PROVIDER,
          providerRef: id,
        },
      });
      await this.prisma.runtimeConfigRequirement.updateMany({
        where: { deployableUnitId: unitId, key: REDIS_URL_KEY },
        data: { status: RuntimeConfigRequirementStatus.DETECTED },
      });
      await this.prisma.deployableUnit.update({
        where: { id: unitId },
        data: { configRevision: { increment: 1 } },
      });
      await this.prisma.secretAuditEvent.create({
        data: {
          projectId,
          deployableUnitId: unitId,
          scopeType: RuntimeConfigScopeType.UNIT,
          scopeId: unitId,
          key: REDIS_URL_KEY,
          action: SecretAuditAction.DELETED,
          actorUserId: userId,
          metadata: { fromProvider: PROVIDER },
        },
      });
    }

    await this.prisma.redisConnection.delete({ where: { id } });
    return {
      deleted: true,
      message: 'Redis 连接已删除。当前应用仍在使用上次上线时的配置。',
    };
  }

  async validateForDeploy(projectId: string, unitId: string): Promise<void> {
    const binding = await this.prisma.redisConnectionUnit.findFirst({
      where: { deployableUnitId: unitId, redisConnection: { projectId } },
      include: { redisConnection: true },
    });
    if (!binding) return;

    const connection = binding.redisConnection;
    const password = connection.passwordEncrypted
      ? decryptCredential(connection.passwordEncrypted)
      : null;
    const username = connection.usernameEncrypted
      ? decryptCredential(connection.usernameEncrypted)
      : null;
    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { workspaceId: true },
    });
    const server = await this.findPreferredServer(project.workspaceId, projectId);
    const result = await this.runTest(project.workspaceId, {
      host: connection.host,
      port: connection.port,
      username,
      password,
      databaseIndex: connection.databaseIndex,
      tlsMode: connection.tlsMode as RedisTlsModeInput,
      testLocation: server ? 'TARGET_SERVER' : 'CONTROL_PLANE',
      serverInstanceId: server?.id,
      timeoutMs: 8_000,
    });

    await this.prisma.redisConnection.update({
      where: { id: connection.id },
      data: {
        status: result.success
          ? RedisConnectionStatus.CONNECTED
          : RedisConnectionStatus.FAILED,
        lastTestedAt: new Date(),
        lastTestStatus: result.success ? DatabaseTestStatus.SUCCESS : DatabaseTestStatus.FAILED,
        lastTestErrorCode: result.success ? null : result.errorCode ?? 'UNKNOWN',
        lastTestLatencyMs: result.latencyMs,
        lastTestLocation: result.location,
      },
    });

    if (!result.success) {
      throw new BadRequestException({
        message: 'Redis 服务目前无法连接，请检查 Redis 设置。',
        code: 'REDIS_UNREACHABLE',
        errorCode: result.errorCode,
        location: result.location,
      });
    }
  }

  private async runTest(
    workspaceId: string,
    input: RedisTestInput & {
      testLocation?: 'CONTROL_PLANE' | 'TARGET_SERVER' | 'AUTO';
      serverInstanceId?: string;
      timeoutMs?: number;
    },
  ): Promise<RedisTestResult> {
    const location = input.testLocation ?? 'AUTO';
    const preferredServer = input.serverInstanceId
      ? await this.prisma.serverInstance.findFirst({
          where: { id: input.serverInstanceId, workspaceId },
        })
      : await this.findPreferredServer(workspaceId);

    if (location === 'TARGET_SERVER' || (location === 'AUTO' && preferredServer)) {
      if (!preferredServer) {
        throw new BadRequestException('未找到可用于测试的目标服务器');
      }
      const serverPassword = decryptCredential(preferredServer.credentialEncrypted);
      const target = await testRedisTargetServer(
        {
          host: input.host.trim(),
          port: input.port,
          username: input.username,
          password: input.password,
          databaseIndex: input.databaseIndex ?? 0,
          tlsMode: input.tlsMode,
          timeoutMs: input.timeoutMs,
        },
        {
          host: preferredServer.host,
          port: preferredServer.port,
          username: preferredServer.username,
          password: serverPassword,
        },
      );
      if (target.success || location === 'TARGET_SERVER') {
        return target;
      }
    }

    return testRedisControlPlane({
      host: input.host.trim(),
      port: input.port,
      username: input.username,
      password: input.password,
      databaseIndex: input.databaseIndex ?? 0,
      tlsMode: input.tlsMode,
      timeoutMs: input.timeoutMs,
    });
  }

  private async bindRedisUrl(
    userId: string,
    projectId: string,
    connectionId: string,
    unitIds: string[],
    fields: {
      host: string;
      port: number;
      username?: string | null;
      password?: string | null;
      databaseIndex: number;
      tlsMode: RedisTlsModeInput;
    },
  ): Promise<void> {
    const redisUrl = buildRedisUrl(fields);
    const encrypted = encryptCredential(redisUrl);
    const now = new Date();

    for (const unitId of unitIds) {
      const requirement = await this.prisma.runtimeConfigRequirement.findUnique({
        where: {
          deployableUnitId_key: { deployableUnitId: unitId, key: REDIS_URL_KEY },
        },
      });
      await this.prisma.runtimeConfigValue.upsert({
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
          createdBy: userId,
          updatedBy: userId,
          lastRotatedAt: now,
        },
        update: {
          valueEncrypted: encrypted,
          isSensitive: true,
          source: PROVIDER,
          provider: PROVIDER,
          providerRef: connectionId,
          requirementId: requirement?.id ?? null,
          updatedBy: userId,
          lastRotatedAt: now,
        },
      });
      if (requirement) {
        await this.prisma.runtimeConfigRequirement.update({
          where: { id: requirement.id },
          data: { status: RuntimeConfigRequirementStatus.CONFIGURED },
        });
      }
      await this.prisma.deployableUnit.update({
        where: { id: unitId },
        data: { configRevision: { increment: 1 } },
      });
      await this.prisma.secretAuditEvent.create({
        data: {
          projectId,
          deployableUnitId: unitId,
          scopeType: RuntimeConfigScopeType.UNIT,
          scopeId: unitId,
          key: REDIS_URL_KEY,
          action: SecretAuditAction.UPDATED,
          actorUserId: userId,
          metadata: { provider: PROVIDER },
        },
      });
    }
  }

  private async clearProviderBindings(connectionId: string): Promise<void> {
    await this.prisma.runtimeConfigValue.deleteMany({
      where: { provider: PROVIDER, providerRef: connectionId },
    });
  }

  private async assertEligibleUnits(projectId: string, unitIds: string[]): Promise<void> {
    if (unitIds.length === 0) {
      throw new BadRequestException('请选择需要绑定 Redis 的组成');
    }
    const eligible = await this.listEligibleUnits(projectId);
    const eligibleIds = new Set(eligible.map((item) => item.id));
    for (const unitId of unitIds) {
      if (!eligibleIds.has(unitId)) {
        throw new BadRequestException('只能绑定到需要 REDIS_URL 的组成');
      }
    }
  }

  private async assertManualReplaceConfirmed(
    projectId: string,
    unitIds: string[],
    confirmed?: boolean,
  ): Promise<void> {
    const manuals = await this.prisma.runtimeConfigValue.findMany({
      where: {
        projectId,
        key: REDIS_URL_KEY,
        scopeType: RuntimeConfigScopeType.UNIT,
        scopeId: { in: unitIds },
        OR: [{ provider: null }, { provider: { not: PROVIDER } }],
      },
      select: { scopeId: true },
    });
    if (manuals.length > 0 && !confirmed) {
      throw new BadRequestException({
        message: '当前 Redis 连接为手动配置，绑定新的 Redis 服务将替换当前配置。',
        code: 'MANUAL_REDIS_URL_EXISTS',
        requiresConfirm: true,
      });
    }
  }

  private async listEligibleUnits(projectId: string) {
    const requirements = await this.prisma.runtimeConfigRequirement.findMany({
      where: {
        projectId,
        key: REDIS_URL_KEY,
        managedByLaunchOS: false,
      },
      select: {
        deployableUnitId: true,
        required: true,
        deployableUnit: { select: { id: true, name: true, type: true } },
      },
    });
    return requirements.map((item) => ({
      id: item.deployableUnit.id,
      name: item.deployableUnit.name,
      type: item.deployableUnit.type,
      required: item.required,
    }));
  }

  private async findPreferredServer(workspaceId: string, projectId?: string) {
    if (projectId) {
      const running = await this.prisma.serviceInstance.findFirst({
        where: {
          projectId,
          status: 'RUNNING',
          serverInstanceId: { not: null },
        },
        orderBy: { updatedAt: 'desc' },
        select: { serverInstanceId: true },
      });
      if (running?.serverInstanceId) {
        const server = await this.prisma.serverInstance.findFirst({
          where: { id: running.serverInstanceId, workspaceId },
        });
        if (server) return server;
      }
    }
    return this.prisma.serverInstance.findFirst({
      where: { workspaceId },
      orderBy: { updatedAt: 'desc' },
    });
  }

  private async requireConnection(projectId: string, id: string) {
    const connection = await this.prisma.redisConnection.findFirst({
      where: { id, projectId },
      include: {
        units: {
          include: { deployableUnit: { select: { id: true, name: true, type: true } } },
        },
      },
    });
    if (!connection) {
      throw new NotFoundException('未找到 Redis 连接');
    }
    return connection;
  }

  private toPublic(connection: {
    id: string;
    name: string;
    status: RedisConnectionStatus;
    host: string;
    port: number;
    usernameEncrypted: string | null;
    passwordEncrypted: string | null;
    databaseIndex: number;
    tlsMode: RedisTlsMode;
    source?: string;
    cloudResourceId?: string | null;
    lastTestedAt: Date | null;
    lastTestStatus: DatabaseTestStatus | null;
    lastTestErrorCode: string | null;
    lastTestLatencyMs: number | null;
    lastTestLocation: string | null;
    createdAt: Date;
    updatedAt: Date;
    units: Array<{ deployableUnit: { id: string; name: string; type?: string } }>;
  }) {
    return {
      id: connection.id,
      name: connection.name,
      status: connection.status,
      host: connection.host,
      port: connection.port,
      usernameConfigured: Boolean(connection.usernameEncrypted),
      passwordConfigured: Boolean(connection.passwordEncrypted),
      databaseIndex: connection.databaseIndex,
      tlsMode: connection.tlsMode,
      source: connection.source || 'MANUAL',
      cloudResourceId: connection.cloudResourceId || null,
      lastTestedAt: connection.lastTestedAt,
      lastTestStatus: connection.lastTestStatus,
      lastTestErrorCode: connection.lastTestErrorCode,
      lastTestLatencyMs: connection.lastTestLatencyMs,
      lastTestLocation: connection.lastTestLocation,
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
      boundUnits: connection.units.map((item) => ({
        id: item.deployableUnit.id,
        name: item.deployableUnit.name,
        type: item.deployableUnit.type,
      })),
    };
  }

  private requireSecretWrite(role: WorkspaceRole): void {
    if (!SECRET_WRITE_ROLES.includes(role)) {
      throw new ForbiddenException('仅管理员可以管理 Redis 连接');
    }
  }

  async listEligibleUnitsPublic(projectId: string) {
    return this.listEligibleUnits(projectId);
  }

  async assertUnitsForProvision(
    projectId: string,
    unitIds: string[],
    confirmReplaceManual?: boolean,
  ): Promise<void> {
    await this.assertEligibleUnits(projectId, unitIds);
    await this.assertManualReplaceConfirmed(projectId, unitIds, confirmReplaceManual);
  }

  async unlinkManaged(userId: string, projectId: string, connectionId: string): Promise<void> {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    this.requireSecretWrite(membership.role);
    const connection = await this.requireConnection(projectId, connectionId);
    const unitIds = connection.units.map((item) => item.deployableUnitId);
    await this.clearProviderBindings(connection.id);
    await this.prisma.redisConnectionUnit.deleteMany({
      where: { redisConnectionId: connection.id },
    });
    for (const unitId of unitIds) {
      await this.prisma.runtimeConfigRequirement.updateMany({
        where: { deployableUnitId: unitId, key: REDIS_URL_KEY },
        data: { status: RuntimeConfigRequirementStatus.DETECTED },
      });
      await this.prisma.deployableUnit.update({
        where: { id: unitId },
        data: { configRevision: { increment: 1 } },
      });
      await this.prisma.secretAuditEvent.create({
        data: {
          projectId,
          deployableUnitId: unitId,
          scopeType: RuntimeConfigScopeType.UNIT,
          scopeId: unitId,
          key: REDIS_URL_KEY,
          action: SecretAuditAction.DELETED,
          actorUserId: userId,
          metadata: { provider: PROVIDER, action: 'unlink-managed' },
        },
      });
    }
  }

  async markUnavailable(userId: string, projectId: string, connectionId: string): Promise<void> {
    await this.workspaceAccess.requireProjectAccess(userId, projectId);
    await this.clearProviderBindings(connectionId);
    await this.prisma.redisConnection.update({
      where: { id: connectionId },
      data: { status: RedisConnectionStatus.UNAVAILABLE },
    });
    const units = await this.prisma.redisConnectionUnit.findMany({
      where: { redisConnectionId: connectionId },
      select: { deployableUnitId: true },
    });
    for (const unit of units) {
      await this.prisma.deployableUnit.update({
        where: { id: unit.deployableUnitId },
        data: { configRevision: { increment: 1 } },
      });
    }
  }

  /**
   * Before deploy: provider-managed REDIS_URL must PING from Target Server.
   */
  async assertManagedRedisReachableForDeploy(
    projectId: string,
    deployableUnitId: string,
  ): Promise<void> {
    const value = await this.prisma.runtimeConfigValue.findFirst({
      where: {
        projectId,
        deployableUnitId,
        key: REDIS_URL_KEY,
        provider: PROVIDER,
        providerRef: { not: null },
      },
    });
    if (!value?.providerRef) return;
    const connection = await this.prisma.redisConnection.findFirst({
      where: { id: value.providerRef, projectId },
    });
    if (!connection || connection.status === RedisConnectionStatus.UNAVAILABLE) {
      throw new BadRequestException({
        message: 'Redis 服务目前无法连接，请检查 Redis 状态。',
        code: 'REDIS_UNREACHABLE',
      });
    }
    const password = connection.passwordEncrypted
      ? decryptCredential(connection.passwordEncrypted)
      : undefined;
    const username = connection.usernameEncrypted
      ? decryptCredential(connection.usernameEncrypted)
      : undefined;
    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { workspaceId: true },
    });
    const result = await this.runTest(project.workspaceId, {
      host: connection.host,
      port: connection.port,
      username,
      password,
      databaseIndex: connection.databaseIndex,
      tlsMode: connection.tlsMode as RedisTlsModeInput,
      testLocation: 'TARGET_SERVER',
      timeoutMs: 10_000,
    });
    if (!result.success) {
      throw new BadRequestException({
        message: 'Redis 服务目前无法连接，请检查 Redis 状态。',
        code: 'REDIS_UNREACHABLE',
        errorCode: result.errorCode,
      });
    }
  }
}
