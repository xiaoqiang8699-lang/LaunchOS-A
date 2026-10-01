/**
 * Step 30 Phase 2 — LaunchRun executor wiring + gate-only evaluation.
 * Does not invoke provider/DNS/gateway/deploy writes while realExecutionLocked.
 */

import {
  STEP30_PHASE2_REAL_EXECUTION_LOCKED,
  STEP30_PHASE2_WRITE_COMMANDS,
  STEP30_PLAN_STALE,
  getLaunchStepPolicy,
  launchOperationKey,
  launchProjectLockKey,
} from './launch-execution-policy.js';
import {
  buildConfirmationPayload,
  hashConfirmationPayload,
  validateConfirmation,
  type LaunchConfirmationPayload,
  type LaunchConfirmationRecord,
} from './launch-confirmation.js';
import { detectPlanStale } from './launch-orchestrator.js';
import type { LaunchPlanResult } from './launch-orchestrator.js';
import { defaultLaunchHandlerRegistry } from './launch-handler-registry.js';
import { launchStepLockKey, type LaunchHandlerResult } from './launch-handler.js';
import { scheduleReadySteps, selectParallelBatch } from './launch-scheduler.js';
import { classifyLaunchWrites, type LaunchWritePlan } from './launch-write-plan.js';
import { detectLaunchDrift, type LaunchDriftReport } from './launch-drift.js';
import { computeLaunchProgress } from './launch-progress.js';
import { assertLaunchEventSafe } from './launch-orchestrator.js';
import { launchErrorUserMessage } from './launch-user-messages.js';

export const LAUNCH_EXECUTION_AUDIT_EVENTS = [
  'LAUNCH_EXECUTION_STARTED',
  'LAUNCH_STEP_PREFLIGHT',
  'LAUNCH_STEP_REUSED',
  'LAUNCH_STEP_EXECUTION_STARTED',
  'LAUNCH_STEP_RECONCILING',
  'LAUNCH_STEP_SUCCESS',
  'LAUNCH_STEP_FAILED',
  'LAUNCH_WAITING_USER',
  'LAUNCH_VERIFYING',
  'LAUNCH_SUCCESS',
] as const;

export type GateStepReport = {
  stage: string;
  stepType: string;
  decision: string;
  status: string;
  handlerResolved: boolean;
  wraps: string | null;
  preflightPassed: boolean;
  requiresConfirmation: boolean;
  confirmationSatisfied: boolean;
  billable: boolean;
  writeCapable: boolean;
  writeClass: string;
  wouldExecute: boolean;
  wouldReuse: boolean;
  wouldSkip: boolean;
  wouldBlock: boolean;
  resourceId: string | null;
  operationKey: string;
  stepLockKey: string;
  bottomLocks: string[];
  preflight: LaunchHandlerResult | null;
};

export type LaunchGateResult = {
  launchRunId: string;
  projectId: string;
  environmentId: string;
  planVersion: string;
  planStale: boolean;
  staleReasons: string[];
  confirmationSatisfied: boolean;
  confirmationCode: string | null;
  requiresConfirmation: boolean;
  confirmedPlanHash: string | null;
  expectedPlanHash: string | null;
  steps: GateStepReport[];
  writePlan: LaunchWritePlan;
  canExecute: boolean;
  blockers: Array<{ code: string; messageZh: string }>;
  realExecutionLocked: boolean;
  gateOnly: boolean;
  lockKey: string;
  progressPercent: number;
  currentDesiredStateSatisfied: boolean;
  drift: LaunchDriftReport | null;
  executionSteps: string[];
  reuseSteps: string[];
  skipSteps: string[];
  WRITE_COMMANDS_EXECUTED_THIS_RUN: false;
  oldServerUntouched: true;
};

export type LaunchExecutorStepInput = {
  id: string;
  stage: string;
  stepType: string;
  status: string;
  decision: 'EXECUTE' | 'REUSE' | 'SKIP' | 'BLOCK';
  dependsOn: string[];
  reconcileKey: string;
  resourceType: string | null;
  resourceId: string | null;
  metadata?: Record<string, unknown>;
};

