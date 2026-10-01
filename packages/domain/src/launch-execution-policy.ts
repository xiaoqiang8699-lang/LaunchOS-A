/**
 * Step 30 Phase 1 — per-step execution policy (handler metadata only; no cloud writes).
 */

import type { LaunchStageId } from './launch-stages.js';

export const LAUNCH_STEP_TYPES = [
  'ANALYZE_PROJECT',
  'PLAN_DEPENDENCIES',
  'PROVISION_POSTGRESQL',
  'CONNECT_POSTGRESQL',
  'PROVISION_REDIS',
  'CONNECT_REDIS',
  'PLAN_SERVER',
  'PROVISION_SERVER',
  'INITIALIZE_SERVER',
  'BUILD_UNIT',
  'BUILD_DOCKER_IMAGE',
  'DEPLOY_API',
  'DEPLOY_WEB',
  'INSTALL_GATEWAY',
  'INSTALL_CERTIFICATE',
  'APPLY_API_ROUTE',
  'APPLY_WEB_ROUTE',
  'APPLY_API_DNS',
  'APPLY_WEB_DNS',
  'VERIFY_API_HTTPS',
  'VERIFY_WEB_HTTPS',
  'FINAL_ACCEPTANCE',
] as const;

export type LaunchStepType = (typeof LAUNCH_STEP_TYPES)[number];

export type LaunchRetryClass = 'RETRYABLE' | 'USER_ACTION_REQUIRED' | 'TERMINAL';

export type LaunchStepExecutionPolicy = {
  stepType: LaunchStepType;
  stage: LaunchStageId;
  handler: string;
  billable: boolean;
  requiresConfirmation: boolean;
  requiresAuthorizedProvider: boolean;
  destructive: boolean;
  maxAttempts: number;
  /** Phase 1: all handlers are plan-only stubs. */
  phase1Locked: boolean;
};

const base = (
  stepType: LaunchStepType,
  stage: LaunchStageId,
  overrides: Partial<LaunchStepExecutionPolicy> = {},
): LaunchStepExecutionPolicy => ({
  stepType,
  stage,
  handler: `launch.${stepType.toLowerCase()}`,
  billable: false,
  requiresConfirmation: false,
  requiresAuthorizedProvider: false,
  destructive: false,
  maxAttempts: 3,
  phase1Locked: true,
  ...overrides,
});

export const LAUNCH_STEP_POLICIES: Record<LaunchStepType, LaunchStepExecutionPolicy> = {
  ANALYZE_PROJECT: base('ANALYZE_PROJECT', 'ANALYZE'),
  PLAN_DEPENDENCIES: base('PLAN_DEPENDENCIES', 'DEPENDENCIES'),
  PROVISION_POSTGRESQL: base('PROVISION_POSTGRESQL', 'DEPENDENCIES', {
    billable: true,
    requiresConfirmation: true,
    requiresAuthorizedProvider: true,
    maxAttempts: 2,
  }),
  CONNECT_POSTGRESQL: base('CONNECT_POSTGRESQL', 'DEPENDENCIES'),
  PROVISION_REDIS: base('PROVISION_REDIS', 'DEPENDENCIES', {
    billable: true,
    requiresConfirmation: true,
    requiresAuthorizedProvider: true,
    maxAttempts: 2,
  }),
  CONNECT_REDIS: base('CONNECT_REDIS', 'DEPENDENCIES'),
  PLAN_SERVER: base('PLAN_SERVER', 'INFRASTRUCTURE'),
  PROVISION_SERVER: base('PROVISION_SERVER', 'INFRASTRUCTURE', {
    billable: true,
    requiresConfirmation: true,
    requiresAuthorizedProvider: true,
    maxAttempts: 2,
  }),
  INITIALIZE_SERVER: base('INITIALIZE_SERVER', 'INFRASTRUCTURE', {
    requiresAuthorizedProvider: false,
    maxAttempts: 3,
  }),
  BUILD_UNIT: base('BUILD_UNIT', 'BUILD'),
  BUILD_DOCKER_IMAGE: base('BUILD_DOCKER_IMAGE', 'BUILD'),
  DEPLOY_API: base('DEPLOY_API', 'DEPLOY'),
  DEPLOY_WEB: base('DEPLOY_WEB', 'DEPLOY'),
  INSTALL_GATEWAY: base('INSTALL_GATEWAY', 'PUBLIC_ENTRY'),
  INSTALL_CERTIFICATE: base('INSTALL_CERTIFICATE', 'PUBLIC_ENTRY', {
    requiresAuthorizedProvider: true,
  }),
  APPLY_API_ROUTE: base('APPLY_API_ROUTE', 'PUBLIC_ENTRY'),
  APPLY_WEB_ROUTE: base('APPLY_WEB_ROUTE', 'PUBLIC_ENTRY'),
  APPLY_API_DNS: base('APPLY_API_DNS', 'PUBLIC_ENTRY', {
    requiresAuthorizedProvider: true,
  }),
  APPLY_WEB_DNS: base('APPLY_WEB_DNS', 'PUBLIC_ENTRY', {
    requiresAuthorizedProvider: true,
  }),
  VERIFY_API_HTTPS: base('VERIFY_API_HTTPS', 'VERIFY'),
  VERIFY_WEB_HTTPS: base('VERIFY_WEB_HTTPS', 'VERIFY'),
  FINAL_ACCEPTANCE: base('FINAL_ACCEPTANCE', 'VERIFY'),
};

