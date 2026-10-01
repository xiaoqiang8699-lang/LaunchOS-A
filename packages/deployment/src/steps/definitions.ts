export type DeploymentStepKey =
  | 'VALIDATE_SOURCE'
  | 'BUILD_APPLICATION'
  | 'STORE_ARTIFACT'
  | 'DEPLOY_APPLICATION'
  | 'REMOTE_DEPLOY'
  | 'HEALTH_CHECK';

export type DeploymentStepDefinition = {
  stepKey: DeploymentStepKey;
  name: string;
  delayMs: number;
};

export const DEPLOYMENT_STEPS: readonly DeploymentStepDefinition[] = [
  { stepKey: 'VALIDATE_SOURCE', name: 'Validate Source', delayMs: 2000 },
  { stepKey: 'BUILD_APPLICATION', name: 'Build Application', delayMs: 3000 },
  { stepKey: 'STORE_ARTIFACT', name: 'Store Artifact', delayMs: 1000 },
  { stepKey: 'DEPLOY_APPLICATION', name: 'Deploy Application', delayMs: 3000 },
  { stepKey: 'REMOTE_DEPLOY', name: 'Remote Deploy', delayMs: 1000 },
  { stepKey: 'HEALTH_CHECK', name: 'Health Check', delayMs: 2000 },
];