export type EvaluateLaunchGateInput = {
  launchRunId: string;
  projectId: string;
  environmentId: string;
  planVersion: string;
  plan: Pick<
    LaunchPlanResult,
    | 'billableActions'
    | 'resourcesToCreate'
    | 'requiresConfirmation'
    | 'executionSteps'
    | 'reuseSteps'
    | 'skipSteps'
    | 'currentDesiredStateSatisfied'
    | 'inputSnapshot'
  >;
  steps: LaunchExecutorStepInput[];
  /** Current world snapshot for stale check (same shape as inputSnapshot keys). */
  currentInputSnapshot: Record<string, unknown>;
  confirmation?: LaunchConfirmationRecord | null;
  provider?: string | null;
  gateOnly?: boolean;
  realExecutionLocked?: boolean;
  driftInput?: Parameters<typeof detectLaunchDrift>[0] | null;
};

export function evaluateLaunchGate(input: EvaluateLaunchGateInput): LaunchGateResult {
  const gateOnly = input.gateOnly !== false;
  const realExecutionLocked = input.realExecutionLocked !== false;

  const stale = detectPlanStale(input.plan.inputSnapshot, input.currentInputSnapshot);

  const confirmPayload: LaunchConfirmationPayload = buildConfirmationPayload({
    planVersion: input.planVersion,
    projectId: input.projectId,
    environmentId: input.environmentId,
    provider: input.provider,
    billableActions: input.plan.billableActions,
    resourcesToCreate: input.plan.resourcesToCreate,
  });
  const expectedPlanHash = hashConfirmationPayload(confirmPayload);
  const confirmCheck = validateConfirmation({
    record: input.confirmation ?? null,
    currentPayload: confirmPayload,
    requiresConfirmation: input.plan.requiresConfirmation,
  });

  const scheduled = scheduleReadySteps(
    input.steps.map((s) => ({
      id: s.id,
      stepType: s.stepType,
      status: s.status,
      decision: s.decision,
      dependsOn: s.dependsOn,
      reconcileKey: s.reconcileKey,
    })),
  );
  const statusById = new Map(scheduled.map((s) => [s.id, s.status]));

  const reports: GateStepReport[] = [];
  for (const step of input.steps) {
    const handler = defaultLaunchHandlerRegistry.get(step.stepType);
    const policy = getLaunchStepPolicy(step.stepType);
    const scheduledStatus = statusById.get(step.id) ?? step.status;
    const ctx = {
      launchRunId: input.launchRunId,
      launchRunStepId: step.id,
      projectId: input.projectId,
      environmentId: input.environmentId,
      stepType: step.stepType as never,
      decision: step.decision,
      reconcileKey: step.reconcileKey,
      resourceType: step.resourceType,
      resourceId: step.resourceId,
      metadata: step.metadata ?? {},
      gateOnly,
      realExecutionLocked,
      confirmationSatisfied: confirmCheck.confirmationSatisfied,
      observedFacts: {
        desiredStateSatisfied: input.plan.currentDesiredStateSatisfied,
        httpsValid: true,
      },
    };

    let preflight: LaunchHandlerResult | null = null;
    let preflightPassed = false;
    if (handler) {
      const result = handler.preflight(ctx);
      preflight = result instanceof Promise ? null : result;
      // sync handlers only in registry
      if (!(result instanceof Promise)) {
        preflight = result;
        preflightPassed =
          result.status === 'SUCCESS' ||
          result.status === 'REUSED' ||
          result.status === 'SKIPPED' ||
          (result.status === 'WAITING' && step.decision === 'EXECUTE' && !!policy?.requiresConfirmation);
        // WAITING confirmation is expected for billable — preflight "passed" as gated
        if (result.status === 'WAITING' && policy?.requiresConfirmation) {
          preflightPassed = true;
        }
      }
    }

    reports.push({
      stage: step.stage,
      stepType: step.stepType,
      decision: step.decision,
      status: scheduledStatus,
      handlerResolved: Boolean(handler),
      wraps: handler?.wraps ?? null,
      preflightPassed,
      requiresConfirmation: Boolean(policy?.requiresConfirmation && step.decision === 'EXECUTE'),
      confirmationSatisfied: confirmCheck.confirmationSatisfied,
      billable: Boolean(policy?.billable && step.decision === 'EXECUTE'),
      writeCapable: Boolean(handler && handler.writeClass !== 'none' && step.decision === 'EXECUTE'),
      writeClass: handler?.writeClass ?? 'none',
      wouldExecute: step.decision === 'EXECUTE',
      wouldReuse: step.decision === 'REUSE',
      wouldSkip: step.decision === 'SKIP',
      wouldBlock: step.decision === 'BLOCK' || scheduledStatus === 'BLOCKED',
      resourceId: step.resourceId,
      operationKey: launchOperationKey(input.launchRunId, step.stepType, step.reconcileKey),
      stepLockKey: launchStepLockKey(input.launchRunId, step.id),
      bottomLocks: handler?.bottomLocks ?? [],
      preflight,
    });
  }

  const writePlan = classifyLaunchWrites(
    input.steps.map((s) => ({ stepType: s.stepType, decision: s.decision })),
  );

  const blockers: Array<{ code: string; messageZh: string }> = [];
  if (stale.stale) {
    blockers.push({
      code: STEP30_PLAN_STALE,
      messageZh: '上线计划已过期，请重新生成计划',
    });
  }
  if (!confirmCheck.ok) {
    blockers.push({
      code: confirmCheck.code ?? 'BILLABLE_ACTION_CONFIRMATION_REQUIRED',
      messageZh: confirmCheck.messageZh,
    });
  }
  if (!reports.every((r) => r.handlerResolved)) {
    blockers.push({
      code: 'HANDLER_MISSING',
      messageZh: '部分步骤尚未接入执行器',
    });
  }

  const drift = input.driftInput ? detectLaunchDrift(input.driftInput) : null;

  // Demo verify-only: canExecute when no billable pending and plan fresh
  const canExecute =
    !stale.stale &&
    confirmCheck.ok &&
    reports.every((r) => r.handlerResolved) &&
    (confirmCheck.confirmationSatisfied || !input.plan.requiresConfirmation);

  const progress = computeLaunchProgress(
    input.steps.map((s) => ({
      stage: s.stage as never,
      decision: s.decision,
      status:
        s.decision === 'REUSE' || s.decision === 'SKIP'
          ? 'SUCCESS'
          : statusById.get(s.id) ?? s.status,
    })),
  );

  return {
    launchRunId: input.launchRunId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    planVersion: input.planVersion,
    planStale: stale.stale,
    staleReasons: stale.reasons,
    confirmationSatisfied: confirmCheck.confirmationSatisfied,
    confirmationCode: confirmCheck.code,
    requiresConfirmation: input.plan.requiresConfirmation,
    confirmedPlanHash: input.confirmation?.confirmedPlanHash ?? null,
    expectedPlanHash,
    steps: reports,
    writePlan,
    canExecute,
    blockers,
    realExecutionLocked,
    gateOnly,
    lockKey: launchProjectLockKey(input.projectId, input.environmentId),
    progressPercent: progress.progressPercent,
    currentDesiredStateSatisfied: input.plan.currentDesiredStateSatisfied,
    drift,
    executionSteps: input.plan.executionSteps,
    reuseSteps: input.plan.reuseSteps,
    skipSteps: input.plan.skipSteps,
    WRITE_COMMANDS_EXECUTED_THIS_RUN: STEP30_PHASE2_WRITE_COMMANDS,
    oldServerUntouched: true,
  };
}

