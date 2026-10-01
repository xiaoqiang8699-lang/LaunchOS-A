import { DeploymentStatus } from '@launchos/database';

export const DEPLOYMENT_TRANSITIONS: Record<DeploymentStatus, DeploymentStatus[]> = {
  CREATED: [DeploymentStatus.QUEUED],
  QUEUED: [DeploymentStatus.RUNNING, DeploymentStatus.CANCELLED],
  RUNNING: [DeploymentStatus.SUCCESS, DeploymentStatus.FAILED, DeploymentStatus.QUEUED],
  SUCCESS: [],
  FAILED: [DeploymentStatus.QUEUED],
  CANCELLED: [],
};

export function canTransition(from: DeploymentStatus, to: DeploymentStatus): boolean {
  return DEPLOYMENT_TRANSITIONS[from].includes(to);
}
