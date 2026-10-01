import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CloudResourceStatus,
  CloudResourceType,
  RuntimeConfigRequirementStatus,
  RuntimeConfigScopeType,
  SecretAuditAction,
  WorkspaceRole,
} from '@launchos/database';import {
  DEPENDENCY_STATUS_LABELS,
  DEPENDENCY_TYPE_LABELS,
  PRODUCT_DEPENDENCY_PHASE_LABELS,
  PROJECT_DEPENDENCY_STATUS_LABELS,
  aggregateProjectDependencyStatus,
  buildDeployValidationResult,
  dependencyErrorUserMessage,
  detectDependenciesFromRequirementKeys,
  isSupportedDependencyType,
  mapProvisionPhaseToProductPhase,
  requirementKeysForDependencyType,
  resolveDependencyStatus,
  type DependencyDeployBlocker,
  type DependencyHealthStatus,
  type DependencyStatus,
  type DependencyType,
  type ProductDependencyPhase,
} from '@launchos/shared';
import { PrismaService } from '../database/prisma.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import { DatabaseConnectionsService } from '../database-connections/database-connections.service';
import { RedisConnectionsService } from '../redis-connections/redis-connections.service';
import { DatabaseProvisionService } from '../database-provision/database-provision.service';
import { RedisProvisionService } from '../redis-provision/redis-provision.service';

const SECRET_WRITE_ROLES: WorkspaceRole[] = [WorkspaceRole.OWNER, WorkspaceRole.ADMIN];

type PublicDependency = {
  type: DependencyType;
  label: string;
  required: boolean;
  supported: boolean;
  status: DependencyStatus;
  statusLabel: string;
  sourceRequirementKeys: string[];
  provider: string | null;
  providerLabel: string | null;
  connectionId: string | null;
  cloudResourceId: string | null;
  needsRedeploy: boolean;
  productPhase: ProductDependencyPhase | null;
  productPhaseLabel: string | null;
  lastCheckedAt: string | null;
  healthStatus: DependencyHealthStatus | null;
  managePath: string | null;
};

