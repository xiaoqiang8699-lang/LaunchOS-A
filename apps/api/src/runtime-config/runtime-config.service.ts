import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  RuntimeConfigConfidence,
  RuntimeConfigInjectionPhase,
  RuntimeConfigRequirementStatus,
  RuntimeConfigScopeType,
  RuntimeConfigSource,
  SecretAuditAction,
  ServiceStatus,
  WorkspaceRole,
} from '@launchos/database';
import {
  resolveUnitPath,
  scanUnitRuntimeConfig,
  type DetectedRuntimeConfig,
} from '@launchos/analyzer';
import {
  collectUnitsAffectedByProjectKeyChange,
  isManagedConfigKey,
  resolveEffectiveEntry,
  resolvedSourceLabel,
  type ConfigRequirementLike,
  type ConfigValueLike,
  type ResolvedConfigSource,
  RuntimeConfigResolver,
} from '@launchos/deployment';
import {
  ROTATION_INTERVAL_OPTIONS,
  decryptCredential,
  encryptCredential,
  generateSecureRuntimeSecret,
  isGeneratableRuntimeSecret,
  runtimeConfigValueType,
  valueOriginLabel,
} from '@launchos/shared';
import { GitService } from '@launchos/git';
import { PrismaService } from '../database/prisma.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import {
  buildSecretMetadata,
  computeUnitApplyStatus,
  computeUnitPendingApply,
  resolveEffectiveValueMeta,
  sanitizeAuditMetadata,
  summarizeSecurityCounts,
  unitApplyStatusLabel,
  type ConfigValueMeta,
  type SecretAuditMetadata,
} from './secret-lifecycle.helpers';

const WRITE_ROLES: WorkspaceRole[] = [
  WorkspaceRole.OWNER,
  WorkspaceRole.ADMIN,
  WorkspaceRole.MEMBER,
];
const SECRET_WRITE_ROLES: WorkspaceRole[] = [WorkspaceRole.OWNER, WorkspaceRole.ADMIN];
const AUDIT_VIEW_ROLES: WorkspaceRole[] = [WorkspaceRole.OWNER, WorkspaceRole.ADMIN];
const SENSITIVE_KEY_PATTERN = /SECRET|TOKEN|PASSWORD|API_KEY|DATABASE_URL|REDIS_URL|DSN|SENTRY/i;

function isSensitiveConfigKey(key: string, requirementSensitive?: boolean): boolean {
  return Boolean(requirementSensitive) || SENSITIVE_KEY_PATTERN.test(key);
}