export function getLaunchStepPolicy(stepType: string): LaunchStepExecutionPolicy | null {
  if ((LAUNCH_STEP_TYPES as readonly string[]).includes(stepType)) {
    return LAUNCH_STEP_POLICIES[stepType as LaunchStepType];
  }
  return null;
}

/** Classify failure for retry / resume UX. Never auto-modifies user source. */
export function classifyLaunchFailure(errorCode: string | null | undefined): LaunchRetryClass {
  const code = (errorCode ?? '').toUpperCase();
  if (
    code.includes('TIMEOUT') ||
    code.includes('NETWORK') ||
    code.includes('UNREACHABLE') ||
    code.includes('TEMPORARY') ||
    code.includes('RATE_LIMIT')
  ) {
    return 'RETRYABLE';
  }
  if (
    code.includes('NOT_ENOUGH_BALANCE') ||
    code.includes('SECRET_MISSING') ||
    code.includes('INVALID_USER_CODE') ||
    code.includes('BUILD_FAIL') ||
    code.includes('START_COMMAND') ||
    code.includes('RUNTIME_CRASH') ||
    code.includes('USER_ACTION') ||
    code.includes('QUOTA')
  ) {
    return 'USER_ACTION_REQUIRED';
  }
  if (
    code.includes('IMAGE_ARCH_MISMATCH') ||
    code.includes('UNSUPPORTED') ||
    code.includes('TERMINAL') ||
    code.includes('INVALID_CONFIG')
  ) {
    return 'TERMINAL';
  }
  return 'RETRYABLE';
}

export function launchOperationKey(launchRunId: string, stepType: string, reconcileKey = 'default'): string {
  return `launch:${launchRunId}:${stepType}:${reconcileKey}`;
}

export function launchProjectLockKey(projectId: string, environmentId: string): string {
  return `launch:${projectId}:${environmentId}`;
}

export const ACTIVE_LAUNCH_RUN_STATUSES = [
  'PLANNING',
  'READY',
  'RUNNING',
  'WAITING_CONFIRMATION',
  'VERIFYING',
] as const;

export const STEP30_REAL_EXECUTION_LOCKED = 'STEP30_REAL_EXECUTION_LOCKED';
export const STEP30_PHASE2_REAL_EXECUTION_LOCKED = 'STEP30_PHASE2_REAL_EXECUTION_LOCKED';
export const STEP30_PLAN_STALE = 'PLAN_STALE';
export const STEP30_CONFIRMATION_STALE = 'CONFIRMATION_STALE';
export const STEP30_BILLABLE_CONFIRMATION_REQUIRED = 'BILLABLE_ACTION_CONFIRMATION_REQUIRED';
export const STEP30_PHASE1_WRITE_COMMANDS = false;
export const STEP30_PHASE2_WRITE_COMMANDS = false;
