export type DeploymentPlanSnapshot = {
  runtime: string;
  buildCommand?: string;
  startCommand?: string;
  port?: number;
  config?: Record<string, unknown> | null;
};

export type CloudPlanName = 'Starter' | 'Standard' | 'Production';

export type CloudPlanDefinition = {
  name: CloudPlanName;
  cpu: number;
  memory: string;
  storage: string;
  database: string;
  description: string;
};

export type CloudPlanRecommendation = CloudPlanDefinition & {
  reason: string;
};
