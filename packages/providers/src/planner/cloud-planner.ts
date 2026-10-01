import { MOCK_CLOUD_PLANS } from './plans';
import type {
  CloudPlanDefinition,
  CloudPlanName,
  CloudPlanRecommendation,
  DeploymentPlanSnapshot,
} from './types';

export class CloudPlanner {
  recommendPlan(plan: DeploymentPlanSnapshot): CloudPlanRecommendation {
    const name = this.selectPlanName(plan);
    const definition = MOCK_CLOUD_PLANS.find((item) => item.name === name);
    if (!definition) {
      throw new Error(`Unknown cloud plan: ${name}`);
    }
    return {
      ...definition,
      reason: this.buildReason(plan, definition),
    };
  }

  private selectPlanName(plan: DeploymentPlanSnapshot): CloudPlanName {
    const signals = collectSignals(plan);

    if (signals.complexity === 'complex' || signals.hasCacheOrQueue) {
      return 'Production';
    }
    if (signals.complexity === 'database' || signals.hasDatabase) {
      return 'Standard';
    }
    return 'Starter';
  }

  private buildReason(plan: DeploymentPlanSnapshot, definition: CloudPlanDefinition): string {
    const runtime = plan.runtime || 'unknown';
    if (definition.name === 'Production') {
      return `DeploymentPlan runtime ${runtime} looks complex (database plus cache/queue). Recommend Production: ${definition.cpu} CPU / ${definition.memory} with ${definition.database}.`;
    }
    if (definition.name === 'Standard') {
      return `DeploymentPlan indicates a database-backed service on ${runtime}. Recommend Standard: ${definition.cpu} CPU / ${definition.memory} with ${definition.database}.`;
    }
    return `DeploymentPlan is a simple Node.js workload (${runtime}) without a database. Recommend Starter: ${definition.cpu} CPU / ${definition.memory}, database ${definition.database}.`;
  }
}

type PlanSignals = {
  complexity: string;
  hasDatabase: boolean;
  hasCacheOrQueue: boolean;
};

function collectSignals(plan: DeploymentPlanSnapshot): PlanSignals {
  const config = isRecord(plan.config) ? plan.config : {};
  const complexity = stringify(config.complexity).toLowerCase();
  const database = stringify(config.database).toLowerCase();
  const findings = Array.isArray(config.findings)
    ? config.findings.map((item) => stringify(item)).join(' ')
    : stringify(config.findings);
  const blob = [plan.runtime, plan.buildCommand, plan.startCommand, findings, complexity, database]
    .join(' ')
    .toLowerCase();

  const hasDatabase =
    (database.length > 0 && database !== 'none') ||
    blob.includes('postgres') ||
    blob.includes('mysql') ||
    blob.includes('mongodb') ||
    blob.includes('database_url');

  const hasCacheOrQueue =
    blob.includes('redis') ||
    blob.includes('kafka') ||
    blob.includes('rabbitmq') ||
    blob.includes('worker') ||
    blob.includes('microservice');

  return { complexity, hasDatabase, hasCacheOrQueue };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringify(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}