@Injectable()
export class RuntimeConfigService {
  private readonly resolver: RuntimeConfigResolver;

  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaceAccess: WorkspaceAccessService,
  ) {
    this.resolver = new RuntimeConfigResolver(prisma);
  }

  async listRequirements(userId: string, projectId: string, unitId: string) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    const unit = await this.requireUnit(projectId, unitId);
    const [requirements, unitValues, projectValues, summary, unitMeta, activeService] =
      await Promise.all([
      this.prisma.runtimeConfigRequirement.findMany({
        where: { projectId, deployableUnitId: unit.id },
        orderBy: [{ required: 'desc' }, { key: 'asc' }],
      }),
      this.prisma.runtimeConfigValue.findMany({
        where: {
          projectId,
          scopeType: RuntimeConfigScopeType.UNIT,
          scopeId: unit.id,
        },
        select: {
          key: true,
          isSensitive: true,
          valueEncrypted: true,
          updatedAt: true,
          lastRotatedAt: true,
          rotationIntervalDays: true,
          updatedBy: true,
          createdBy: true,
          provider: true,
          providerRef: true,
          source: true,
        },
      }),
      this.prisma.runtimeConfigValue.findMany({
        where: {
          projectId,
          scopeType: RuntimeConfigScopeType.PROJECT,
          scopeId: projectId,
        },
        select: {
          key: true,
          isSensitive: true,
          valueEncrypted: true,
          updatedAt: true,
          lastRotatedAt: true,
          rotationIntervalDays: true,
          updatedBy: true,
          createdBy: true,
          provider: true,
          providerRef: true,
          source: true,
        },
      }),
      this.summarizeUnit(projectId, unit.id),
      this.prisma.deployableUnit.findUnique({
        where: { id: unit.id },
        select: { configRevision: true },
      }),
      this.prisma.serviceInstance.findFirst({
        where: {
          projectId,
          deployableUnitId: unit.id,
          status: ServiceStatus.RUNNING,
        },
        orderBy: { updatedAt: 'desc' },
        select: { configRevision: true, configFingerprint: true },
      }),
    ]);

    const canEdit = WRITE_ROLES.includes(membership.role);
    const canViewAudit = AUDIT_VIEW_ROLES.includes(membership.role);
    const unitValueByKey = new Map(unitValues.map((item) => [item.key, item as ConfigValueMeta]));
    const projectValueByKey = new Map(projectValues.map((item) => [item.key, item as ConfigValueMeta]));
    const actorIds = new Set<string>();
    for (const row of [...unitValues, ...projectValues]) {
      if (row.updatedBy) actorIds.add(row.updatedBy);
      if (row.createdBy) actorIds.add(row.createdBy);
    }
    const actorNameById = await this.loadActorNames([...actorIds]);
    const currentRevision = unitMeta?.configRevision ?? 0;
    const appliedRevision = activeService?.configRevision ?? null;
    const pendingApply =
      appliedRevision != null && currentRevision > appliedRevision
        ? true
        : Boolean(activeService && appliedRevision == null && currentRevision > 0);

    return {
      unit: {
        id: unit.id,
        name: unit.name,
        type: unit.type,
        rootPath: unit.rootPath,
      },
      summary: {
        ...summary,
        configRevision: currentRevision,
        appliedRevision,
        pendingApply,
      },
      canEdit,
      canEditSecrets: SECRET_WRITE_ROLES.includes(membership.role),
      canViewAudit,
      secretFilesWarning: null as string | null,
      applyHint: pendingApply
        ? '运行配置已更新，等待重新上线'
        : activeService
          ? null
          : null,
      requirements: requirements.map((item) => {
        const sensitive = isSensitiveConfigKey(item.key, item.sensitive);
        const unitStored = unitValueByKey.get(item.key);
        const projectStored = projectValueByKey.get(item.key);
        const effective = resolveEffectiveEntry(item, unitStored, projectStored);
        const hasUnitOverride = effective.hasUnitOverride;
        const hasProjectValue = effective.hasProjectValue;
        const resolvedSource = effective.source;
        const effectiveConfigured = effective.configured;
        const missing =
          item.required && !effectiveConfigured && !item.managedByLaunchOS;
        const configured = effectiveConfigured && !missing;
        let value: string | null = null;
        if (canEdit && !sensitive && !item.managedByLaunchOS) {
          if (unitStored) {
            try {
              value = decryptCredential(unitStored.valueEncrypted);
            } catch {
              value = null;
            }
          } else if (projectStored) {
            try {
              value = decryptCredential(projectStored.valueEncrypted);
            } catch {
              value = null;
            }
          } else if (item.defaultValue) {
            value = item.defaultValue;
          }
        }
        let applyStatus: 'missing' | 'pending' | 'applied' | 'managed' = 'missing';
        if (item.managedByLaunchOS) {
          applyStatus = 'managed';
        } else if (!configured || missing) {
          applyStatus = 'missing';
        } else if (pendingApply) {
          applyStatus = 'pending';
        } else if (activeService) {
          applyStatus = 'applied';
        } else {
          applyStatus = 'pending';
        }
        const needsRedeploy = pendingApply && configured && resolvedSource !== 'MISSING';
        const { meta: effectiveMeta } = resolveEffectiveValueMeta(
          item,
          unitStored as ConfigValueMeta | undefined,
          projectStored as ConfigValueMeta | undefined,
        );
        const secretMeta = buildSecretMetadata({
          key: item.key,
          configured: configured && !missing,
          needsRedeploy,
          valueMeta: effectiveMeta,
        });
        const lastUpdatedById = effectiveMeta?.updatedBy ?? effectiveMeta?.createdBy ?? null;
        const generatable = isGeneratableRuntimeSecret(item.key);
        const valueSource =
          (unitStored?.source || projectStored?.source || null) as string | null;
        const originLabel = valueOriginLabel(valueSource);
        return {
          key: item.key,
          label: item.label,
          description: item.description,
          required: item.required,
          sensitive,
          managedByLaunchOS: item.managedByLaunchOS,
          publicSafe: item.publicSafe,
          injectionPhase: item.injectionPhase,
          source: item.source,
          sourceLocation: item.sourceLocation,
          confidence: item.confidence,
          status: item.status,
          configured: configured && !missing,
          effectiveConfigured: configured,
          missing,
          applyStatus,
          resolvedSource,
          resolvedSourceLabel: resolvedSourceLabel(resolvedSource),
          valueOrigin: valueSource,
          valueOriginLabel: originLabel,
          configType: runtimeConfigValueType(item.key),
          generatable,
          hasUnitOverride,
          hasProjectValue,
          overrideHint:
            hasUnitOverride && hasProjectValue ? '已覆盖应用共享配置' : null,
          maskedValue:
            (unitStored || projectStored) && sensitive ? '••••••••' : null,
          value,
          defaultValue: sensitive ? null : item.defaultValue,
          ...secretMeta,
          lastUpdatedByName: lastUpdatedById ? actorNameById.get(lastUpdatedById) ?? null : null,
          suggestedRotationIntervalDays: sensitive
            ? secretMeta.suggestedRotationIntervalDays
            : null,
          provider: effectiveMeta && 'provider' in effectiveMeta
            ? (effectiveMeta as { provider?: string | null }).provider ?? null
            : null,
          managedByDatabaseConnection:
            (effectiveMeta as { provider?: string | null } | null)?.provider ===
            'DATABASE_CONNECTION',
          managedByRedisConnection:
            (effectiveMeta as { provider?: string | null } | null)?.provider ===
            'REDIS_CONNECTION',
          providerLabel:
            (effectiveMeta as { provider?: string | null } | null)?.provider ===
            'DATABASE_CONNECTION'
              ? 'PostgreSQL 数据库'
              : (effectiveMeta as { provider?: string | null } | null)?.provider ===
                  'REDIS_CONNECTION'
                ? 'Redis'
                : null,
        };
      }),
    };
  }

  async getPublicValuesForDisplay(userId: string, projectId: string, unitId: string) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    await this.requireUnit(projectId, unitId);
    const values = await this.prisma.runtimeConfigValue.findMany({
      where: {
        projectId,
        scopeType: RuntimeConfigScopeType.UNIT,
        scopeId: unitId,
        isSensitive: false,
      },
      select: { key: true, valueEncrypted: true },
    });
    // Decrypt only non-sensitive for editors; viewers get keys only
    const canSee = WRITE_ROLES.includes(membership.role);
    if (!canSee) {
      return values.map((item) => ({ key: item.key, configured: true, value: null }));
    }
    const { decryptCredential } = await import('@launchos/shared');
    return values.map((item) => ({
      key: item.key,
      configured: true,
      value: decryptCredential(item.valueEncrypted),
    }));
  }

  async upsertValue(
    userId: string,
    projectId: string,
    unitId: string,
    key: string,
    value: string,
  ) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    const unit = await this.requireUnit(projectId, unitId);
    const trimmedKey = key.trim();
    const trimmedValue = value?.trim() ?? '';
    if (!trimmedKey || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmedKey)) {
      throw new BadRequestException('配置项名称无效');
    }
    if (!trimmedValue) {
      throw new BadRequestException('请填写配置值');
    }

    const requirement = await this.prisma.runtimeConfigRequirement.findUnique({
      where: {
        deployableUnitId_key: { deployableUnitId: unit.id, key: trimmedKey },
      },
    });
    const sensitive = isSensitiveConfigKey(trimmedKey, requirement?.sensitive);
    if (sensitive) {
      this.requireSecretWrite(membership.role);
    } else {
      this.workspaceAccess.requireWriteAccess(membership.role);
    }
    if (requirement?.managedByLaunchOS || isManagedConfigKey(trimmedKey)) {
      throw new BadRequestException('该项由 LaunchOS 自动管理，无需手动配置。');
    }

    const existing = await this.prisma.runtimeConfigValue.findUnique({
      where: {
        scopeType_scopeId_key: {
          scopeType: RuntimeConfigScopeType.UNIT,
          scopeId: unit.id,
          key: trimmedKey,
        },
      },
      select: { id: true },
    });
    const revisionBefore = await this.readUnitRevision(unit.id);
    const encrypted = this.encryptConfigValue(trimmedValue);
    const now = new Date();

    await this.prisma.runtimeConfigValue.upsert({
      where: {
        scopeType_scopeId_key: {
          scopeType: RuntimeConfigScopeType.UNIT,
          scopeId: unit.id,
          key: trimmedKey,
        },
      },
      create: {
        projectId,
        scopeType: RuntimeConfigScopeType.UNIT,
        scopeId: unit.id,
        deployableUnitId: unit.id,
        scope: 'UNIT',
        requirementId: requirement?.id ?? null,
        key: trimmedKey,
        valueEncrypted: encrypted,
        isSensitive: sensitive,
        source: 'MANUAL',
        createdBy: userId,
        updatedBy: userId,
        lastRotatedAt: sensitive ? now : null,
      },
      update: {
        valueEncrypted: encrypted,
        isSensitive: sensitive,
        requirementId: requirement?.id ?? null,
        source: 'MANUAL',
        updatedBy: userId,
        ...(sensitive ? { lastRotatedAt: now } : {}),
      },
    });

    if (requirement) {
      await this.prisma.runtimeConfigRequirement.update({
        where: { id: requirement.id },
        data: { status: RuntimeConfigRequirementStatus.CONFIGURED },
      });
    }

    await this.bumpConfigRevision(unit.id);
    const revisionAfter = revisionBefore + 1;

    await this.recordSecretAudit({
      projectId,
      deployableUnitId: unit.id,
      scopeType: RuntimeConfigScopeType.UNIT,
      scopeId: unit.id,
      key: trimmedKey,
      action: existing ? SecretAuditAction.UPDATED : SecretAuditAction.CREATED,
      actorUserId: userId,
      metadata: sanitizeAuditMetadata({
        previousRevision: revisionBefore,
        newRevision: revisionAfter,
        productAction: 'SET',
        origin: 'MANUAL',
      }),
    });

    return {
      key: trimmedKey,
      configured: true,
      sensitive,
      maskedValue: sensitive ? '••••••••' : null,
      needsRedeploy: true,
      valueOrigin: 'MANUAL',
      valueOriginLabel: '手动填写',
      message: '配置已更新，重新上线后生效。',
    };
  }

  async generateValue(userId: string, projectId: string, unitId: string, key: string) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    const unit = await this.requireUnit(projectId, unitId);
    const trimmedKey = key.trim();
    if (!trimmedKey || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmedKey)) {
      throw new BadRequestException('配置项名称无效');
    }
    if (!isGeneratableRuntimeSecret(trimmedKey)) {
      throw new BadRequestException('该项不能由 LaunchOS 自动生成，请手动填写。');
    }
    this.requireSecretWrite(membership.role);

    const requirement = await this.prisma.runtimeConfigRequirement.findUnique({
      where: {
        deployableUnitId_key: { deployableUnitId: unit.id, key: trimmedKey },
      },
    });
    if (requirement?.managedByLaunchOS || isManagedConfigKey(trimmedKey)) {
      throw new BadRequestException('该项由 LaunchOS 自动管理，无需手动配置。');
    }

    const existing = await this.prisma.runtimeConfigValue.findUnique({
      where: {
        scopeType_scopeId_key: {
          scopeType: RuntimeConfigScopeType.UNIT,
          scopeId: unit.id,
          key: trimmedKey,
        },
      },
      select: { id: true },
    });
    const revisionBefore = await this.readUnitRevision(unit.id);
    const plaintext = generateSecureRuntimeSecret(32);
    const encrypted = this.encryptConfigValue(plaintext);
    const now = new Date();

    await this.prisma.runtimeConfigValue.upsert({
      where: {
        scopeType_scopeId_key: {
          scopeType: RuntimeConfigScopeType.UNIT,
          scopeId: unit.id,
          key: trimmedKey,
        },
      },
      create: {
        projectId,
        scopeType: RuntimeConfigScopeType.UNIT,
        scopeId: unit.id,
        deployableUnitId: unit.id,
        scope: 'UNIT',
        requirementId: requirement?.id ?? null,
        key: trimmedKey,
        valueEncrypted: encrypted,
        isSensitive: true,
        source: 'GENERATED',
        createdBy: userId,
        updatedBy: userId,
        lastRotatedAt: now,
      },
      update: {
        valueEncrypted: encrypted,
        isSensitive: true,
        requirementId: requirement?.id ?? null,
        source: 'GENERATED',
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

    await this.bumpConfigRevision(unit.id);
    const revisionAfter = revisionBefore + 1;

    await this.recordSecretAudit({
      projectId,
      deployableUnitId: unit.id,
      scopeType: RuntimeConfigScopeType.UNIT,
      scopeId: unit.id,
      key: trimmedKey,
      action: existing ? SecretAuditAction.UPDATED : SecretAuditAction.CREATED,
      actorUserId: userId,
      metadata: sanitizeAuditMetadata({
        previousRevision: revisionBefore,
        newRevision: revisionAfter,
        productAction: 'GENERATE',
        origin: 'LAUNCHOS_GENERATED',
      }),
    });

    // Never return plaintext.
    return {
      key: trimmedKey,
      configured: true,
      sensitive: true,
      generated: true,
      maskedValue: '••••••••',
      needsRedeploy: true,
      valueOrigin: 'GENERATED',
      valueOriginLabel: 'LaunchOS 自动生成',
      message: '已自动生成安全值并保存。重新上线后生效。',
    };
  }

  async deleteValue(userId: string, projectId: string, unitId: string, key: string) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    const unit = await this.requireUnit(projectId, unitId);
    const existing = await this.prisma.runtimeConfigValue.findFirst({
      where: {
        projectId,
        scopeType: RuntimeConfigScopeType.UNIT,
        scopeId: unit.id,
        key,
      },
    });
    if (!existing) {
      throw new NotFoundException('未找到该配置');
    }
    if (existing.isSensitive) {
      this.requireSecretWrite(membership.role);
    } else {
      this.workspaceAccess.requireWriteAccess(membership.role);
    }

    const revisionBefore = await this.readUnitRevision(unit.id);
    await this.prisma.runtimeConfigValue.delete({ where: { id: existing.id } });
    await this.prisma.runtimeConfigRequirement.updateMany({
      where: { deployableUnitId: unit.id, key },
      data: { status: RuntimeConfigRequirementStatus.DETECTED },
    });
    await this.bumpConfigRevision(unit.id);

    await this.recordSecretAudit({
      projectId,
      deployableUnitId: unit.id,
      scopeType: RuntimeConfigScopeType.UNIT,
      scopeId: unit.id,
      key,
      action: SecretAuditAction.DELETED,
      actorUserId: userId,
      metadata: sanitizeAuditMetadata({
        previousRevision: revisionBefore,
        newRevision: revisionBefore + 1,
      }),
    });

    return {
      key,
      configured: false,
      message: '配置已删除。当前应用仍在使用上次上线时的配置。',
    };
  }

  async rescan(userId: string, projectId: string, unitId: string) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    this.workspaceAccess.requireWriteAccess(membership.role);
    const unit = await this.requireUnit(projectId, unitId);
    const warning = await this.scanAndPersist(projectId, unit.id, unit.rootPath);
    const listed = await this.listRequirements(userId, projectId, unitId);
    return {
      ...listed,
      secretFilesWarning: warning,
    };
  }

  async summarizeUnit(projectId: string, unitId: string) {
    const [requirements, unitValues, projectValues, unitMeta, activeService] = await Promise.all([
      this.prisma.runtimeConfigRequirement.findMany({
        where: { projectId, deployableUnitId: unitId },
        select: {
          key: true,
          label: true,
          required: true,
          sensitive: true,
          managedByLaunchOS: true,
          defaultValue: true,
          status: true,
          injectionPhase: true,
        },
      }),
      this.prisma.runtimeConfigValue.findMany({
        where: {
          projectId,
          scopeType: RuntimeConfigScopeType.UNIT,
          scopeId: unitId,
        },
        select: { key: true, valueEncrypted: true, isSensitive: true },
      }),
      this.prisma.runtimeConfigValue.findMany({
        where: {
          projectId,
          scopeType: RuntimeConfigScopeType.PROJECT,
          scopeId: projectId,
        },
        select: { key: true, valueEncrypted: true, isSensitive: true },
      }),
      this.prisma.deployableUnit.findUnique({
        where: { id: unitId },
        select: { configRevision: true },
      }),
      this.prisma.serviceInstance.findFirst({
        where: {
          projectId,
          deployableUnitId: unitId,
          status: ServiceStatus.RUNNING,
        },
        orderBy: { updatedAt: 'desc' },
        select: { configRevision: true },
      }),
    ]);
    const unitValueByKey = new Map(unitValues.map((item) => [item.key, item]));
    const projectValueByKey = new Map(projectValues.map((item) => [item.key, item]));
    const userFacing = requirements.filter((item) => !item.managedByLaunchOS);
    const missingRequired = userFacing.filter((item) => {
      const effective = resolveEffectiveEntry(item, unitValueByKey.get(item.key), projectValueByKey.get(item.key));
      return item.required && !effective.configured;
    });
    const completed = userFacing.filter((item) => {
      const effective = resolveEffectiveEntry(item, unitValueByKey.get(item.key), projectValueByKey.get(item.key));
      return effective.configured;
    });
    const currentRevision = unitMeta?.configRevision ?? 0;
    const appliedRevision = activeService?.configRevision ?? null;
    const pendingApply =
      appliedRevision != null
        ? currentRevision > appliedRevision
        : Boolean(activeService && currentRevision > 0);
    return {
      total: userFacing.length,
      completed: completed.length,
      missingRequired: missingRequired.length,
      missingLabels: missingRequired.map((item) => item.label || item.key),
      configRevision: currentRevision,
      appliedRevision,
      pendingApply,
    };
  }

  async getMissingRequired(projectId: string, unitId: string) {
    return this.resolver.getMissingRequiredForDeploy(projectId, unitId);
  }

  /**
   * Resolve decrypted env for a unit + phase (used by API plumbing / tests).
   * Plaintext stays in memory only.
   */
  async resolvedRuntimeConfig(
    projectId: string,
    unitId: string,
    phase: 'BUILD' | 'RUNTIME' = 'RUNTIME',
    containerPort?: number,
  ): Promise<Record<string, string>> {
    const resolved = await this.resolver.resolve({
      projectId,
      deployableUnitId: unitId,
      phase,
      containerPort,
    });
    return resolved.env;
  }

  private async bumpConfigRevision(unitId: string): Promise<void> {
    await this.prisma.deployableUnit.update({
      where: { id: unitId },
      data: { configRevision: { increment: 1 } },
    });
  }

  private async loadProjectValueMap(projectId: string): Promise<Map<string, ConfigValueLike>> {
    const values = await this.prisma.runtimeConfigValue.findMany({
      where: {
        projectId,
        scopeType: RuntimeConfigScopeType.PROJECT,
        scopeId: projectId,
      },
      select: {
        key: true,
        valueEncrypted: true,
        isSensitive: true,
        updatedAt: true,
        lastRotatedAt: true,
        rotationIntervalDays: true,
        updatedBy: true,
        createdBy: true,
      },
    });
    return new Map(values.map((item) => [item.key, item]));
  }

  private async propagateProjectConfigChange(
    projectId: string,
    changedKey: string,
    projectValuesBefore: Map<string, ConfigValueLike>,
    projectValuesAfter: Map<string, ConfigValueLike>,
  ): Promise<void> {
    const [units, requirements, unitValueRows] = await Promise.all([
      this.prisma.deployableUnit.findMany({
        where: { projectId },
        select: { id: true, configRevision: true, port: true },
      }),
      this.prisma.runtimeConfigRequirement.findMany({
        where: { projectId },
        select: {
          deployableUnitId: true,
          key: true,
          label: true,
          required: true,
          sensitive: true,
          managedByLaunchOS: true,
          defaultValue: true,
          injectionPhase: true,
        },
      }),
      this.prisma.runtimeConfigValue.findMany({
        where: { projectId, scopeType: RuntimeConfigScopeType.UNIT },
        select: {
          scopeId: true,
          key: true,
          valueEncrypted: true,
          isSensitive: true,
          updatedAt: true,
        },
      }),
    ]);

    const requirementsByUnit = new Map<string, ConfigRequirementLike[]>();
    for (const req of requirements) {
      const list = requirementsByUnit.get(req.deployableUnitId) ?? [];
      list.push(req);
      requirementsByUnit.set(req.deployableUnitId, list);
    }

    const unitValuesByUnit = new Map<string, Map<string, ConfigValueLike>>();
    for (const row of unitValueRows) {
      const map = unitValuesByUnit.get(row.scopeId) ?? new Map<string, ConfigValueLike>();
      map.set(row.key, row);
      unitValuesByUnit.set(row.scopeId, map);
    }

    const affected = collectUnitsAffectedByProjectKeyChange({
      changedKey,
      units: units.map((unit) => ({
        id: unit.id,
        configRevision: unit.configRevision,
        port: unit.port,
        requirements: requirementsByUnit.get(unit.id) ?? [],
        unitValues: unitValuesByUnit.get(unit.id) ?? new Map(),
      })),
      projectValuesBefore,
      projectValuesAfter,
    });

    if (affected.length === 0) {
      return;
    }

    await this.prisma.deployableUnit.updateMany({
      where: { id: { in: affected } },
      data: { configRevision: { increment: 1 } },
    });
  }

  async collectKnownSecrets(projectId: string): Promise<string[]> {
    const values = await this.prisma.runtimeConfigValue.findMany({
      where: { projectId, isSensitive: true },
      select: { valueEncrypted: true },
    });
    const secrets: string[] = [];
    for (const item of values) {
      try {
        secrets.push(decryptCredential(item.valueEncrypted));
      } catch {
        // ignore undecryptable
      }
    }
    return secrets;
  }

  async listProjectConfig(userId: string, projectId: string) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    const canEdit = WRITE_ROLES.includes(membership.role);
    const canEditSecrets = SECRET_WRITE_ROLES.includes(membership.role);
    const canViewAudit = AUDIT_VIEW_ROLES.includes(membership.role);

    const [projectValues, requirements, units, runningServices, unitValueRows] = await Promise.all([
      this.prisma.runtimeConfigValue.findMany({
        where: {
          projectId,
          scopeType: RuntimeConfigScopeType.PROJECT,
          scopeId: projectId,
        },
        orderBy: { key: 'asc' },
      }),
      this.prisma.runtimeConfigRequirement.findMany({
        where: { projectId },
        select: {
          key: true,
          label: true,
          description: true,
          sensitive: true,
          deployableUnitId: true,
        },
      }),
      this.prisma.deployableUnit.findMany({
        where: { projectId },
        select: { id: true, name: true, configRevision: true, port: true },
      }),
      this.prisma.serviceInstance.findMany({
        where: { projectId, status: ServiceStatus.RUNNING },
        select: { deployableUnitId: true, configRevision: true },
      }),
      this.prisma.runtimeConfigValue.findMany({
        where: { projectId, scopeType: RuntimeConfigScopeType.UNIT },
        select: {
          scopeId: true,
          key: true,
          valueEncrypted: true,
          isSensitive: true,
          updatedAt: true,
          lastRotatedAt: true,
          rotationIntervalDays: true,
          updatedBy: true,
          createdBy: true,
        },
      }),
    ]);

    const reqByKey = new Map<string, typeof requirements>();
    for (const req of requirements) {
      const list = reqByKey.get(req.key) ?? [];
      list.push(req);
      reqByKey.set(req.key, list);
    }

    const unitNameById = new Map(units.map((item) => [item.id, item.name]));
    const appliedRevisionByUnit = new Map<string, number | null>();
    for (const unit of units) {
      appliedRevisionByUnit.set(unit.id, null);
    }
    for (const service of runningServices) {
      if (!service.deployableUnitId) {
        continue;
      }
      appliedRevisionByUnit.set(service.deployableUnitId, service.configRevision ?? null);
    }
    const unitValuesByUnit = new Map<string, Map<string, ConfigValueMeta>>();
    for (const row of unitValueRows) {
      const map = unitValuesByUnit.get(row.scopeId) ?? new Map<string, ConfigValueMeta>();
      map.set(row.key, row);
      unitValuesByUnit.set(row.scopeId, map);
    }

    const pendingByUnit = new Map<string, boolean>();
    const pendingUnitIds = new Set<string>();
    for (const unit of units) {
      const applied = appliedRevisionByUnit.get(unit.id) ?? null;
      const hasRunning = runningServices.some((service) => service.deployableUnitId === unit.id);
      const pending = computeUnitPendingApply({
        currentRevision: unit.configRevision,
        appliedRevision: applied,
        hasRunningService: hasRunning,
      });
      pendingByUnit.set(unit.id, pending);
      if (pending) {
        pendingUnitIds.add(unit.id);
      }
    }

    const actorIds = new Set<string>();
    for (const item of projectValues) {
      if (item.updatedBy) actorIds.add(item.updatedBy);
      if (item.createdBy) actorIds.add(item.createdBy);
    }
    const actorNameById = await this.loadActorNames([...actorIds]);

    const configs = projectValues.map((item) => {
      const related = reqByKey.get(item.key) ?? [];
      const usingUnits = related
        .map((req) => ({
          id: req.deployableUnitId,
          name: unitNameById.get(req.deployableUnitId) ?? req.deployableUnitId,
        }))
        .filter((entry, index, arr) => arr.findIndex((x) => x.id === entry.id) === index);
      const usageCategory =
        usingUnits.length === 0
          ? 'unused'
          : usingUnits.length === 1
            ? 'single'
            : 'multiple';
      const label = related[0]?.label ?? item.key;
      const description = related[0]?.description ?? '';
      const sensitive = item.isSensitive || related.some((req) => req.sensitive);
      const unitApplyStatuses = usingUnits.map((unitEntry) => {
        const unitReq = related.find((req) => req.deployableUnitId === unitEntry.id);
        const unitStored = unitValuesByUnit.get(unitEntry.id)?.get(item.key);
        const applyStatus = computeUnitApplyStatus({
          requirement: unitReq
            ? {
                ...unitReq,
                required: false,
                managedByLaunchOS: false,
                defaultValue: null,
                injectionPhase: RuntimeConfigInjectionPhase.RUNTIME,
              }
            : undefined,
          unitStored,
          projectStored: item as ConfigValueMeta,
          pendingApply: pendingByUnit.get(unitEntry.id) ?? false,
        });
        return {
          id: unitEntry.id,
          name: unitEntry.name,
          applyStatus,
          applyStatusLabel: unitApplyStatusLabel(applyStatus),
        };
      });
      const secretMeta = buildSecretMetadata({
        key: item.key,
        configured: true,
        needsRedeploy: unitApplyStatuses.some((entry) => entry.applyStatus === 'pending'),
        valueMeta: item as ConfigValueMeta,
      });
      const lastUpdatedById = item.updatedBy ?? item.createdBy ?? null;
      return {
        key: item.key,
        label,
        description,
        sensitive,
        configured: true,
        maskedValue: sensitive ? '••••••••' : null,
        usingUnits,
        unitApplyStatuses,
        usageCategory,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        createdBy: item.createdBy,
        updatedBy: item.updatedBy,
        ...secretMeta,
        lastUpdatedByName: lastUpdatedById ? actorNameById.get(lastUpdatedById) ?? null : null,
        suggestedRotationIntervalDays: sensitive ? secretMeta.suggestedRotationIntervalDays : null,
      };
    });

    const unitsUsingShared = new Set<string>();
    for (const config of configs) {
      for (const unit of config.usingUnits) {
        unitsUsingShared.add(unit.id);
      }
    }

    return {
      summary: {
        total: configs.length,
        unitsUsingCount: unitsUsingShared.size,
        pendingRedeployCount: pendingUnitIds.size,
      },
      canEdit,
      canEditSecrets,
      canViewAudit,
      configs,
      pendingUnits: units
        .filter((unit) => pendingUnitIds.has(unit.id))
        .map((unit) => ({ id: unit.id, name: unit.name })),
    };
  }

  async upsertProjectValue(
    userId: string,
    projectId: string,
    key: string,
    value: string,
  ) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    const trimmedKey = key.trim();
    const trimmedValue = value?.trim() ?? '';
    if (!trimmedKey || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmedKey)) {
      throw new BadRequestException('配置项名称无效');
    }
    if (!trimmedValue) {
      throw new BadRequestException('请填写配置值');
    }
    if (isManagedConfigKey(trimmedKey)) {
      throw new BadRequestException('该项由 LaunchOS 自动管理，无法设为应用共享配置。');
    }

    const relatedRequirements = await this.prisma.runtimeConfigRequirement.findMany({
      where: { projectId, key: trimmedKey },
      select: { sensitive: true, managedByLaunchOS: true },
    });
    if (relatedRequirements.some((item) => item.managedByLaunchOS)) {
      throw new BadRequestException('该项由 LaunchOS 自动管理，无法设为应用共享配置。');
    }

    const sensitive = isSensitiveConfigKey(
      trimmedKey,
      relatedRequirements.some((item) => item.sensitive),
    );
    if (sensitive) {
      this.requireSecretWrite(membership.role);
    } else {
      this.workspaceAccess.requireWriteAccess(membership.role);
    }

    const existing = await this.prisma.runtimeConfigValue.findUnique({
      where: {
        scopeType_scopeId_key: {
          scopeType: RuntimeConfigScopeType.PROJECT,
          scopeId: projectId,
          key: trimmedKey,
        },
      },
    });

    const projectValuesBefore = await this.loadProjectValueMap(projectId);
    const encrypted = this.encryptConfigValue(trimmedValue);
    const now = new Date();
    const sharedRevisionBefore = await this.readSharedConfigRevision(projectId);

    await this.prisma.runtimeConfigValue.upsert({
      where: {
        scopeType_scopeId_key: {
          scopeType: RuntimeConfigScopeType.PROJECT,
          scopeId: projectId,
          key: trimmedKey,
        },
      },
      create: {
        projectId,
        scopeType: RuntimeConfigScopeType.PROJECT,
        scopeId: projectId,
        deployableUnitId: null,
        scope: 'PROJECT',
        key: trimmedKey,
        valueEncrypted: encrypted,
        isSensitive: sensitive,
        source: 'MANUAL',
        createdBy: userId,
        updatedBy: userId,
        lastRotatedAt: sensitive ? now : null,
      },
      update: {
        valueEncrypted: encrypted,
        isSensitive: sensitive,
        updatedBy: userId,
        ...(sensitive ? { lastRotatedAt: now } : {}),
      },
    });

    const projectValuesAfter = await this.loadProjectValueMap(projectId);
    await this.propagateProjectConfigChange(
      projectId,
      trimmedKey,
      projectValuesBefore,
      projectValuesAfter,
    );

    await this.prisma.project.update({
      where: { id: projectId },
      data: { sharedConfigRevision: { increment: 1 } },
    });

    await this.recordSecretAudit({
      projectId,
      deployableUnitId: null,
      scopeType: RuntimeConfigScopeType.PROJECT,
      scopeId: projectId,
      key: trimmedKey,
      action: existing ? SecretAuditAction.UPDATED : SecretAuditAction.CREATED,
      actorUserId: userId,
      metadata: sanitizeAuditMetadata({
        previousRevision: sharedRevisionBefore,
        newRevision: sharedRevisionBefore + 1,
      }),
    });

    return {
      key: trimmedKey,
      configured: true,
      sensitive,
      maskedValue: sensitive ? '••••••••' : null,
      created: !existing,
      needsRedeploy: true,
      message: existing
        ? '共享配置已更新，依赖此配置的组成需要重新上线后生效。'
        : '共享配置已创建。',
    };
  }

  async deleteProjectValue(userId: string, projectId: string, key: string) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    const existing = await this.prisma.runtimeConfigValue.findUnique({
      where: {
        scopeType_scopeId_key: {
          scopeType: RuntimeConfigScopeType.PROJECT,
          scopeId: projectId,
          key,
        },
      },
    });
    if (!existing) {
      throw new NotFoundException('未找到该共享配置');
    }
    if (existing.isSensitive) {
      this.requireSecretWrite(membership.role);
    } else {
      this.workspaceAccess.requireWriteAccess(membership.role);
    }

    const projectValuesBefore = await this.loadProjectValueMap(projectId);
    const sharedRevisionBefore = await this.readSharedConfigRevision(projectId);
    await this.prisma.runtimeConfigValue.delete({ where: { id: existing.id } });
    const projectValuesAfter = await this.loadProjectValueMap(projectId);

    await this.propagateProjectConfigChange(
      projectId,
      key,
      projectValuesBefore,
      projectValuesAfter,
    );

    await this.prisma.project.update({
      where: { id: projectId },
      data: { sharedConfigRevision: { increment: 1 } },
    });

    await this.recordSecretAudit({
      projectId,
      deployableUnitId: null,
      scopeType: RuntimeConfigScopeType.PROJECT,
      scopeId: projectId,
      key,
      action: SecretAuditAction.DELETED,
      actorUserId: userId,
      metadata: sanitizeAuditMetadata({
        previousRevision: sharedRevisionBefore,
        newRevision: sharedRevisionBefore + 1,
      }),
    });

    return {
      key,
      configured: false,
      message: '共享配置已删除。依赖此配置且未单独覆盖的组成将变为缺少配置。',
    };
  }

  async promoteToShared(
    userId: string,
    projectId: string,
    unitId: string,
    key: string,
  ) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    const unit = await this.requireUnit(projectId, unitId);
    const unitValue = await this.prisma.runtimeConfigValue.findUnique({
      where: {
        scopeType_scopeId_key: {
          scopeType: RuntimeConfigScopeType.UNIT,
          scopeId: unit.id,
          key,
        },
      },
    });
    if (!unitValue) {
      throw new NotFoundException('该组成尚未配置此项，无法提升为共享配置');
    }

    if (unitValue.isSensitive) {
      this.requireSecretWrite(membership.role);
    } else {
      this.workspaceAccess.requireWriteAccess(membership.role);
    }
    if (isManagedConfigKey(key)) {
      throw new BadRequestException('该项由 LaunchOS 自动管理，无法设为应用共享配置。');
    }

    const plaintext = decryptCredential(unitValue.valueEncrypted);
    const projectValuesBefore = await this.loadProjectValueMap(projectId);
    const encrypted = this.encryptConfigValue(plaintext);
    const sharedRevisionBefore = await this.readSharedConfigRevision(projectId);

    await this.prisma.runtimeConfigValue.upsert({
      where: {
        scopeType_scopeId_key: {
          scopeType: RuntimeConfigScopeType.PROJECT,
          scopeId: projectId,
          key,
        },
      },
      create: {
        projectId,
        scopeType: RuntimeConfigScopeType.PROJECT,
        scopeId: projectId,
        deployableUnitId: null,
        scope: 'PROJECT',
        key,
        valueEncrypted: encrypted,
        isSensitive: unitValue.isSensitive,
        source: 'PROMOTED',
        createdBy: userId,
        updatedBy: userId,
        lastRotatedAt: unitValue.lastRotatedAt,
        rotationIntervalDays: unitValue.rotationIntervalDays,
      },
      update: {
        valueEncrypted: encrypted,
        isSensitive: unitValue.isSensitive,
        updatedBy: userId,
      },
    });

    await this.prisma.runtimeConfigValue.delete({ where: { id: unitValue.id } });

    const projectValuesAfter = await this.loadProjectValueMap(projectId);
    await this.propagateProjectConfigChange(
      projectId,
      key,
      projectValuesBefore,
      projectValuesAfter,
    );

    await this.prisma.project.update({
      where: { id: projectId },
      data: { sharedConfigRevision: { increment: 1 } },
    });

    await this.recordSecretAudit({
      projectId,
      deployableUnitId: unitId,
      scopeType: RuntimeConfigScopeType.UNIT,
      scopeId: unitId,
      key,
      action: SecretAuditAction.PROMOTED_TO_PROJECT,
      actorUserId: userId,
      metadata: sanitizeAuditMetadata({
        fromScope: RuntimeConfigScopeType.UNIT,
        toScope: RuntimeConfigScopeType.PROJECT,
        previousRevision: sharedRevisionBefore,
        newRevision: sharedRevisionBefore + 1,
      }),
    });

    return {
      key,
      message: '已设为应用共享配置，并移除本组成的单独设置。',
    };
  }

  async restoreShared(userId: string, projectId: string, unitId: string, key: string) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    const unit = await this.requireUnit(projectId, unitId);
    const existing = await this.prisma.runtimeConfigValue.findFirst({
      where: {
        projectId,
        scopeType: RuntimeConfigScopeType.UNIT,
        scopeId: unit.id,
        key,
      },
    });
    if (!existing) {
      throw new BadRequestException('当前没有本组成覆盖，无需恢复。');
    }
    if (existing.isSensitive) {
      this.requireSecretWrite(membership.role);
    } else {
      this.workspaceAccess.requireWriteAccess(membership.role);
    }

    const projectValue = await this.prisma.runtimeConfigValue.findUnique({
      where: {
        scopeType_scopeId_key: {
          scopeType: RuntimeConfigScopeType.PROJECT,
          scopeId: projectId,
          key,
        },
      },
    });
    if (!projectValue) {
      throw new BadRequestException('应用尚未设置此共享配置，无法恢复。');
    }

    const revisionBefore = await this.readUnitRevision(unit.id);
    await this.prisma.runtimeConfigValue.delete({ where: { id: existing.id } });
    await this.bumpConfigRevision(unit.id);

    await this.recordSecretAudit({
      projectId,
      deployableUnitId: unit.id,
      scopeType: RuntimeConfigScopeType.UNIT,
      scopeId: unit.id,
      key,
      action: SecretAuditAction.RESTORED_SHARED,
      actorUserId: userId,
      metadata: sanitizeAuditMetadata({
        fromScope: RuntimeConfigScopeType.UNIT,
        toScope: RuntimeConfigScopeType.PROJECT,
        previousRevision: revisionBefore,
        newRevision: revisionBefore + 1,
      }),
    });

    return {
      key,
      message: '已恢复使用应用共享配置，重新上线后生效。',
      resolvedSource: 'PROJECT' as ResolvedConfigSource,
    };
  }

  async scanAndPersist(
    projectId: string,
    unitId: string,
    rootPath: string,
  ): Promise<string | null> {
    const repoRoot = await this.resolveRepoRoot(projectId);
    if (!repoRoot) {
      return null;
    }
    const unitRoot = resolveUnitPath(repoRoot, rootPath);
    const scanned = await scanUnitRuntimeConfig(unitRoot);
    const warning =
      scanned.secretFilesDetected.length > 0
        ? '检测到可能包含敏感信息的配置文件，LaunchOS 未读取其值。'
        : null;

    const existing = await this.prisma.runtimeConfigRequirement.findMany({
      where: { deployableUnitId: unitId },
    });
    const existingByKey = new Map(existing.map((item) => [item.key, item]));
    const seen = new Set<string>();

    for (const item of scanned.requirements) {
      seen.add(item.key);
      const prev = existingByKey.get(item.key);
      const data = {
        projectId,
        deployableUnitId: unitId,
        key: item.key,
        label: item.label,
        description: item.description,
        required: item.required,
        sensitive: item.sensitive,
        managedByLaunchOS: item.managedByLaunchOS,
        publicSafe: item.publicSafe,
        injectionPhase: item.injectionPhase as RuntimeConfigInjectionPhase,
        source: item.source as RuntimeConfigSource,
        sourceLocation: item.sourceLocation,
        defaultValue: item.sensitive ? null : item.defaultValue,
        confidence: item.confidence as RuntimeConfigConfidence,
        status: prev?.status === RuntimeConfigRequirementStatus.IGNORED
          ? RuntimeConfigRequirementStatus.IGNORED
          : prev?.status === RuntimeConfigRequirementStatus.CONFIGURED
            ? RuntimeConfigRequirementStatus.CONFIGURED
            : RuntimeConfigRequirementStatus.DETECTED,
      };
      await this.prisma.runtimeConfigRequirement.upsert({
        where: {
          deployableUnitId_key: { deployableUnitId: unitId, key: item.key },
        },
        create: data,
        update: {
          label: data.label,
          description: data.description,
          required: data.required,
          sensitive: data.sensitive,
          managedByLaunchOS: data.managedByLaunchOS,
          publicSafe: data.publicSafe,
          injectionPhase: data.injectionPhase,
          source: data.source,
          sourceLocation: data.sourceLocation,
          defaultValue: data.defaultValue,
          confidence: data.confidence,
        },
      });
    }

    // Remove stale DETECTED requirements no longer found (keep CONFIGURED/IGNORED/manual values)
    for (const prev of existing) {
      if (!seen.has(prev.key) && prev.status === RuntimeConfigRequirementStatus.DETECTED) {
        await this.prisma.runtimeConfigRequirement.delete({ where: { id: prev.id } });
      }
    }

    return warning;
  }

  private async resolveRepoRoot(projectId: string): Promise<string | null> {
    const source = await this.prisma.sourceRepository.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
    if (!source) {
      return null;
    }
    const git = new GitService();
    const directory = git.workspaceDir(projectId);
    const { access } = await import('node:fs/promises');
    try {
      await access(directory);
      try {
        // Keep rescan current with remote .env.example / requirements.
        await git.fetchBranch(directory, source.branch);
        await git.checkoutBranch(directory, source.branch);
        await git.resetHard(directory, `origin/${source.branch}`);
      } catch {
        // Stale local clone is still usable for requirements already present.
      }
    } catch {
      try {
        await git.cloneRepository(source.url, directory, source.branch);
        await git.checkoutBranch(directory, source.branch);
      } catch {
        return null;
      }
    }
    return directory;
  }

  private async requireUnit(projectId: string, unitId: string) {
    const unit = await this.prisma.deployableUnit.findFirst({
      where: { id: unitId, projectId },
      select: { id: true, name: true, type: true, rootPath: true },
    });
    if (!unit) {
      throw new NotFoundException('未找到该可上线内容');
    }
    return unit;
  }

  async listAuditEvents(
    userId: string,
    projectId: string,
    filters?: { key?: string; unitId?: string; scope?: RuntimeConfigScopeType },
  ) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    if (!AUDIT_VIEW_ROLES.includes(membership.role)) {
      throw new ForbiddenException('仅管理员可以查看配置审计');
    }

    const events = await this.prisma.secretAuditEvent.findMany({
      where: {
        projectId,
        ...(filters?.key ? { key: filters.key } : {}),
        ...(filters?.unitId ? { deployableUnitId: filters.unitId } : {}),
        ...(filters?.scope ? { scopeType: filters.scope } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    const actorIds = [...new Set(events.map((item) => item.actorUserId))];
    const actorNameById = await this.loadActorNames(actorIds);

    return {
      events: events.map((event) => ({
        id: event.id,
        key: event.key,
        action: event.action,
        scopeType: event.scopeType,
        scopeId: event.scopeId,
        deployableUnitId: event.deployableUnitId,
        actorUserId: event.actorUserId,
        actorName: actorNameById.get(event.actorUserId) ?? null,
        createdAt: event.createdAt,
        metadata: event.metadata,
      })),
    };
  }

  async getProjectDeleteImpact(userId: string, projectId: string, key: string) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    if (!WRITE_ROLES.includes(membership.role)) {
      throw new ForbiddenException('无权查看删除影响');
    }
    return this.buildProjectDeleteImpact(projectId, key);
  }

  async getUnitDeleteImpact(userId: string, projectId: string, unitId: string, key: string) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    if (!WRITE_ROLES.includes(membership.role)) {
      throw new ForbiddenException('无权查看删除影响');
    }
    await this.requireUnit(projectId, unitId);
    return this.buildUnitDeleteImpact(projectId, unitId, key);
  }

  async updateProjectRotationPolicy(
    userId: string,
    projectId: string,
    key: string,
    rotationIntervalDays: number | null,
  ) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    this.validateRotationInterval(rotationIntervalDays);

    const existing = await this.prisma.runtimeConfigValue.findUnique({
      where: {
        scopeType_scopeId_key: {
          scopeType: RuntimeConfigScopeType.PROJECT,
          scopeId: projectId,
          key,
        },
      },
    });
    if (!existing) {
      throw new NotFoundException('未找到该共享配置');
    }
    if (existing.isSensitive) {
      this.requireSecretWrite(membership.role);
    } else {
      this.workspaceAccess.requireWriteAccess(membership.role);
    }

    await this.prisma.runtimeConfigValue.update({
      where: { id: existing.id },
      data: { rotationIntervalDays },
    });

    return {
      key,
      rotationIntervalDays,
      message: rotationIntervalDays
        ? `已设置 ${rotationIntervalDays} 天轮换提醒。`
        : '已关闭轮换提醒。',
    };
  }

  async updateUnitRotationPolicy(
    userId: string,
    projectId: string,
    unitId: string,
    key: string,
    rotationIntervalDays: number | null,
  ) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    this.validateRotationInterval(rotationIntervalDays);
    const unit = await this.requireUnit(projectId, unitId);

    const existing = await this.prisma.runtimeConfigValue.findUnique({
      where: {
        scopeType_scopeId_key: {
          scopeType: RuntimeConfigScopeType.UNIT,
          scopeId: unit.id,
          key,
        },
      },
    });
    if (!existing) {
      throw new NotFoundException('未找到该配置');
    }
    if (existing.isSensitive) {
      this.requireSecretWrite(membership.role);
    } else {
      this.workspaceAccess.requireWriteAccess(membership.role);
    }

    await this.prisma.runtimeConfigValue.update({
      where: { id: existing.id },
      data: { rotationIntervalDays },
    });

    return {
      key,
      rotationIntervalDays,
      message: rotationIntervalDays
        ? `已设置 ${rotationIntervalDays} 天轮换提醒。`
        : '已关闭轮换提醒。',
    };
  }

  async getSecuritySummary(userId: string, projectId: string) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    const units = await this.prisma.deployableUnit.findMany({
      where: { projectId },
      select: { id: true, name: true },
    });
    const items: Array<{ rotationStatus: import('@launchos/shared').SecretRotationStatus; needsRedeploy: boolean; sensitive: boolean }> = [];

    for (const unit of units) {
      const listed = await this.listRequirements(userId, projectId, unit.id);
      for (const req of listed.requirements) {
        if (!req.sensitive || req.managedByLaunchOS) {
          continue;
        }
        items.push({
          rotationStatus: req.rotationStatus ?? 'CURRENT',
          needsRedeploy: Boolean(req.needsRedeploy),
          sensitive: true,
        });
      }
    }

    const counts = summarizeSecurityCounts(items);
    return {
      title: '运行配置安全',
      ...counts,
      canViewAudit: AUDIT_VIEW_ROLES.includes(membership.role),
    };
  }

  private async buildProjectDeleteImpact(projectId: string, key: string) {
    const [requirements, unitValues, projectValue] = await Promise.all([
      this.prisma.runtimeConfigRequirement.findMany({
        where: { projectId, key },
        select: {
          deployableUnitId: true,
          key: true,
          label: true,
          required: true,
          sensitive: true,
          managedByLaunchOS: true,
          defaultValue: true,
          injectionPhase: true,
        },
      }),
      this.prisma.runtimeConfigValue.findMany({
        where: { projectId, scopeType: RuntimeConfigScopeType.UNIT, key },
        select: { scopeId: true, key: true, valueEncrypted: true, isSensitive: true, updatedAt: true },
      }),
      this.prisma.runtimeConfigValue.findUnique({
        where: {
          scopeType_scopeId_key: {
            scopeType: RuntimeConfigScopeType.PROJECT,
            scopeId: projectId,
            key,
          },
        },
      }),
    ]);

    if (!projectValue) {
      throw new NotFoundException('未找到该共享配置');
    }

    const unitOverrideIds = new Set(unitValues.map((item) => item.scopeId));
    const affectedUnits: Array<{ id: string; name: string; required: boolean }> = [];
    const unitNames = await this.prisma.deployableUnit.findMany({
      where: { projectId },
      select: { id: true, name: true },
    });
    const nameById = new Map(unitNames.map((item) => [item.id, item.name]));

    for (const req of requirements) {
      if (unitOverrideIds.has(req.deployableUnitId)) {
        continue;
      }
      affectedUnits.push({
        id: req.deployableUnitId,
        name: nameById.get(req.deployableUnitId) ?? req.deployableUnitId,
        required: req.required,
      });
    }

    return {
      key,
      scopeType: RuntimeConfigScopeType.PROJECT,
      affectedUnits,
      message:
        affectedUnits.length > 0
          ? '删除后，以下组成下一次上线将无法继续：'
          : '删除后，当前没有组成直接依赖此共享配置。',
      currentInstancesKeepRunning: true,
    };
  }

  private async buildUnitDeleteImpact(projectId: string, unitId: string, key: string) {
    const unit = await this.requireUnit(projectId, unitId);
    const requirement = await this.prisma.runtimeConfigRequirement.findUnique({
      where: { deployableUnitId_key: { deployableUnitId: unitId, key } },
      select: { required: true, label: true },
    });
    const existing = await this.prisma.runtimeConfigValue.findFirst({
      where: {
        projectId,
        scopeType: RuntimeConfigScopeType.UNIT,
        scopeId: unitId,
        key,
      },
    });
    if (!existing) {
      throw new NotFoundException('未找到该配置');
    }

    return {
      key,
      scopeType: RuntimeConfigScopeType.UNIT,
      affectedUnits: [{ id: unit.id, name: unit.name, required: requirement?.required ?? false }],
      message: requirement?.required
        ? '删除后，以下组成下一次上线将无法继续：'
        : '删除后，本组成将失去此配置覆盖。',
      currentInstancesKeepRunning: true,
    };
  }

  private validateRotationInterval(value: number | null): void {
    if (value == null) {
      return;
    }
    if (!ROTATION_INTERVAL_OPTIONS.includes(value as (typeof ROTATION_INTERVAL_OPTIONS)[number])) {
      throw new BadRequestException('轮换提醒周期无效，仅支持 30、60、90、180 天或不提醒。');
    }
  }

  private encryptConfigValue(value: string): string {
    try {
      return encryptCredential(value);
    } catch {
      throw new BadRequestException('运行配置保存失败。');
    }
  }

  private async readUnitRevision(unitId: string): Promise<number> {
    const unit = await this.prisma.deployableUnit.findUnique({
      where: { id: unitId },
      select: { configRevision: true },
    });
    return unit?.configRevision ?? 0;
  }

  private async readSharedConfigRevision(projectId: string): Promise<number> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { sharedConfigRevision: true },
    });
    return project?.sharedConfigRevision ?? 0;
  }

  private async loadActorNames(userIds: string[]): Promise<Map<string, string>> {
    if (userIds.length === 0) {
      return new Map();
    }
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true },
    });
    return new Map(users.map((item) => [item.id, item.name]));
  }

  private async recordSecretAudit(input: {
    projectId: string;
    deployableUnitId: string | null;
    scopeType: RuntimeConfigScopeType;
    scopeId: string;
    key: string;
    action: SecretAuditAction;
    actorUserId: string;
    metadata?: SecretAuditMetadata;
  }): Promise<void> {
    await this.prisma.secretAuditEvent.create({
      data: {
        projectId: input.projectId,
        deployableUnitId: input.deployableUnitId,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        key: input.key,
        action: input.action,
        actorUserId: input.actorUserId,
        metadata: sanitizeAuditMetadata(input.metadata) ?? undefined,
      },
    });
  }

  private requireSecretWrite(role: WorkspaceRole): void {
    if (!SECRET_WRITE_ROLES.includes(role)) {
      throw new ForbiddenException('仅管理员可以修改敏感配置');
    }
  }
}

export function toMissingConfigUserMessage(
  missing: Array<{ key: string; label: string }>,
): string {
  const labels = missing.map((item) => item.label || item.key);
  return `上线前还需要完成 ${missing.length} 项运行配置：${labels.join('、')}`;
}

export type { DetectedRuntimeConfig };