@Injectable()
export class DependenciesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaceAccess: WorkspaceAccessService,
    private readonly databaseConnections: DatabaseConnectionsService,
    private readonly redisConnections: RedisConnectionsService,
    private readonly databaseProvision: DatabaseProvisionService,
    private readonly redisProvision: RedisProvisionService,
  ) {}

  async getProjectSummary(userId: string, projectId: string) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    const units = await this.prisma.deployableUnit.findMany({
      where: { projectId },
      select: { id: true, name: true, type: true },
      orderBy: { createdAt: 'asc' },
    });

    const unitPayloads = [];
    const flatForAggregate: Array<{ required: boolean; status: DependencyStatus }> = [];

    for (const unit of units) {
      const dependencies = await this.resolveUnitDependencies(projectId, unit.id);
      unitPayloads.push({
        unitId: unit.id,
        unitName: unit.name,
        unitType: unit.type,
        dependencies: dependencies.map((d) => this.toPublicDependency(d, projectId)),
      });
      for (const d of dependencies) {
        flatForAggregate.push({ required: d.required, status: d.status });
      }
    }

    const aggregate = aggregateProjectDependencyStatus(flatForAggregate);
    return {
      project: {
        required: aggregate.required,
        connected: aggregate.connected,
        missing: aggregate.missing,
        configuring: aggregate.configuring,
        degraded: aggregate.degraded,
        status: aggregate.status,
        statusLabel: PROJECT_DEPENDENCY_STATUS_LABELS[aggregate.status],
      },
      units: unitPayloads,
      canEdit: SECRET_WRITE_ROLES.includes(membership.role),
      canWrite:
        membership.role === WorkspaceRole.OWNER ||
        membership.role === WorkspaceRole.ADMIN ||
        membership.role === WorkspaceRole.MEMBER,
    };
  }

  async getUnitDependencies(userId: string, projectId: string, unitId: string) {
    await this.workspaceAccess.requireProjectAccess(userId, projectId);
    const unit = await this.requireUnit(projectId, unitId);
    const dependencies = await this.resolveUnitDependencies(projectId, unitId);
    return {
      unitId: unit.id,
      unitName: unit.name,
      unitType: unit.type,
      dependencies: dependencies.map((d) => this.toPublicDependency(d, projectId)),
    };
  }

  /**
   * Unified deploy gate — wraps missing requirements + connection reachability.
   */
  async validateBeforeDeploy(
    projectId: string,
    unitId: string,
  ): Promise<ReturnType<typeof buildDeployValidationResult>> {
    const blockers: DependencyDeployBlocker[] = [];
    const dependencies = await this.resolveUnitDependencies(projectId, unitId);

    for (const dep of dependencies) {
      if (!dep.required || !dep.supported) continue;
      if (dep.status === 'MISSING' || dep.status === 'ERROR') {
        blockers.push({
          dependencyType: dep.type,
          code: 'DEPENDENCY_MISSING',
          userMessage:
            dep.type === 'POSTGRESQL'
              ? '数据库尚未连接'
              : dep.type === 'REDIS'
                ? 'Redis 尚未连接'
                : dependencyErrorUserMessage('DEPENDENCY_MISSING'),
        });
      } else if (dep.status === 'CONFIGURING') {
        blockers.push({
          dependencyType: dep.type,
          code: 'DEPENDENCY_PROVIDER_ERROR',
          userMessage: `${DEPENDENCY_TYPE_LABELS[dep.type]}仍在配置中，请完成后再上线。`,
        });
      } else if (dep.status === 'UNAVAILABLE') {
        blockers.push({
          dependencyType: dep.type,
          code: 'DEPENDENCY_LOCKED',
          userMessage: dependencyErrorUserMessage('DEPENDENCY_LOCKED'),
        });
      }
    }

    if (blockers.length === 0) {
      try {
        await this.databaseConnections.validateForDeploy(projectId, unitId);
      } catch (error) {
        blockers.push(this.mapThrowToBlocker(error, 'POSTGRESQL'));
      }
      try {
        await this.redisConnections.validateForDeploy(projectId, unitId);
      } catch (error) {
        blockers.push(this.mapThrowToBlocker(error, 'REDIS'));
      }
    }

    return buildDeployValidationResult(blockers);
  }

  async checkHealth(
    userId: string,
    projectId: string,
    unitId: string,
    type: DependencyType,
  ) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    this.requireMemberWrite(membership.role);
    await this.requireUnit(projectId, unitId);
    if (!isSupportedDependencyType(type)) {
      throw new BadRequestException('该依赖类型暂不支持健康检查');
    }

    const resolved = (await this.resolveUnitDependencies(projectId, unitId)).find(
      (d) => d.type === type,
    );
    if (!resolved?.required) {
      return {
        type,
        healthStatus: 'UNKNOWN' as DependencyHealthStatus,
        latencyMs: null,
        checkedAt: new Date().toISOString(),
        message: '当前组成不需要此依赖',
      };
    }
    if (!resolved.connectionId) {
      return {
        type,
        healthStatus: 'UNHEALTHY' as DependencyHealthStatus,
        latencyMs: null,
        checkedAt: new Date().toISOString(),
        message: dependencyErrorUserMessage('DEPENDENCY_MISSING'),
      };
    }

    try {
      if (type === 'POSTGRESQL') {
        await this.databaseConnections.validateForDeploy(projectId, unitId);
      } else if (type === 'REDIS') {
        await this.redisConnections.validateForDeploy(projectId, unitId);
      }
      return {
        type,
        healthStatus: 'HEALTHY' as DependencyHealthStatus,
        latencyMs: null,
        checkedAt: new Date().toISOString(),
        message: '连接正常',
      };
    } catch (error) {
      const blocker = this.mapThrowToBlocker(error, type);
      return {
        type,
        healthStatus: 'UNHEALTHY' as DependencyHealthStatus,
        latencyMs: null,
        checkedAt: new Date().toISOString(),
        message: blocker.userMessage,
        code: blocker.code,
      };
    }
  }

  async provision(
    userId: string,
    projectId: string,
    unitId: string,
    type: DependencyType,
    body: {
      mode: 'EXISTING' | 'MANAGED_CREATE';
      provider?: string;
      connectionId?: string;
      tier?: 'DEV' | 'SMALL' | 'STANDARD';
      confirmBilling?: boolean;
      confirmedReplaceManual?: boolean;
    },
  ) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    this.requireSecretWrite(membership.role);
    await this.requireUnit(projectId, unitId);
    if (!isSupportedDependencyType(type)) {
      throw new BadRequestException('该依赖类型暂不支持自动创建');
    }

    if (body.mode === 'EXISTING') {
      return this.connectExisting(userId, projectId, unitId, type, {
        connectionId: body.connectionId,
        confirmedReplaceManual: body.confirmedReplaceManual,
      });
    }

    if (type === 'POSTGRESQL') {
      return this.databaseProvision.create(userId, projectId, {
        tier: body.tier || 'DEV',
        unitIds: [unitId],
        confirmBilling: Boolean(body.confirmBilling),
        confirmReplaceManual: body.confirmedReplaceManual,
      });
    }
    if (type === 'REDIS') {
      return this.redisProvision.create(userId, projectId, {
        tier: body.tier || 'DEV',
        unitIds: [unitId],
        confirmBilling: Boolean(body.confirmBilling),
        confirmReplaceManual: body.confirmedReplaceManual,
      });
    }
    throw new BadRequestException('不支持的依赖类型');
  }

  async connectExisting(
    userId: string,
    projectId: string,
    unitId: string,
    type: DependencyType,
    body: { connectionId?: string; confirmedReplaceManual?: boolean },
  ) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    this.requireSecretWrite(membership.role);
    await this.requireUnit(projectId, unitId);
    if (!body.connectionId) {
      throw new BadRequestException('请选择要连接的服务');
    }

    if (type === 'POSTGRESQL') {
      const existing = await this.prisma.databaseConnection.findFirst({
        where: { id: body.connectionId, projectId },
        include: { units: { select: { deployableUnitId: true } } },
      });
      if (!existing) throw new NotFoundException('数据库连接不存在');
      await this.detachUnitFromOtherConnections(projectId, unitId, type, body.connectionId);
      const unitIds = [
        ...new Set([...existing.units.map((u) => u.deployableUnitId), unitId]),
      ];
      const result = await this.databaseConnections.update(userId, projectId, body.connectionId, {
        unitIds,
        confirmReplaceManual: body.confirmedReplaceManual,
      });
      await this.recordDependencyAudit(userId, projectId, unitId, {
        action: 'DEPENDENCY_CONNECTED',
        dependencyType: type,
        connectionId: body.connectionId,
        provider: existing.source === 'ALIYUN_RDS' ? 'ALIYUN' : 'MANUAL',
        status: 'CONNECTED',
      });
      return result;
    }
    if (type === 'REDIS') {
      const existing = await this.prisma.redisConnection.findFirst({
        where: { id: body.connectionId, projectId },
        include: { units: { select: { deployableUnitId: true } } },
      });
      if (!existing) throw new NotFoundException('Redis 连接不存在');
      await this.detachUnitFromOtherConnections(projectId, unitId, type, body.connectionId);
      const unitIds = [
        ...new Set([...existing.units.map((u) => u.deployableUnitId), unitId]),
      ];
      const result = await this.redisConnections.update(userId, projectId, body.connectionId, {
        unitIds,
        confirmReplaceManual: body.confirmedReplaceManual,
      });
      await this.recordDependencyAudit(userId, projectId, unitId, {
        action: 'DEPENDENCY_CONNECTED',
        dependencyType: type,
        connectionId: body.connectionId,
        provider: existing.source === 'ALIYUN_REDIS' ? 'ALIYUN' : 'MANUAL',
        status: 'CONNECTED',
      });
      return result;
    }
    throw new BadRequestException('该依赖类型暂不支持连接已有服务');
  }

  async unlink(
    userId: string,
    projectId: string,
    unitId: string,
    type: DependencyType,
  ) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    this.requireSecretWrite(membership.role);
    await this.requireUnit(projectId, unitId);
    if (type !== 'POSTGRESQL' && type !== 'REDIS') {
      throw new BadRequestException('不支持的依赖类型');
    }

    const binding = await this.findBinding(projectId, unitId, type);
    // Also clear stale ConnectionUnit joins even if RuntimeConfigValue already gone
    const hadStaleJoin = await this.hasConnectionUnitJoin(projectId, unitId, type);
    if (!binding && !hadStaleJoin) {
      throw new BadRequestException('当前没有可解除的连接');
    }

    await this.unlinkUnitBinding(userId, projectId, unitId, type, binding?.connectionId);
    await this.recordDependencyAudit(userId, projectId, unitId, {
      action: 'DEPENDENCY_DISCONNECTED',
      dependencyType: type,
      connectionId: binding?.connectionId || null,
      provider: binding?.provider || null,
      status: 'MISSING',
    });

    return {
      ok: true,
      message: '已解除连接。不会删除阿里云中的服务。',
      dependencyType: type,
    };
  }

  async destroyCloudResource(
    userId: string,
    projectId: string,
    unitId: string,
    type: DependencyType,
  ) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    this.requireSecretWrite(membership.role);
    await this.requireUnit(projectId, unitId);
    const resolved = (await this.resolveUnitDependencies(projectId, unitId)).find(
      (d) => d.type === type,
    );
    let cloudResourceId = resolved?.cloudResourceId || null;
    if (!cloudResourceId) {
      const resourceType =
        type === 'POSTGRESQL'
          ? CloudResourceType.DATABASE
          : type === 'REDIS'
            ? CloudResourceType.CACHE
            : null;
      if (resourceType) {
        const cr = await this.prisma.cloudResource.findFirst({
          where: {
            projectId,
            type: resourceType,
            status: { notIn: [CloudResourceStatus.DELETED] },
          },
          orderBy: { updatedAt: 'desc' },
          select: { id: true },
        });
        cloudResourceId = cr?.id || null;
      }
    }
    if (!cloudResourceId) {
      throw new BadRequestException({
        message: '当前依赖没有可删除的云资源（可能是外部已有服务）。',
        code: 'NO_CLOUD_RESOURCE',
      });
    }
    if (type === 'POSTGRESQL') {
      const result = await this.databaseProvision.destroy(userId, projectId, cloudResourceId, {
        confirmDestroy: true,
      });
      await this.recordDependencyAudit(userId, projectId, unitId, {
        action: 'DEPENDENCY_DELETED',
        dependencyType: type,
        cloudResourceId,
        connectionId: resolved?.connectionId || null,
        provider: 'ALIYUN',
        status: 'UNAVAILABLE',
      });
      return result;
    }
    if (type === 'REDIS') {
      const result = await this.redisProvision.destroy(userId, projectId, cloudResourceId, {
        confirmDestroy: true,
      });
      await this.recordDependencyAudit(userId, projectId, unitId, {
        action: 'DEPENDENCY_DELETED',
        dependencyType: type,
        cloudResourceId,
        connectionId: resolved?.connectionId || null,
        provider: 'ALIYUN',
        status: 'UNAVAILABLE',
      });
      return result;
    }
    throw new BadRequestException('不支持的依赖类型');
  }

  async getProvisionOptions(userId: string, projectId: string, type: DependencyType) {
    await this.workspaceAccess.requireProjectAccess(userId, projectId);
    if (type === 'POSTGRESQL') {
      return this.databaseProvision.getOptions(userId, projectId);
    }
    if (type === 'REDIS') {
      return this.redisProvision.getOptions(userId, projectId);
    }
    throw new BadRequestException('该依赖类型暂不支持开通选项');
  }

  // --- internals ---

  private async resolveUnitDependencies(projectId: string, unitId: string) {
    const requirements = await this.prisma.runtimeConfigRequirement.findMany({
      where: {
        deployableUnitId: unitId,
        status: { not: RuntimeConfigRequirementStatus.IGNORED },
      },
      select: { key: true, required: true, status: true },
    });
    const requiredKeys = requirements
      .filter((r) => r.required !== false)
      .map((r) => r.key);

    const detected = detectDependenciesFromRequirementKeys(requiredKeys);

    const unitMeta = await this.prisma.deployableUnit.findUnique({
      where: { id: unitId },
      select: { configRevision: true },
    });
    const activeService = await this.prisma.serviceInstance.findFirst({
      where: { deployableUnitId: unitId, status: 'RUNNING' },
      orderBy: { updatedAt: 'desc' },
      select: { configRevision: true },
    });
    const currentRevision = unitMeta?.configRevision ?? 0;
    const appliedRevision = activeService?.configRevision ?? null;
    const unitNeedsRedeploy =
      appliedRevision != null && currentRevision > appliedRevision;

    const results = [];
    for (const type of ['POSTGRESQL', 'REDIS'] as DependencyType[]) {
      const detectedEntry = detected.find((d) => d.type === type);
      const required = Boolean(detectedEntry);
      const keys = requirementKeysForDependencyType(type);
      const binding = await this.findBinding(projectId, unitId, type);
      const cloud = await this.findActiveCloudResource(projectId, type, binding?.connectionId);
      const needsRedeploy = Boolean(binding && unitNeedsRedeploy);

      const status = resolveDependencyStatus({
        required,
        hasBinding: Boolean(binding),
        connectionStatus: binding?.connectionStatus,
        cloudResourceStatus: cloud?.status,
        cloudResourcePhase: cloud?.phase,
        needsRedeploy,
        lastTestStatus: binding?.lastTestStatus,
      });

      results.push({
        type,
        required,
        supported: isSupportedDependencyType(type),
        status,
        sourceRequirementKeys: detectedEntry?.sourceRequirementKeys || keys,
        provider: binding?.provider || cloud?.provider || null,
        connectionId: binding?.connectionId || null,
        cloudResourceId: cloud?.id || null,
        needsRedeploy,
        productPhase: mapProvisionPhaseToProductPhase(cloud?.phase),
        lastCheckedAt: binding?.lastTestedAt || null,
        healthStatus: null as DependencyHealthStatus | null,
        connectionStatus: binding?.connectionStatus || null,
      });
    }

    // Include unsupported future placeholders only if requirement keys matched
    for (const entry of detected) {
      if (entry.type === 'POSTGRESQL' || entry.type === 'REDIS') continue;
      results.push({
        type: entry.type,
        required: true,
        supported: false,
        status: 'MISSING' as DependencyStatus,
        sourceRequirementKeys: entry.sourceRequirementKeys,
        provider: null,
        connectionId: null,
        cloudResourceId: null,
        needsRedeploy: false,
        productPhase: null,
        lastCheckedAt: null,
        healthStatus: null,
        connectionStatus: null,
      });
    }

    return results;
  }

  private async findBinding(
    projectId: string,
    unitId: string,
    type: DependencyType,
  ): Promise<{
    connectionId: string;
    connectionStatus: string;
    lastTestStatus: string | null;
    lastTestedAt: string | null;
    provider: string;
  } | null> {
    const keys = requirementKeysForDependencyType(type);
    const provider =
      type === 'POSTGRESQL' ? 'DATABASE_CONNECTION' : type === 'REDIS' ? 'REDIS_CONNECTION' : null;
    if (!provider) return null;

    // RuntimeConfigValue is the single source of truth for "bound to unit".
    // Stale ConnectionUnit joins without a config value must not count as CONNECTED.
    const value = await this.prisma.runtimeConfigValue.findFirst({
      where: {
        projectId,
        deployableUnitId: unitId,
        key: { in: keys },
        provider,
        providerRef: { not: null },
      },
    });
    if (!value?.providerRef) return null;

    if (type === 'POSTGRESQL') {
      const conn = await this.prisma.databaseConnection.findFirst({
        where: { id: value.providerRef, projectId },
      });
      if (!conn) return null;
      return {
        connectionId: conn.id,
        connectionStatus: conn.status,
        lastTestStatus: conn.lastTestStatus,
        lastTestedAt: conn.lastTestedAt?.toISOString() || null,
        provider: conn.source === 'ALIYUN_RDS' ? 'ALIYUN' : 'MANUAL',
      };
    }
    if (type === 'REDIS') {
      const conn = await this.prisma.redisConnection.findFirst({
        where: { id: value.providerRef, projectId },
      });
      if (!conn) return null;
      return {
        connectionId: conn.id,
        connectionStatus: conn.status,
        lastTestStatus: conn.lastTestStatus,
        lastTestedAt: conn.lastTestedAt?.toISOString() || null,
        provider: conn.source === 'ALIYUN_REDIS' ? 'ALIYUN' : 'MANUAL',
      };
    }
    return null;
  }

  private async hasConnectionUnitJoin(
    projectId: string,
    unitId: string,
    type: DependencyType,
  ): Promise<boolean> {
    if (type === 'POSTGRESQL') {
      const link = await this.prisma.databaseConnectionUnit.findFirst({
        where: { deployableUnitId: unitId, databaseConnection: { projectId } },
        select: { id: true },
      });
      return Boolean(link);
    }
    if (type === 'REDIS') {
      const link = await this.prisma.redisConnectionUnit.findFirst({
        where: { deployableUnitId: unitId, redisConnection: { projectId } },
        select: { id: true },
      });
      return Boolean(link);
    }
    return false;
  }

  /**
   * Unit-scoped unlink: remove this unit's RuntimeConfig binding + ConnectionUnit joins.
   * Does not delete the Connection row or provider cloud resource.
   */
  private async unlinkUnitBinding(
    userId: string,
    projectId: string,
    unitId: string,
    type: DependencyType,
    connectionId?: string | null,
  ): Promise<void> {
    const keys = requirementKeysForDependencyType(type);
    const provider =
      type === 'POSTGRESQL' ? 'DATABASE_CONNECTION' : type === 'REDIS' ? 'REDIS_CONNECTION' : null;
    if (!provider || keys.length === 0) return;

    await this.prisma.runtimeConfigValue.deleteMany({
      where: {
        projectId,
        deployableUnitId: unitId,
        key: { in: keys },
        provider,
      },
    });

    if (type === 'POSTGRESQL') {
      await this.prisma.databaseConnectionUnit.deleteMany({
        where: { deployableUnitId: unitId, databaseConnection: { projectId } },
      });
    } else if (type === 'REDIS') {
      await this.prisma.redisConnectionUnit.deleteMany({
        where: { deployableUnitId: unitId, redisConnection: { projectId } },
      });
    }

    await this.prisma.runtimeConfigRequirement.updateMany({
      where: { deployableUnitId: unitId, key: { in: keys } },
      data: { status: RuntimeConfigRequirementStatus.DETECTED },
    });

    await this.prisma.deployableUnit.update({
      where: { id: unitId },
      data: { configRevision: { increment: 1 } },
    });

    for (const key of keys) {
      await this.prisma.secretAuditEvent.create({
        data: {
          projectId,
          deployableUnitId: unitId,
          scopeType: RuntimeConfigScopeType.UNIT,
          scopeId: unitId,
          key,
          action: SecretAuditAction.DELETED,
          actorUserId: userId,
          metadata: {
            provider,
            action: 'dependency-unlink',
            connectionId: connectionId || null,
            dependencyType: type,
          },
        },
      });
    }
  }

  private async detachUnitFromOtherConnections(
    projectId: string,
    unitId: string,
    type: DependencyType,
    keepConnectionId: string,
  ): Promise<void> {
    if (type === 'POSTGRESQL') {
      await this.prisma.databaseConnectionUnit.deleteMany({
        where: {
          deployableUnitId: unitId,
          databaseConnection: { projectId },
          databaseConnectionId: { not: keepConnectionId },
        },
      });
      return;
    }
    if (type === 'REDIS') {
      await this.prisma.redisConnectionUnit.deleteMany({
        where: {
          deployableUnitId: unitId,
          redisConnection: { projectId },
          redisConnectionId: { not: keepConnectionId },
        },
      });
    }
  }

  private async recordDependencyAudit(
    userId: string,
    projectId: string,
    unitId: string,
    payload: {
      action: string;
      dependencyType: DependencyType;
      connectionId?: string | null;
      cloudResourceId?: string | null;
      provider?: string | null;
      status?: string | null;
    },
  ): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { workspaceId: true },
    });
    if (!project) return;
    await this.prisma.auditLog.create({
      data: {
        workspaceId: project.workspaceId,
        userId,
        action: payload.action,
        metadata: {
          projectId,
          unitId,
          dependencyType: payload.dependencyType,
          connectionId: payload.connectionId || null,
          cloudResourceId: payload.cloudResourceId || null,
          provider: payload.provider || null,
          status: payload.status || null,
        },
      },
    });
  }

  private async findActiveCloudResource(
    projectId: string,
    type: DependencyType,
    connectionId?: string | null,
  ): Promise<{ id: string; status: string; phase: string | null; provider: string } | null> {
    const resourceType =
      type === 'POSTGRESQL'
        ? CloudResourceType.DATABASE
        : type === 'REDIS'
          ? CloudResourceType.CACHE
          : null;
    if (!resourceType) return null;

    const rows = await this.prisma.cloudResource.findMany({
      where: {
        projectId,
        type: resourceType,
        status: {
          notIn: [CloudResourceStatus.DELETED],
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: 10,
    });

    for (const row of rows) {
      const meta =
        row.metadata && typeof row.metadata === 'object'
          ? (row.metadata as Record<string, unknown>)
          : {};
      if (connectionId && meta.redisConnectionId === connectionId) {
        return {
          id: row.id,
          status: row.status,
          phase: typeof meta.phase === 'string' ? meta.phase : null,
          provider: 'ALIYUN',
        };
      }
      if (connectionId && meta.databaseConnectionId === connectionId) {
        return {
          id: row.id,
          status: row.status,
          phase: typeof meta.phase === 'string' ? meta.phase : null,
          provider: 'ALIYUN',
        };
      }
    }

    // CONFIGURING UX: surface in-progress cloud resources even before Connection exists
    const creating = rows.find((r) => r.status === CloudResourceStatus.CREATING);
    if (creating) {
      const meta =
        creating.metadata && typeof creating.metadata === 'object'
          ? (creating.metadata as Record<string, unknown>)
          : {};
      return {
        id: creating.id,
        status: creating.status,
        phase: typeof meta.phase === 'string' ? meta.phase : null,
        provider: 'ALIYUN',
      };
    }

    // Bound unit: allow matching RUNNING CR by connection metadata only (already handled).
    // Unbound + RUNNING CR must not look like a unit binding.
    return null;
  }

  private toPublicDependency(
    dep: {
      type: DependencyType;
      required: boolean;
      supported: boolean;
      status: DependencyStatus;
      sourceRequirementKeys: string[];
      provider: string | null;
      connectionId: string | null;
      cloudResourceId: string | null;
      needsRedeploy: boolean;
      productPhase: ProductDependencyPhase | null;
      lastCheckedAt: string | null;
      healthStatus: DependencyHealthStatus | null;
    },
    projectId: string,
  ): PublicDependency {
    const providerLabel =
      dep.provider === 'ALIYUN'
        ? '阿里云'
        : dep.provider === 'MANUAL'
          ? '已有服务'
          : dep.provider;
    return {
      type: dep.type,
      label: DEPENDENCY_TYPE_LABELS[dep.type],
      required: dep.required,
      supported: dep.supported,
      status: dep.status,
      statusLabel: DEPENDENCY_STATUS_LABELS[dep.status],
      sourceRequirementKeys: dep.sourceRequirementKeys,
      provider: dep.provider,
      providerLabel,
      connectionId: dep.connectionId,
      cloudResourceId: dep.cloudResourceId,
      needsRedeploy: dep.needsRedeploy,
      productPhase: dep.productPhase,
      productPhaseLabel: dep.productPhase
        ? PRODUCT_DEPENDENCY_PHASE_LABELS[dep.productPhase]
        : null,
      lastCheckedAt: dep.lastCheckedAt,
      healthStatus: dep.healthStatus,
      managePath:
        dep.type === 'POSTGRESQL'
          ? `/projects/${projectId}/database`
          : dep.type === 'REDIS'
            ? `/projects/${projectId}/redis`
            : null,
    };
  }

  private mapThrowToBlocker(error: unknown, type: DependencyType): DependencyDeployBlocker {
    const err = error as { response?: { code?: string; message?: string }; message?: string };
    const code = err.response?.code || '';
    const message =
      (typeof err.response?.message === 'string' && err.response.message) ||
      (typeof err.message === 'string' ? err.message : '依赖检查未通过');
    if (code === 'DATABASE_UNREACHABLE' || code === 'REDIS_UNREACHABLE') {
      return {
        dependencyType: type,
        code: 'DEPENDENCY_UNREACHABLE',
        userMessage: dependencyErrorUserMessage('DEPENDENCY_UNREACHABLE'),
      };
    }
    if (/auth|password|认证/i.test(message)) {
      return {
        dependencyType: type,
        code: 'DEPENDENCY_AUTH_FAILED',
        userMessage: dependencyErrorUserMessage('DEPENDENCY_AUTH_FAILED'),
      };
    }
    return {
      dependencyType: type,
      code: 'DEPENDENCY_UNREACHABLE',
      userMessage: message.slice(0, 200),
    };
  }

  private async requireUnit(projectId: string, unitId: string) {
    const unit = await this.prisma.deployableUnit.findFirst({
      where: { id: unitId, projectId },
      select: { id: true, name: true, type: true },
    });
    if (!unit) throw new NotFoundException('组成不存在');
    return unit;
  }

  private requireSecretWrite(role: WorkspaceRole) {
    if (!SECRET_WRITE_ROLES.includes(role)) {
      throw new ForbiddenException('仅管理员可以管理应用依赖');
    }
  }

  private requireMemberWrite(role: WorkspaceRole) {
    if (
      role !== WorkspaceRole.OWNER &&
      role !== WorkspaceRole.ADMIN &&
      role !== WorkspaceRole.MEMBER
    ) {
      throw new ForbiddenException('无权限执行此操作');
    }
  }
}
