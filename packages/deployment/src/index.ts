export { DeploymentEngineError, DeploymentEngineService } from './engine/deployment-engine.service';
export { DomainService, DomainServiceError } from './domains/domain.service';
export { DEPLOYMENT_STEPS, type DeploymentStepDefinition, type DeploymentStepKey } from './steps/definitions';
export { canTransition, DEPLOYMENT_TRANSITIONS } from './state-machine/transitions';
export {
  RuntimeConfigResolver,
  type ResolvedRuntimeConfig,
  type ResolveRuntimeConfigInput,
  type RuntimeConfigPhase,
} from './runtime-config/runtime-config-resolver';
export {
  resolveRuntimeConfigForDeployment,
  verifyRuntimeConfigPresence,
  type ResolveRuntimeConfigForDeploymentInput,
  type ResolvedDeploymentRuntimeConfig,
} from './runtime-config/resolve-runtime-config-for-deployment';
export {
  MANAGED_RUNTIME_KEYS,
  buildUnitEffectiveFingerprint,
  collectUnitsAffectedByProjectKeyChange,
  isManagedConfigKey,
  phaseMatches,
  resolveEffectiveEntry,
  resolvedSourceLabel,
  type ConfigRequirementLike,
  type ConfigValueLike,
  type EffectiveConfigEntry,
  type ResolvedConfigSource,
} from './runtime-config/runtime-config-merge';
export {
  HOST_PORT_RANGE_END,
  HOST_PORT_RANGE_START,
  allocateHostPort,
  hostPortCandidates,
  listDbReservedHostPorts,
  toUserFacingRuntimeError,
} from './remote/host-port-allocator';
export {
  reconcileRemoteRuntimes,
  type RuntimeReconcileReport,
} from './remote/runtime-reconcile';
