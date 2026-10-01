import { RuntimeConfigScopeType } from '@launchos/database';
import {
  computeRotationStatus,
  formatDaysAgo,
  rotationStatusLabel,
  suggestRotationIntervalDays,
  type SecretRotationStatus,
} from '@launchos/shared';
import {
  resolveEffectiveEntry,
  type ConfigRequirementLike,
  type ConfigValueLike,
} from '@launchos/deployment';

export type ConfigValueMeta = ConfigValueLike & {
  lastRotatedAt?: Date | null;
  rotationIntervalDays?: number | null;
  updatedAt?: Date;
  updatedBy?: string | null;
  createdBy?: string | null;
  provider?: string | null;
  providerRef?: string | null;
  source?: string | null;
};

export type UnitApplyStatus = 'applied' | 'pending' | 'missing';

export function computeUnitPendingApply(input: {
  currentRevision: number;
  appliedRevision: number | null;
  hasRunningService: boolean;
}): boolean {
  const { currentRevision, appliedRevision, hasRunningService } = input;
  if (appliedRevision != null) {
    return currentRevision > appliedRevision;
  }
  return Boolean(hasRunningService && currentRevision > 0);
}

export function buildSecretMetadata(input: {
  key?: string;
  configured: boolean;
  needsRedeploy: boolean;
  valueMeta: ConfigValueMeta | null | undefined;
  now?: Date;
}) {
  const lastRotatedAt = input.valueMeta?.lastRotatedAt ?? input.valueMeta?.updatedAt ?? null;
  const rotationIntervalDays = input.valueMeta?.rotationIntervalDays ?? null;
  const rotationStatus = computeRotationStatus({
    configured: input.configured,
    needsRedeploy: input.needsRedeploy,
    lastRotatedAt,
    rotationIntervalDays,
    now: input.now,
  });
  return {
    lastRotatedAt,
    rotationIntervalDays,
    rotationStatus,
    rotationStatusLabel: rotationStatusLabel(rotationStatus),
    suggestedRotationIntervalDays: suggestRotationIntervalDays(input.key ?? ''),
    lastUpdatedAt: input.valueMeta?.updatedAt ?? null,
    lastUpdatedBy: input.valueMeta?.updatedBy ?? null,
    lastUpdatedAgo: formatDaysAgo(input.valueMeta?.updatedAt ?? null, input.now),
    lastRotatedAgo: formatDaysAgo(lastRotatedAt, input.now),
    needsRedeploy: input.needsRedeploy,
  };
}

export function resolveEffectiveValueMeta(
  requirement: ConfigRequirementLike,
  unitStored: ConfigValueMeta | undefined,
  projectStored: ConfigValueMeta | undefined,
): { source: 'UNIT' | 'PROJECT' | 'MISSING'; meta: ConfigValueMeta | null } {
  const effective = resolveEffectiveEntry(requirement, unitStored, projectStored);
  if (!effective.configured) {
    return { source: 'MISSING', meta: null };
  }
  if (effective.hasUnitOverride && unitStored) {
    return { source: 'UNIT', meta: unitStored };
  }
  if (projectStored) {
    return { source: 'PROJECT', meta: projectStored };
  }
  if (unitStored) {
    return { source: 'UNIT', meta: unitStored };
  }
  return { source: 'MISSING', meta: null };
}

export function computeUnitApplyStatus(input: {
  requirement: ConfigRequirementLike | undefined;
  unitStored: ConfigValueMeta | undefined;
  projectStored: ConfigValueMeta | undefined;
  pendingApply: boolean;
}): UnitApplyStatus {
  if (!input.requirement) {
    return 'missing';
  }
  const effective = resolveEffectiveEntry(
    input.requirement,
    input.unitStored,
    input.projectStored,
  );
  if (!effective.configured) {
    return 'missing';
  }
  return input.pendingApply ? 'pending' : 'applied';
}

export function unitApplyStatusLabel(status: UnitApplyStatus): string {
  switch (status) {
    case 'applied':
      return '已生效';
    case 'pending':
      return '等待重新上线';
    case 'missing':
      return '缺失';
    default:
      return status;
  }
}

export type SecretAuditMetadata = {
  fromScope?: RuntimeConfigScopeType;
  toScope?: RuntimeConfigScopeType;
  previousRevision?: number;
  newRevision?: number;
  /** Product-facing action for Alpha audit: SET | GENERATE | ROTATE — never includes values. */
  productAction?: 'SET' | 'GENERATE' | 'ROTATE';
  origin?: 'MANUAL' | 'LAUNCHOS_GENERATED';
};

export function sanitizeAuditMetadata(metadata: SecretAuditMetadata | undefined): SecretAuditMetadata | undefined {
  if (!metadata) {
    return undefined;
  }
  const safe: SecretAuditMetadata = {};
  if (metadata.fromScope) safe.fromScope = metadata.fromScope;
  if (metadata.toScope) safe.toScope = metadata.toScope;
  if (metadata.previousRevision != null) safe.previousRevision = metadata.previousRevision;
  if (metadata.newRevision != null) safe.newRevision = metadata.newRevision;
  if (metadata.productAction === 'SET' || metadata.productAction === 'GENERATE' || metadata.productAction === 'ROTATE') {
    safe.productAction = metadata.productAction;
  }
  if (metadata.origin === 'MANUAL' || metadata.origin === 'LAUNCHOS_GENERATED') {
    safe.origin = metadata.origin;
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

export function summarizeSecurityCounts(items: Array<{ rotationStatus: SecretRotationStatus; needsRedeploy: boolean; sensitive: boolean }>) {
  const sensitiveItems = items.filter((item) => item.sensitive);
  return {
    sensitiveTotal: sensitiveItems.length,
    appliedCount: sensitiveItems.filter((item) => item.rotationStatus === 'CURRENT').length,
    pendingRedeployCount: sensitiveItems.filter((item) => item.needsRedeploy || item.rotationStatus === 'PENDING_REDEPLOY').length,
    overdueOrDueSoonCount: sensitiveItems.filter((item) =>
      item.rotationStatus === 'OVERDUE' || item.rotationStatus === 'DUE_SOON',
    ).length,
    missingCount: sensitiveItems.filter((item) => item.rotationStatus === 'MISSING').length,
  };
}
