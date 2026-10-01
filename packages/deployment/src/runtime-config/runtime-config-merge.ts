import { createHash } from 'node:crypto';
import { RuntimeConfigInjectionPhase } from '@launchos/database';

export type RuntimeConfigPhase = 'BUILD' | 'RUNTIME';

export type ResolvedConfigSource =
  | 'MANAGED'
  | 'UNIT'
  | 'PROJECT'
  | 'DEFAULT'
  | 'MISSING';

export const MANAGED_RUNTIME_KEYS = new Set([
  'PORT',
  'NODE_ENV',
  'HOST',
  'HOSTNAME',
]);

export function isManagedConfigKey(key: string): boolean {
  return MANAGED_RUNTIME_KEYS.has(key.toUpperCase());
}

export function resolvedSourceLabel(source: ResolvedConfigSource): string {
  switch (source) {
    case 'MANAGED':
      return 'LaunchOS 自动管理';
    case 'UNIT':
      return '本组成设置';
    case 'PROJECT':
      return '应用共享';
    case 'DEFAULT':
      return '默认值';
    case 'MISSING':
      return '待配置';
  }
}

export type ConfigRequirementLike = {
  key: string;
  label?: string;
  required: boolean;
  sensitive: boolean;
  managedByLaunchOS: boolean;
  defaultValue: string | null;
  injectionPhase: RuntimeConfigInjectionPhase;
};

export type ConfigValueLike = {
  key: string;
  valueEncrypted: string;
  isSensitive: boolean;
  updatedAt?: Date;
};

export type EffectiveConfigEntry = {
  key: string;
  source: ResolvedConfigSource;
  hasUnitOverride: boolean;
  hasProjectValue: boolean;
  configured: boolean;
  valueRef: string;
};

export function phaseMatches(
  stored: RuntimeConfigInjectionPhase,
  phase: RuntimeConfigPhase,
): boolean {
  if (stored === RuntimeConfigInjectionPhase.BOTH) {
    return true;
  }
  if (phase === 'BUILD') {
    return stored === RuntimeConfigInjectionPhase.BUILD;
  }
  return stored === RuntimeConfigInjectionPhase.RUNTIME;
}

function valueFingerprintRef(value: ConfigValueLike): string {
  return createHash('sha256').update(value.valueEncrypted).digest('hex').slice(0, 16);
}

export function resolveEffectiveEntry(
  requirement: ConfigRequirementLike,
  unitValue?: ConfigValueLike,
  projectValue?: ConfigValueLike,
): EffectiveConfigEntry {
  const hasUnitOverride = Boolean(unitValue);
  const hasProjectValue = Boolean(projectValue);

  if (requirement.managedByLaunchOS || isManagedConfigKey(requirement.key)) {
    return {
      key: requirement.key,
      source: 'MANAGED',
      hasUnitOverride,
      hasProjectValue,
      configured: true,
      valueRef: `managed:${requirement.key}`,
    };
  }

  if (unitValue) {
    return {
      key: requirement.key,
      source: 'UNIT',
      hasUnitOverride: true,
      hasProjectValue,
      configured: true,
      valueRef: `unit:${valueFingerprintRef(unitValue)}`,
    };
  }

  if (projectValue) {
    return {
      key: requirement.key,
      source: 'PROJECT',
      hasUnitOverride: false,
      hasProjectValue: true,
      configured: true,
      valueRef: `project:${valueFingerprintRef(projectValue)}`,
    };
  }

  if (requirement.defaultValue && !requirement.sensitive) {
    return {
      key: requirement.key,
      source: 'DEFAULT',
      hasUnitOverride: false,
      hasProjectValue: false,
      configured: true,
      valueRef: `default:${requirement.defaultValue}`,
    };
  }

  return {
    key: requirement.key,
    source: 'MISSING',
    hasUnitOverride: false,
    hasProjectValue,
    configured: false,
    valueRef: 'missing',
  };
}

export function buildUnitEffectiveFingerprintParts(input: {
  requirements: ConfigRequirementLike[];
  unitValues: Map<string, ConfigValueLike>;
  projectValues: Map<string, ConfigValueLike>;
  configRevision: number;
  containerPort?: number;
}): string[] {
  const parts: string[] = [`rev:${input.configRevision}`];
  const sorted = [...input.requirements].sort((a, b) => a.key.localeCompare(b.key));

  for (const req of sorted) {
    const effective = resolveEffectiveEntry(
      req,
      input.unitValues.get(req.key),
      input.projectValues.get(req.key),
    );
    parts.push(
      `${req.key}:${effective.source}:${effective.valueRef}:${req.injectionPhase}`,
    );
  }

  const internalPort =
    input.containerPort && input.containerPort > 0 ? input.containerPort : 3000;
  parts.push(`managed:PORT=${internalPort}`);
  parts.push('managed:NODE_ENV=production');
  parts.push('managed:HOST=0.0.0.0');
  parts.push('managed:HOSTNAME=0.0.0.0');

  return parts;
}

export function fingerprintFromParts(parts: string[]): string {
  return createHash('sha256')
    .update([...parts].sort().join('|'))
    .digest('hex')
    .slice(0, 32);
}

export function buildUnitEffectiveFingerprint(input: {
  requirements: ConfigRequirementLike[];
  unitValues: Map<string, ConfigValueLike>;
  projectValues: Map<string, ConfigValueLike>;
  configRevision: number;
  containerPort?: number;
}): string {
  return fingerprintFromParts(buildUnitEffectiveFingerprintParts(input));
}

export function shouldBumpUnitRevision(input: {
  requirements: ConfigRequirementLike[];
  unitValues: Map<string, ConfigValueLike>;
  projectValuesBefore: Map<string, ConfigValueLike>;
  projectValuesAfter: Map<string, ConfigValueLike>;
  configRevision: number;
  containerPort?: number;
}): boolean {
  const before = buildUnitEffectiveFingerprint({
    requirements: input.requirements,
    unitValues: input.unitValues,
    projectValues: input.projectValuesBefore,
    configRevision: input.configRevision,
    containerPort: input.containerPort,
  });
  const after = buildUnitEffectiveFingerprint({
    requirements: input.requirements,
    unitValues: input.unitValues,
    projectValues: input.projectValuesAfter,
    configRevision: input.configRevision,
    containerPort: input.containerPort,
  });
  return before !== after;
}

export function collectUnitsAffectedByProjectKeyChange(input: {
  changedKey: string;
  units: Array<{
    id: string;
    configRevision: number;
    port: number | null;
    requirements: ConfigRequirementLike[];
    unitValues: Map<string, ConfigValueLike>;
  }>;
  projectValuesBefore: Map<string, ConfigValueLike>;
  projectValuesAfter: Map<string, ConfigValueLike>;
}): string[] {
  const affected: string[] = [];
  for (const unit of input.units) {
    const hasRequirement = unit.requirements.some((item) => item.key === input.changedKey);
    if (!hasRequirement) {
      continue;
    }
    if (unit.unitValues.has(input.changedKey)) {
      continue;
    }
    if (
      shouldBumpUnitRevision({
        requirements: unit.requirements,
        unitValues: unit.unitValues,
        projectValuesBefore: input.projectValuesBefore,
        projectValuesAfter: input.projectValuesAfter,
        configRevision: unit.configRevision,
        containerPort: unit.port ?? undefined,
      })
    ) {
      affected.push(unit.id);
    }
  }
  return affected;
}
