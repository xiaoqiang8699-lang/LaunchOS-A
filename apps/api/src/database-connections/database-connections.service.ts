import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DatabaseConnectionStatus,
  DatabaseEngine,
  DatabaseSslMode,
  DatabaseTestStatus,
  RuntimeConfigRequirementStatus,
  RuntimeConfigScopeType,
  SecretAuditAction,
  WorkspaceRole,
} from '@launchos/database';
import {
  buildPostgresDatabaseUrl,
  decryptCredential,
  encryptCredential,
  type DatabaseSslModeInput,
} from '@launchos/shared';
import { PrismaService } from '../database/prisma.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import {
  testPostgresControlPlane,
  type PostgresTestInput,
  type PostgresTestResult,
} from './postgres-control-plane-tester';
import { testPostgresTargetServer } from './postgres-target-server-tester';
import type {
  CreateDatabaseConnectionDto,
  TestDatabaseConnectionDto,
  UpdateDatabaseConnectionDto,
} from './dto/database-connection.dto';

const SECRET_WRITE_ROLES: WorkspaceRole[] = [WorkspaceRole.OWNER, WorkspaceRole.ADMIN];
const PROVIDER = 'DATABASE_CONNECTION';
const DATABASE_URL_KEY = 'DATABASE_URL';

@Injectable()
export class DatabaseConnectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaceAccess: WorkspaceAccessService,
  ) {}

  async list(userId: string, projectId: string) {
    const { membership, project } = await this.workspaceAccess.requireProjectAccess(
      userId,
      projectId,
    );
    const connections = await this.prisma.databaseConnection.findMany({
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

    const eligibleUnits = await this.listEligibleUnits(projectId);

    return {
      canEdit: SECRET_WRITE_ROLES.includes(membership.role),
      eligibleUnits,
      connections: connections.map((item) => this.toPublic(item)),
    };
  }

  async getSummary(userId: string, projectId: string) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    const [eligibleUnits, connections, configuredValues] = await Promise.all([
      this.listEligibleUnits(projectId),
      this.prisma.databaseConnection.findMany({
        where: { projectId },
        include: {
          units: {
            include: { deployableUnit: { select: { id: true, name: true } } },
          },
        },
        orderBy: { updatedAt: 'desc' },
      }),
      this.prisma.runtimeConfigValue.findMany({
        where: { projectId, key: DATABASE_URL_KEY },
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
      needsDatabase: eligibleUnits.length > 0,
      missingRequired: missingUnits.length > 0,
      missingUnits,
      connection: primary ? this.toPublic(primary) : null,
      connectionCount: connections.length,
    };
  }

  async test(userId: string, projectId: string, dto: TestDatabaseConnectionDto) {
    const { membership, project } = await this.workspaceAccess.requireProjectAccess(
      userId,
      projectId,
    );
    this.requireSecretWrite(membership.role);
    return this.runTest(project.workspaceId, {
      host: dto.host,
      port: dto.port,
      databaseName: dto.databaseName,
      username: dto.username,
      password: dto.password,
      sslMode: dto.sslMode ?? 'AUTO',
      testLocation: dto.testLocation ?? 'AUTO',
      serverInstanceId: dto.serverInstanceId,
    });
  }

  async create(userId: string, projectId: string, dto: CreateDatabaseConnectionDto) {
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
      databaseName: dto.databaseName,
      username: dto.username,
      password: dto.password,
      sslMode: dto.sslMode ?? 'AUTO',
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

    const connection = await this.prisma.databaseConnection.create({
      data: {
        workspaceId: project.workspaceId,
        projectId,
        name: dto.name.trim(),
        engine: DatabaseEngine.POSTGRESQL,
        status: DatabaseConnectionStatus.CONNECTED,
        host: dto.host.trim(),
        port: dto.port,
        databaseName: dto.databaseName.trim(),
        username: dto.username.trim(),
        passwordEncrypted: encryptCredential(dto.password),
        sslMode: (dto.sslMode ?? 'AUTO') as DatabaseSslMode,
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

    await this.bindDatabaseUrl(userId, projectId, connection.id, unitIds, {
      host: connection.host,
      port: connection.port,
      databaseName: connection.databaseName,
      username: connection.username,
      password: dto.password,
      sslMode: connection.sslMode as DatabaseSslModeInput,
    });

    return {
      connection: this.toPublic(connection),
      message: '数据库连接已保存，重新上线后生效。',
      test: {
        success: true,
        latencyMs: testResult.latencyMs,
        location: testResult.location,
      },
    };
  }

  async update(userId: string, projectId: string, id: string, dto: UpdateDatabaseConnectionDto) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    this.requireSecretWrite(membership.role);
    const existing = await this.requireConnection(projectId, id);

    const password =
      dto.password && dto.password.trim().length > 0
        ? dto.password
        : decryptCredential(existing.passwordEncrypted);
    const fields = {
      host: (dto.host ?? existing.host).trim(),
      port: dto.port ?? existing.port,
      databaseName: (dto.databaseName ?? existing.databaseName).trim(),
      username: (dto.username ?? existing.username).trim(),
      password,
      sslMode: (dto.sslMode ?? existing.sslMode) as DatabaseSslModeInput,
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
      await this.prisma.databaseConnection.update({
        where: { id },
        data: {
          status: DatabaseConnectionStatus.FAILED,
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

    await this.prisma.databaseConnectionUnit.deleteMany({
      where: { databaseConnectionId: id },
    });
    const updated = await this.prisma.databaseConnection.update({
      where: { id },
      data: {
        name: dto.name?.trim() || existing.name,
        host: fields.host,
        port: fields.port,
        databaseName: fields.databaseName,
        username: fields.username,
        passwordEncrypted: encryptCredential(password),
        sslMode: fields.sslMode as DatabaseSslMode,
        status: DatabaseConnectionStatus.CONNECTED,
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
    await this.bindDatabaseUrl(userId, projectId, id, unitIds, fields);

    return {
      connection: this.toPublic(updated),
      message: '数据库连接已更新，重新上线后生效。',
    };
  }

  async getDeleteImpact(userId: string, projectId: string, id: string) {
    await this.workspaceAccess.requireProjectAccess(userId, projectId);
    const connection = await this.requireConnection(projectId, id);
    return {
      id,
      message: '删除后，以下组成下一次上线将缺少数据库连接：',
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
          key: DATABASE_URL_KEY,
          provider: PROVIDER,
          providerRef: id,
        },
      });
      await this.prisma.runtimeConfigRequirement.updateMany({
        where: { deployableUnitId: unitId, key: DATABASE_URL_KEY },
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
          key: DATABASE_URL_KEY,
          action: SecretAuditAction.DELETED,
          actorUserId: userId,
          metadata: { fromProvider: PROVIDER },
        },
      });
    }

    await this.prisma.databaseConnection.delete({ where: { id } });
    return {
      deleted: true,
      message: '数据库连接已删除。当前应用仍在使用上次上线时的配置。',
    };
  }

  async validateForDeploy(projectId: string, unitId: string): Promise<void> {
    const binding = await this.prisma.databaseConnectionUnit.findFirst({
      where: { deployableUnitId: unitId, databaseConnection: { projectId } },
      include: { databaseConnection: true },
    });
    if (!binding) {
      return;
    }
    const connection = binding.databaseConnection;
    const password = decryptCredential(connection.passwordEncrypted);
    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { workspaceId: true },
    });

    const server = await this.findPreferredServer(project.workspaceId, projectId);
    const result = await this.runTest(project.workspaceId, {
      host: connection.host,
      port: connection.port,
      databaseName: connection.databaseName,
      username: connection.username,
      password,
      sslMode: connection.sslMode as DatabaseSslModeInput,
      testLocation: server ? 'TARGET_SERVER' : 'CONTROL_PLANE',
      serverInstanceId: server?.id,
      timeoutMs: 8_000,
    });

    await this.prisma.databaseConnection.update({
      where: { id: connection.id },
      data: {
        status: result.success
          ? DatabaseConnectionStatus.CONNECTED
          : DatabaseConnectionStatus.FAILED,
        lastTestedAt: new Date(),
        lastTestStatus: result.success ? DatabaseTestStatus.SUCCESS : DatabaseTestStatus.FAILED,
        lastTestErrorCode: result.success ? null : result.errorCode ?? 'UNKNOWN',
        lastTestLatencyMs: result.latencyMs,
        lastTestLocation: result.location,
      },
    });

    if (!result.success) {
      throw new BadRequestException({
        message: '数据库目前无法连接，请检查数据库设置。',
        code: 'DATABASE_UNREACHABLE',
        errorCode: result.errorCode,
        location: result.location,
      });
    }
  }

  private async runTest(
    workspaceId: string,
    input: PostgresTestInput & {
      testLocation?: 'CONTROL_PLANE' | 'TARGET_SERVER' | 'AUTO';
      serverInstanceId?: string;
      timeoutMs?: number;
    },
  ): Promise<PostgresTestResult> {
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
      const target = await testPostgresTargetServer(
        {
          host: input.host.trim(),
          port: input.port,
          databaseName: input.databaseName.trim(),
          username: input.username.trim(),
          password: input.password,
          sslMode: input.sslMode,
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
      // AUTO fallback to control plane when target fails for infrastructure reasons
    }

    return testPostgresControlPlane({
      host: input.host.trim(),
      port: input.port,
      databaseName: input.databaseName.trim(),
      username: input.username.trim(),
      password: input.password,
      sslMode: input.sslMode,
      timeoutMs: input.timeoutMs,
    });
  }

  async bindDatabaseUrl(
    userId: string,
    projectId: string,
    connectionId: string,
    unitIds: string[],
    fields: {
      host: string;
      port: number;
      databaseName: string;
      username: string;
      password: string;
      sslMode: DatabaseSslModeInput;
    },
  ): Promise<void> {
    const databaseUrl = buildPostgresDatabaseUrl(fields);
    const encrypted = encryptCredential(databaseUrl);
    const now = new Date();

    for (const unitId of unitIds) {
      const requirement = await this.prisma.runtimeConfigRequirement.findUnique({
        where: {
          deployableUnitId_key: { deployableUnitId: unitId, key: DATABASE_URL_KEY },
        },
      });
      await this.prisma.runtimeConfigValue.upsert({
        where: {
          scopeType_scopeId_key: {
            scopeType: RuntimeConfigScopeType.UNIT,
            scopeId: unitId,
            key: DATABASE_URL_KEY,
          },
        },
        create: {
          projectId,
          scopeType: RuntimeConfigScopeType.UNIT,
          scopeId: unitId,
          deployableUnitId: unitId,
          scope: 'UNIT',
          requirementId: requirement?.id ?? null,
          key: DATABASE_URL_KEY,
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
          key: DATABASE_URL_KEY,
          action: SecretAuditAction.UPDATED,
          actorUserId: userId,
          metadata: { provider: PROVIDER },
        },
      });
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
    const connection = await this.requireConnection(projectId, connectionId);
    await this.clearProviderBindings(connectionId);
    for (const unit of connection.units) {
      const requirement = await this.prisma.runtimeConfigRequirement.findUnique({
        where: {
          deployableUnitId_key: {
            deployableUnitId: unit.deployableUnitId,
            key: DATABASE_URL_KEY,
          },
        },
      });
      if (requirement) {
        await this.prisma.runtimeConfigRequirement.update({
          where: { id: requirement.id },
          data: { status: RuntimeConfigRequirementStatus.DETECTED },
        });
      }
      await this.prisma.deployableUnit.update({
        where: { id: unit.deployableUnitId },
        data: { configRevision: { increment: 1 } },
      });
      await this.prisma.secretAuditEvent.create({
        data: {
          projectId,
          deployableUnitId: unit.deployableUnitId,
          scopeType: RuntimeConfigScopeType.UNIT,
          scopeId: unit.deployableUnitId,
          key: DATABASE_URL_KEY,
          action: SecretAuditAction.DELETED,
          actorUserId: userId,
          metadata: { provider: PROVIDER, action: 'unlink-managed' },
        },
      });
    }
    await this.prisma.databaseConnectionUnit.deleteMany({
      where: { databaseConnectionId: connectionId },
    });
  }

  async markUnavailable(userId: string, projectId: string, connectionId: string): Promise<void> {
    await this.requireConnection(projectId, connectionId);
    await this.markUnavailableAndUnbind(connectionId);
    await this.prisma.secretAuditEvent.create({
      data: {
        projectId,
        scopeType: RuntimeConfigScopeType.PROJECT,
        scopeId: projectId,
        key: DATABASE_URL_KEY,
        action: SecretAuditAction.DELETED,
        actorUserId: userId,
        metadata: { provider: PROVIDER, action: 'cloud-delete' },
      },
    });
  }

  /**
   * Create a managed DatabaseConnection row from a successful provision job.
   * Called from the worker — no userId available, uses a system actor string.
   */
  async createManagedFromProvision(params: {
    projectId: string;
    workspaceId: string;
    cloudResourceId: string;
    host: string;
    port: number;
    databaseName: string;
    username: string;
    password: string;
    sslMode: DatabaseSslMode;
    unitIds: string[];
    testPassed: boolean;
  }): Promise<string> {
    const { projectId, workspaceId, cloudResourceId, unitIds, password, testPassed } = params;
    const systemActor = 'system:db-provision';

    const connection = await this.prisma.databaseConnection.create({
      data: {
        workspaceId,
        projectId,
        name: `LaunchOS RDS (${params.databaseName})`,
        engine: DatabaseEngine.POSTGRESQL,
        status: testPassed
          ? DatabaseConnectionStatus.CONNECTED
          : DatabaseConnectionStatus.UNTESTED,
        host: params.host,
        port: params.port,
        databaseName: params.databaseName,
        username: params.username,
        passwordEncrypted: encryptCredential(password),
        sslMode: params.sslMode,
        source: 'ALIYUN_RDS',
        cloudResourceId,
        createdBy: systemActor,
        updatedBy: systemActor,
        lastTestedAt: testPassed ? new Date() : null,
        lastTestStatus: testPassed ? DatabaseTestStatus.SUCCESS : null,
        units: {
          create: unitIds.map((deployableUnitId) => ({ deployableUnitId })),
        },
      },
    });

    if (testPassed && unitIds.length > 0) {
      await this.bindDatabaseUrl(systemActor, projectId, connection.id, unitIds, {
        host: params.host,
        port: params.port,
        databaseName: params.databaseName,
        username: params.username,
        password,
        sslMode: params.sslMode as DatabaseSslModeInput,
      });
    }

    return connection.id;
  }

  /**
   * Mark a managed connection as UNAVAILABLE and remove all DATABASE_URL bindings.
   * Used when the corresponding RDS instance is being deleted.
   */
  async markUnavailableAndUnbind(connectionId: string): Promise<void> {
    const connection = await this.prisma.databaseConnection.findUnique({
      where: { id: connectionId },
      include: {
        units: { select: { deployableUnitId: true } },
      },
    });
    if (!connection) return;

    await this.prisma.databaseConnection.update({
      where: { id: connectionId },
      data: { status: DatabaseConnectionStatus.UNAVAILABLE },
    });

    await this.clearProviderBindings(connectionId);

    for (const unit of connection.units) {
      await this.prisma.deployableUnit.update({
        where: { id: unit.deployableUnitId },
        data: { configRevision: { increment: 1 } },
      });
    }
  }

  async clearProviderBindings(connectionId: string): Promise<void> {
    await this.prisma.runtimeConfigValue.deleteMany({
      where: { provider: PROVIDER, providerRef: connectionId },
    });
  }

  private async assertEligibleUnits(projectId: string, unitIds: string[]): Promise<void> {
    if (unitIds.length === 0) {
      throw new BadRequestException('请选择需要绑定数据库的组成');
    }
    const eligible = await this.listEligibleUnits(projectId);
    const eligibleIds = new Set(eligible.map((item) => item.id));
    for (const unitId of unitIds) {
      if (!eligibleIds.has(unitId)) {
        throw new BadRequestException('只能绑定到需要 DATABASE_URL 的组成');
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
        key: DATABASE_URL_KEY,
        scopeType: RuntimeConfigScopeType.UNIT,
        scopeId: { in: unitIds },
        OR: [{ provider: null }, { provider: { not: PROVIDER } }],
      },
      select: { scopeId: true, source: true, provider: true },
    });
    if (manuals.length > 0 && !confirmed) {
      throw new BadRequestException({
        message: '当前数据库连接为手动配置，绑定新的数据库将替换当前 DATABASE_URL。',
        code: 'MANUAL_DATABASE_URL_EXISTS',
        requiresConfirm: true,
      });
    }
  }

  private async listEligibleUnits(projectId: string) {
    const requirements = await this.prisma.runtimeConfigRequirement.findMany({
      where: {
        projectId,
        key: DATABASE_URL_KEY,
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
    const connection = await this.prisma.databaseConnection.findFirst({
      where: { id, projectId },
      include: {
        units: {
          include: { deployableUnit: { select: { id: true, name: true, type: true } } },
        },
      },
    });
    if (!connection) {
      throw new NotFoundException('未找到数据库连接');
    }
    return connection;
  }

  private toPublic(
    connection: {
      id: string;
      name: string;
      engine: DatabaseEngine;
      status: DatabaseConnectionStatus;
      host: string;
      port: number;
      databaseName: string;
      username: string;
      sslMode: DatabaseSslMode;
      lastTestedAt: Date | null;
      lastTestStatus: DatabaseTestStatus | null;
      lastTestErrorCode: string | null;
      lastTestLatencyMs: number | null;
      lastTestLocation: string | null;
      createdAt: Date;
      updatedAt: Date;
      units: Array<{
        deployableUnit: { id: string; name: string; type?: string };
      }>;
    },
  ) {
    return {
      id: connection.id,
      name: connection.name,
      engine: connection.engine,
      status: connection.status,
      host: connection.host,
      port: connection.port,
      databaseName: connection.databaseName,
      username: connection.username,
      passwordConfigured: true,
      sslMode: connection.sslMode,
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
      throw new ForbiddenException('仅管理员可以管理数据库连接');
    }
  }
}
