/**
 * Step 30 Phase 2 — LaunchStepHandler interface.
 * Orchestration layer only; handlers wrap Step 25–29 capabilities (no second implementation).
 */

import type { LaunchRetryClass, LaunchStepType } from './launch-execution-policy.js';

export type LaunchHandlerStatus =
  | 'SUCCESS'
  | 'REUSED'
  | 'SKIPPED'
  | 'WAITING'
  | 'FAILED'
  | 'RECONCILING'
  | 'STILL_RUNNING'
  | 'UNKNOWN'
  | 'BLOCKED'
  | 'LOCKED';

export type LaunchWriteClass =
  | 'none'
  | 'cloud'
  | 'deployment'
  | 'gateway'
  | 'dns'
  | 'certificate'
  | 'remote';

export type LaunchHandlerResult = {
  status: LaunchHandlerStatus;
  resourceType: string | null;
  resourceId: string | null;
  observedState: Record<string, unknown>;
  retryClass: LaunchRetryClass | null;
  failureCode: string | null;
  failureMessage: string | null;
  userMessage: string | null;
  /** Non-secret technical details for /details. */
  technicalDetailsSafe: Record<string, unknown>;
  writeClass: LaunchWriteClass;
  /** True if this call would have mutated external systems. */
  wouldWrite: boolean;
};

export type LaunchStepHandlerContext = {
  launchRunId: string;
  launchRunStepId: string;
  projectId: string;
  environmentId: string;
  stepType: LaunchStepType;
  decision: 'EXECUTE' | 'REUSE' | 'SKIP' | 'BLOCK';
  reconcileKey: string;
  resourceType: string | null;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  /** Gate-only / Phase 2 lock: never perform provider writes. */
  gateOnly: boolean;
  realExecutionLocked: boolean;
  confirmationSatisfied: boolean;
  observedFacts?: Record<string, unknown>;
  declaredState?: Record<string, unknown>;
};

export interface LaunchStepHandler {
  stepType: LaunchStepType;
  /** Existing capability this handler wraps (documentation / audit). */
  wraps: string;
  writeClass: LaunchWriteClass;
  billable: boolean;
  requiresConfirmation: boolean;
  /** Bottom-layer lock keys required (in addition to launch-step lock). */
  bottomLocks: string[];
  preflight(context: LaunchStepHandlerContext): Promise<LaunchHandlerResult> | LaunchHandlerResult;
  execute(context: LaunchStepHandlerContext): Promise<LaunchHandlerResult> | LaunchHandlerResult;
  reconcile(context: LaunchStepHandlerContext): Promise<LaunchHandlerResult> | LaunchHandlerResult;
  verify(context: LaunchStepHandlerContext): Promise<LaunchHandlerResult> | LaunchHandlerResult;
  rollback?(context: LaunchStepHandlerContext): Promise<LaunchHandlerResult> | LaunchHandlerResult;
}

export function okHandlerResult(
  partial: Partial<LaunchHandlerResult> & Pick<LaunchHandlerResult, 'status'>,
): LaunchHandlerResult {
  return {
    resourceType: null,
    resourceId: null,
    observedState: {},
    retryClass: null,
    failureCode: null,
    failureMessage: null,
    userMessage: null,
    technicalDetailsSafe: {},
    writeClass: 'none',
    wouldWrite: false,
    ...partial,
  };
}

export function launchStepLockKey(launchRunId: string, launchRunStepId: string): string {
  return `launch-step:${launchRunId}:${launchRunStepId}`;
}
