import {
  DeploymentStatus,
  HealthStatus,
  ServiceStatus,
} from '@launchos/database';

export type ApplicationStatus =
  | 'READY'
  | 'DEPLOYING'
  | 'RUNNING'
  | 'WARNING'
  | 'STOPPED'
  | 'FAILED';

export function deriveApplicationStatus(input: {
  deploymentStatus?: DeploymentStatus;
  serviceStatus?: ServiceStatus;
  healthStatus?: HealthStatus | null;
}): ApplicationStatus {
  const deploymentStatus = input.deploymentStatus;
  const serviceStatus = input.serviceStatus;
  const healthStatus = input.healthStatus ?? HealthStatus.UNKNOWN;

  if (
    deploymentStatus === DeploymentStatus.CREATED ||
    deploymentStatus === DeploymentStatus.QUEUED ||
    deploymentStatus === DeploymentStatus.RUNNING
  ) {
    return 'DEPLOYING';
  }

  if (deploymentStatus === DeploymentStatus.FAILED) {
    return 'FAILED';
  }

  if (serviceStatus === ServiceStatus.STOPPED) {
    return 'STOPPED';
  }

  if (healthStatus === HealthStatus.UNHEALTHY) {
    return 'WARNING';
  }

  if (serviceStatus === ServiceStatus.FAILED) {
    return 'FAILED';
  }

  if (serviceStatus === ServiceStatus.RUNNING) {
    return 'RUNNING';
  }

  if (deploymentStatus === DeploymentStatus.SUCCESS) {
    return 'RUNNING';
  }

  return 'READY';
}