/**
 * Phase 2 execute entry — always locked unless explicitly unlocked in Phase 3+.
 * Gate-only path returns evaluateLaunchGate without invoking write handlers.
 */
export function executeLaunchRunGateOnly(input: EvaluateLaunchGateInput): LaunchGateResult {
  const result = evaluateLaunchGate({ ...input, gateOnly: true, realExecutionLocked: true });
  assertLaunchEventSafe({
    event: 'LAUNCH_EXECUTION_STARTED',
    launchRunId: input.launchRunId,
    projectId: input.projectId,
    gateOnly: true,
  });
  return {
    ...result,
    realExecutionLocked: true,
    WRITE_COMMANDS_EXECUTED_THIS_RUN: false,
  };
}

export function refuseRealExecution(): {
  code: typeof STEP30_PHASE2_REAL_EXECUTION_LOCKED;
  messageZh: string;
  WRITE_COMMANDS_EXECUTED_THIS_RUN: false;
} {
  return {
    code: STEP30_PHASE2_REAL_EXECUTION_LOCKED,
    messageZh: launchErrorUserMessage(STEP30_PHASE2_REAL_EXECUTION_LOCKED),
    WRITE_COMMANDS_EXECUTED_THIS_RUN: false,
  };
}

export type CancelPolicyResult = {
  allowed: boolean;
  status: 'CANCELLED' | 'CANCELLATION_PENDING_RECONCILE' | 'REJECTED';
  messageZh: string;
};

