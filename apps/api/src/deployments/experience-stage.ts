import {
  DEPLOYMENT_STAGE_USER_LABELS,
  mapEngineStepToExecutionStage,
  type DeploymentExecutionStage,
} from '@launchos/shared';

/** Product-facing progress labels for ordinary users (no ports/container ids). */
export function experienceStageLabel(stage: string | null | undefined): string {
  const key = String(stage || '').toUpperCase() as DeploymentExecutionStage;
  if (key in DEPLOYMENT_STAGE_USER_LABELS) {
    return DEPLOYMENT_STAGE_USER_LABELS[key];
  }
  return DEPLOYMENT_STAGE_USER_LABELS[mapEngineStepToExecutionStage(String(stage || ''))];
}
