/**
 * Beta M4 — single entry for deployment runtime env resolution + unit isolation.
 * All managed deploy paths should use this rather than ad-hoc filter calls.
 */
import {
  filterRuntimeEnvForUnitType,
  verifyRuntimeConfigPresence,
} from '@launchos/shared';
import type { RuntimeConfigResolver, ResolvedRuntimeConfig } from './runtime-config-resolver';

export type ResolveRuntimeConfigForDeploymentInput = {
  projectId: string;
  deployableUnitId: string;
  unitType?: string | null;
  containerPort?: number;
  phase?: 'BUILD' | 'RUNTIME';
};

export type ResolvedDeploymentRuntimeConfig = ResolvedRuntimeConfig & {
  strippedKeys: string[];
  allowedRuntimeKeys: string[];
  blockedBackendSecretKeys: string[];
  webSecretIsolation: boolean;
  /** Keys that must be present in the container after injection. */
  expectedInjectedKeys: string[];
};

export async function resolveRuntimeConfigForDeployment(
  resolver: RuntimeConfigResolver,
  input: ResolveRuntimeConfigForDeploymentInput,
): Promise<ResolvedDeploymentRuntimeConfig> {
  const phase = input.phase ?? 'RUNTIME';
  const resolved = await resolver.resolve({
    projectId: input.projectId,
    deployableUnitId: input.deployableUnitId,
    phase,
    containerPort: input.containerPort,
  });

  if (phase === 'BUILD') {
    const buildEnv = Object.fromEntries(
      Object.entries(resolved.env).filter(
        ([k]) =>
          /^(NEXT_PUBLIC_|VITE_)/.test(k) &&
          !/SECRET|PASSWORD|PRIVATE_KEY|TOKEN|DATABASE_URL|REDIS_URL/i.test(k),
      ),
    );
    const keys = Object.keys(buildEnv).sort();
    return {
      ...resolved,
      env: buildEnv,
      keys,
      strippedKeys: Object.keys(resolved.env).filter((k) => !(k in buildEnv)),
      allowedRuntimeKeys: keys,
      blockedBackendSecretKeys: [],
      webSecretIsolation: true,
      expectedInjectedKeys: keys,
    };
  }

  const filtered = filterRuntimeEnvForUnitType(input.unitType, resolved.env);
  return {
    ...resolved,
    env: filtered.env,
    keys: filtered.allowedRuntimeKeys,
    strippedKeys: filtered.strippedKeys,
    allowedRuntimeKeys: filtered.allowedRuntimeKeys,
    blockedBackendSecretKeys: filtered.blockedBackendSecretKeys,
    webSecretIsolation: filtered.webSecretIsolation,
    expectedInjectedKeys: filtered.allowedRuntimeKeys,
  };
}

export { verifyRuntimeConfigPresence };