export function evaluateCancelPolicy(input: {
  runStatus: string;
  steps: Array<{ status: string; billable?: boolean; writeClass?: string }>;
}): CancelPolicyResult {
  const inFlightBillable = input.steps.some(
    (s) =>
      (s.status === 'RUNNING' || s.status === 'RECONCILING') &&
      (s.billable || s.writeClass === 'cloud' || s.writeClass === 'dns'),
  );
  if (inFlightBillable) {
    return {
      allowed: false,
      status: 'CANCELLATION_PENDING_RECONCILE',
      messageZh: '云资源操作进行中，正在核对状态，不能直接取消',
    };
  }
  if (
    input.runStatus === 'WAITING_CONFIRMATION' ||
    input.runStatus === 'READY' ||
    input.runStatus === 'DRAFT' ||
    input.runStatus === 'PLANNING'
  ) {
    return {
      allowed: true,
      status: 'CANCELLED',
      messageZh: '上线任务已取消',
    };
  }
  if (input.steps.every((s) => s.status === 'READY' || s.status === 'PENDING' || s.status === 'WAITING' || s.status === 'SKIPPED')) {
    return {
      allowed: true,
      status: 'CANCELLED',
      messageZh: '上线任务已取消',
    };
  }
  return {
    allowed: false,
    status: 'REJECTED',
    messageZh: '当前状态无法安全取消',
  };
}

export function reconcileRunningSteps(
  steps: LaunchExecutorStepInput[],
  opts: {
    launchRunId: string;
    projectId: string;
    environmentId: string;
    confirmationSatisfied: boolean;
    observedByStepId?: Record<string, Record<string, unknown>>;
  },
): Array<{ stepId: string; stepType: string; result: LaunchHandlerResult }> {
  const out: Array<{ stepId: string; stepType: string; result: LaunchHandlerResult }> = [];
  for (const step of steps) {
    if (step.status !== 'RUNNING' && step.status !== 'RECONCILING') continue;
    const handler = defaultLaunchHandlerRegistry.require(step.stepType);
    const result = handler.reconcile({
      launchRunId: opts.launchRunId,
      launchRunStepId: step.id,
      projectId: opts.projectId,
      environmentId: opts.environmentId,
      stepType: step.stepType as never,
      decision: step.decision,
      reconcileKey: step.reconcileKey,
      resourceType: step.resourceType,
      resourceId: step.resourceId,
      metadata: step.metadata ?? {},
      gateOnly: true,
      realExecutionLocked: true,
      confirmationSatisfied: opts.confirmationSatisfied,
      observedFacts: opts.observedByStepId?.[step.id] ?? {},
    }) as LaunchHandlerResult;
    out.push({ stepId: step.id, stepType: step.stepType, result });
  }
  return out;
}

export { selectParallelBatch };
