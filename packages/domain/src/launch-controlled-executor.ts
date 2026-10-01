/**
 * Step 30 Phase 4B — Controlled real write-path LaunchRun executor.
 * Injects real step runners; forbids billable cloud provisioning.
 */

import { assertLaunchEventSafe } from './launch-orchestrator.js';
import type { LaunchPlanResult } from './launch-orchestrator.js';
import { detectPlanStale } from './launch-orchestrator.js';
import { scheduleReadySteps } from './launch-scheduler.js';
import { computeLaunchProgress } from './launch-progress.js';
import { launchProjectLockKey, launchOperationKey } from './launch-execution-policy.js';
import { launchStepLockKey } from './launch-handler.js';
import { LAUNCH_ALREADY_RUNNING } from './launch-phase3-verify-only.js';
import {
  CONTROLLED_REAL_LAUNCH,
  CONTROLLED_LAUNCH_BILLABLE_ACTION_FORBIDDEN,
  PHASE4_EXPECTED_EXECUTION_STEPS,
  PHASE4_TEST_HOSTNAME,
  PHASE4_TEST_PROJECT_ID,
  PHASE4_WHITELIST_SERVER_ID,
  assertNoBillableControlledSteps,
  assertPhase4BExecutionPlan,
  emptyControlledWriteCounters,
  type ControlledWriteCounters,
} from './launch-phase4-controlled.js';
import {
  verifyPublicHttps,
  type PublicHttpsVerifyResult,
} from './launch-https-verify.js';
import type { LaunchPersistedStep, LaunchRunPersistence } from './launch-run-executor.js';

export type ControlledStepContext = {
  launchRunId: string;
  projectId: string;
  environmentId: string;
  stepType: string;
  stepId: string;
  unitId: string | null;
  reconcileKey: string;
  shared: ControlledExecutionSharedState;
};

export type ControlledStepResult = {
  status: 'SUCCESS' | 'FAILED' | 'WAITING_USER';
  failureCode?: string | null;
  failureMessage?: string | null;
  userMessage?: string | null;
  retryClass?: string | null;
  observedState?: Record<string, unknown>;
  technicalDetailsSafe?: Record<string, unknown>;
  /** Increment write counters for this step. */
  writes?: Partial<ControlledWriteCounters>;
  auditExtra?: string[];
};

export type ControlledExecutionSharedState = {
  buildOutputArtifactId: string | null;
  dockerImageArtifactId: string | null;
  deploymentId: string | null;
  serviceInstanceId: string | null;
  runtimePort: number | null;
  bindAddress: string;
  containerState: string | null;
  localHealthOk: boolean;
  gatewayLocalVerify: boolean;
  gatewayRouteId: string | null;
  gatewayRouteStatus: string | null;
  dnsProviderRecordId: string | null;
  dnsPropagated: boolean;
  accessEntryStatus: string | null;
  webHttps: PublicHttpsVerifyResult | null;
  httpRedirectOk: boolean | null;
  productionApiPreserved: boolean;
  productionWebPreserved: boolean;
  productionDnsPreserved: boolean;
  productionGatewayPreserved: boolean;
};

export type ControlledStepRunner = (
  ctx: ControlledStepContext,
) => Promise<ControlledStepResult>;

export type ControlledStepRunners = {
  BUILD_UNIT: ControlledStepRunner;
  BUILD_DOCKER_IMAGE: ControlledStepRunner;
  DEPLOY_WEB: ControlledStepRunner;
  APPLY_WEB_ROUTE: ControlledStepRunner;
  APPLY_WEB_DNS: ControlledStepRunner;
};

export type ExecuteControlledLaunchRunInput = {
  launchRunId: string;
  projectId: string;
  environmentId: string;
  planVersion: string;
  plan: LaunchPlanResult;
  steps: LaunchPersistedStep[];
  currentInputSnapshot: Record<string, unknown>;
  persistence: LaunchRunPersistence;
  runners: ControlledStepRunners;
  hostname?: string;
  expectedPublicIp?: string;
  verifyWebHttps?: () => Promise<PublicHttpsVerifyResult>;
  verifyHttpRedirect?: () => Promise<boolean>;
};

export type ControlledLaunchExecutionResult = {
  launchRunId: string;
  projectId: string;
  initialStatus: string;
  finalStatus: string;
  planVersion: string;
  planFresh: boolean;
  unitMode: 'WEB_ONLY';
  serverReused: true;
  billableActions: [];
  newBillableResources: [];
  stepStatuses: Record<string, string>;
  shared: ControlledExecutionSharedState;
  desiredStateSatisfied: boolean;
  progressPercent: number;
  auditEvents: string[];
  writeCounters: ControlledWriteCounters;
  unlockMode: typeof CONTROLLED_REAL_LAUNCH;
  EXECUTION_STARTED: true;
  failedLaunchStep: string | null;
  failureCode: string | null;
  retryClass: string | null;
  safeNextAction: string | null;
};

const WRITE_EXECUTE_STEPS = PHASE4_EXPECTED_EXECUTION_STEPS.filter(
  (s) => s !== 'VERIFY_WEB_HTTPS' && s !== 'FINAL_ACCEPTANCE',
);

async function emit(
  persistence: LaunchRunPersistence,
  counters: ControlledWriteCounters,
  auditEvents: string[],
  event: string,
  metadata: Record<string, unknown>,
) {
  assertLaunchEventSafe(metadata);
  await persistence.appendAudit(event, metadata);
  counters.launchStateWriteCount += 1;
  auditEvents.push(event);
}

function applyWrites(
  counters: ControlledWriteCounters,
  writes?: Partial<ControlledWriteCounters>,
) {
  if (!writes) return;
  for (const [k, v] of Object.entries(writes)) {
    if (typeof v === 'number' && k in counters) {
      const bag = counters as unknown as Record<string, number>;
      bag[k] = (bag[k] ?? 0) + v;
    }
  }
}

function assertCloudBillableZero(counters: ControlledWriteCounters) {
  if (
    counters.ecsCreateCount +
      counters.rdsCreateCount +
      counters.redisCreateCount +
      counters.cloudProviderWriteCount +
      counters.securityGroupWriteCount +
      counters.certificateWriteCount >
    0
  ) {
    throw new Error(CONTROLLED_LAUNCH_BILLABLE_ACTION_FORBIDDEN);
  }
}

/**
 * Controlled real one-click launch for WEB-only + server reuse (Phase 4B).
 */
export async function executeControlledLaunchRun(
  input: ExecuteControlledLaunchRunInput,
): Promise<ControlledLaunchExecutionResult> {
  const counters = emptyControlledWriteCounters();
  const auditEvents: string[] = [];
  const hostname = input.hostname ?? PHASE4_TEST_HOSTNAME;
  const expectedIp = input.expectedPublicIp ?? '116.62.198.184';

  if (input.projectId !== PHASE4_TEST_PROJECT_ID) {
    throw new Error('PHASE4_TEST_PROJECT_MISMATCH');
  }

  const planCheck = assertPhase4BExecutionPlan(input.projectId, input.plan);
  if (!planCheck.ok) {
    throw new Error(
      `PLAN_STALE:${planCheck.blockers.map((b) => b.code).join(',')}`,
    );
  }
  assertNoBillableControlledSteps(input.plan.executionSteps);

  const stale = detectPlanStale(input.plan.inputSnapshot, input.currentInputSnapshot);
  if (stale.stale) {
    throw new Error(`PLAN_STALE:${stale.reasons.join(',')}`);
  }

  const lockKey = launchProjectLockKey(input.projectId, input.environmentId);
  const locked = await input.persistence.acquireLaunchLock(lockKey);
  if (!locked) {
    throw new Error(LAUNCH_ALREADY_RUNNING);
  }

  const stepState = new Map(input.steps.map((s) => [s.id, { ...s }]));
  const shared: ControlledExecutionSharedState = {
    buildOutputArtifactId: null,
    dockerImageArtifactId: null,
    deploymentId: null,
    serviceInstanceId: null,
    runtimePort: null,
    bindAddress: '127.0.0.1',
    containerState: null,
    localHealthOk: false,
    gatewayLocalVerify: false,
    gatewayRouteId: null,
    gatewayRouteStatus: null,
    dnsProviderRecordId: null,
    dnsPropagated: false,
    accessEntryStatus: null,
    webHttps: null,
    httpRedirectOk: null,
    productionApiPreserved: true,
    productionWebPreserved: true,
    productionDnsPreserved: true,
    productionGatewayPreserved: true,
  };

  let failedLaunchStep: string | null = null;
  let failureCode: string | null = null;
  let retryClass: string | null = null;
  let safeNextAction: string | null = null;
  let finalStatus = 'RUNNING';

  const verifyWeb =
    input.verifyWebHttps ??
    (() =>
      verifyPublicHttps({
        hostname,
        url: `https://${hostname}/`,
        expectedIp,
        acceptStatuses: [200, 201, 204, 301, 302, 307, 308],
      }));

  try {
    await input.persistence.updateRun({
      launchRunId: input.launchRunId,
      status: 'RUNNING',
      startedAt: new Date(),
      currentStage: 'BUILD',
      currentStep: 'BUILD_UNIT',
    });
    counters.launchStateWriteCount += 1;

    await emit(input.persistence, counters, auditEvents, 'LAUNCH_EXECUTION_STARTED', {
      launchRunId: input.launchRunId,
      projectId: input.projectId,
      unlockMode: CONTROLLED_REAL_LAUNCH,
      hostname,
      serverInstanceId: PHASE4_WHITELIST_SERVER_ID,
    });

    // Mark REUSE/SKIP
    for (const step of input.steps) {
      if (step.decision === 'REUSE' || step.decision === 'SKIP') {
        const st = stepState.get(step.id)!;
        if (st.status !== 'SKIPPED' && st.status !== 'SUCCESS') {
          st.status = 'SKIPPED';
          await input.persistence.updateStep({
            stepId: step.id,
            status: 'SKIPPED',
            finishedAt: new Date(),
          });
          counters.launchStateWriteCount += 1;
        }
        await emit(input.persistence, counters, auditEvents, 'LAUNCH_STEP_REUSED', {
          launchRunId: input.launchRunId,
          stepType: step.stepType,
          decision: step.decision,
        });
      }
    }

    let guard = 0;
    while (guard++ < 80) {
      const scheduled = scheduleReadySteps(
        [...stepState.values()].map((s) => ({
          id: s.id,
          stepType: s.stepType,
          status: s.status,
          decision: s.decision,
          dependsOn: s.dependsOn,
          reconcileKey: s.reconcileKey,
        })),
      );
      for (const s of scheduled) {
        const cur = stepState.get(s.id)!;
        if (cur.status === 'PENDING' && s.status === 'READY') {
          cur.status = 'READY';
        }
      }

      const readyExecute = scheduled.filter(
        (s) =>
          s.status === 'READY' &&
          stepState.get(s.id)!.decision === 'EXECUTE' &&
          (PHASE4_EXPECTED_EXECUTION_STEPS as readonly string[]).includes(s.stepType),
      );

      if (readyExecute.length === 0) {
        const anyFailed = [...stepState.values()].some((s) => s.status === 'FAILED');
        const allDone = (PHASE4_EXPECTED_EXECUTION_STEPS as readonly string[]).every((type) =>
          [...stepState.values()].some(
            (s) =>
              s.stepType === type &&
              (s.status === 'SUCCESS' ||
                s.status === 'FAILED' ||
                s.status === 'SKIPPED' ||
                (s.decision !== 'EXECUTE' && s.status === 'SKIPPED')),
          ),
        );
        if (anyFailed || allDone) break;
        break;
      }

      // Prefer write steps before verify; FINAL last
      const ordered = [...readyExecute].sort((a, b) => {
        const rank = (t: string) => {
          const i = (PHASE4_EXPECTED_EXECUTION_STEPS as readonly string[]).indexOf(
            t as (typeof PHASE4_EXPECTED_EXECUTION_STEPS)[number],
          );
          return i < 0 ? 99 : i;
        };
        return rank(a.stepType) - rank(b.stepType);
      });
      const item = ordered[0]!;
      const step = stepState.get(item.id)!;

      // Mid-run billable drift guard
      if (
        step.stepType === 'PROVISION_SERVER' ||
        step.stepType === 'PROVISION_POSTGRESQL' ||
        step.stepType === 'PROVISION_REDIS'
      ) {
        throw new Error(`${CONTROLLED_LAUNCH_BILLABLE_ACTION_FORBIDDEN}:${step.stepType}`);
      }

      await emit(input.persistence, counters, auditEvents, 'LAUNCH_STAGE_STARTED', {
        launchRunId: input.launchRunId,
        stage: step.stage,
        stepType: step.stepType,
      });

      step.status = 'RUNNING';
      step.attemptCount = (step.attemptCount ?? 0) + 1;
      await input.persistence.updateRun({
        launchRunId: input.launchRunId,
        status: step.stepType.startsWith('VERIFY') || step.stepType === 'FINAL_ACCEPTANCE'
          ? 'VERIFYING'
          : 'RUNNING',
        currentStage: step.stage,
        currentStep: step.stepType,
      });
      counters.launchStateWriteCount += 1;
      await input.persistence.updateStep({
        stepId: step.id,
        status: 'RUNNING',
        startedAt: new Date(),
        attemptCount: step.attemptCount,
      });
      counters.launchStateWriteCount += 1;

      await emit(input.persistence, counters, auditEvents, 'LAUNCH_STEP_EXECUTION_STARTED', {
        launchRunId: input.launchRunId,
        stepType: step.stepType,
        stepLockKey: launchStepLockKey(input.launchRunId, step.id),
        operationKey: launchOperationKey(
          input.launchRunId,
          step.stepType,
          step.reconcileKey,
        ),
      });

      let result: ControlledStepResult;

      if (step.stepType === 'VERIFY_WEB_HTTPS') {
        if (!shared.dnsPropagated) {
          result = {
            status: 'FAILED',
            failureCode: 'DNS_NOT_PROPAGATED',
            failureMessage: 'DNS not propagated; cannot verify public HTTPS',
            retryClass: 'RETRYABLE',
          };
        } else {
          const web = await verifyWeb();
          shared.webHttps = web;
          let redirectOk = true;
          if (input.verifyHttpRedirect) {
            redirectOk = await input.verifyHttpRedirect();
          } else {
            try {
              const res = await fetch(`http://${hostname}/`, {
                method: 'GET',
                redirect: 'manual',
                signal: AbortSignal.timeout(10_000),
              });
              redirectOk = [301, 302, 307, 308].includes(res.status);
            } catch {
              redirectOk = false;
            }
          }
          shared.httpRedirectOk = redirectOk;
          const ok = web.ok && redirectOk;
          if (ok) {
            shared.accessEntryStatus = 'ACTIVE';
            shared.gatewayRouteStatus = 'ACTIVE';
          }
          result = {
            status: ok ? 'SUCCESS' : 'FAILED',
            failureCode: ok ? null : web.failureCode ?? 'WEB_VERIFY_FAILED',
            failureMessage: ok
              ? null
              : !redirectOk
                ? 'HTTP_TO_HTTPS_REDIRECT_FAILED'
                : web.failureMessage,
            observedState: {
              dnsCorrect: web.dnsCorrect,
              httpStatus: web.httpStatus,
              certificateValid: web.certificateValid,
              httpRedirectOk: redirectOk,
              accessEntryStatus: shared.accessEntryStatus,
            },
            auditExtra: ok ? ['PUBLIC_HTTPS_VERIFIED'] : [],
          };
          if (ok) {
            await emit(input.persistence, counters, auditEvents, 'LAUNCH_VERIFYING', {
              launchRunId: input.launchRunId,
              projectId: input.projectId,
            });
          }
        }
      } else if (step.stepType === 'FINAL_ACCEPTANCE') {
        const desired =
          shared.buildOutputArtifactId != null &&
          shared.dockerImageArtifactId != null &&
          shared.deploymentId != null &&
          shared.serviceInstanceId != null &&
          shared.localHealthOk === true &&
          shared.gatewayLocalVerify === true &&
          shared.gatewayRouteStatus === 'ACTIVE' &&
          shared.dnsPropagated === true &&
          shared.webHttps?.ok === true &&
          shared.httpRedirectOk === true &&
          shared.accessEntryStatus === 'ACTIVE' &&
          shared.runtimePort != null &&
          shared.runtimePort !== 39000 &&
          shared.runtimePort !== 39002 &&
          shared.bindAddress === '127.0.0.1' &&
          shared.productionApiPreserved &&
          shared.productionWebPreserved &&
          counters.ecsCreateCount === 0 &&
          counters.rdsCreateCount === 0 &&
          counters.redisCreateCount === 0 &&
          counters.securityGroupWriteCount === 0 &&
          counters.certificateWriteCount === 0;

        result = {
          status: desired ? 'SUCCESS' : 'FAILED',
          failureCode: desired ? null : 'DESIRED_STATE_NOT_SATISFIED',
          observedState: { desiredStateSatisfied: desired },
          technicalDetailsSafe: {
            buildOutputArtifactId: shared.buildOutputArtifactId,
            dockerImageArtifactId: shared.dockerImageArtifactId,
            deploymentId: shared.deploymentId,
            serviceInstanceId: shared.serviceInstanceId,
            runtimePort: shared.runtimePort,
            gatewayRouteStatus: shared.gatewayRouteStatus,
            accessEntryStatus: shared.accessEntryStatus,
          },
        };
      } else if ((WRITE_EXECUTE_STEPS as readonly string[]).includes(step.stepType)) {
        // DEPLOY failure must not run gateway/DNS — enforced by dependsOn + this check
        if (
          (step.stepType === 'APPLY_WEB_ROUTE' || step.stepType === 'APPLY_WEB_DNS') &&
          !shared.localHealthOk
        ) {
          result = {
            status: 'FAILED',
            failureCode: 'DEPLOY_NOT_HEALTHY',
            failureMessage: 'Web ServiceInstance not healthy; refuse gateway/DNS',
          };
        } else if (step.stepType === 'APPLY_WEB_DNS' && !shared.gatewayLocalVerify) {
          result = {
            status: 'FAILED',
            failureCode: 'GATEWAY_LOCAL_VERIFY_REQUIRED',
            failureMessage: 'Gateway local verify failed; refuse DNS write',
          };
        } else {
          const runner =
            input.runners[step.stepType as keyof ControlledStepRunners];
          if (!runner) {
            result = {
              status: 'FAILED',
              failureCode: 'RUNNER_MISSING',
              failureMessage: `No runner for ${step.stepType}`,
            };
          } else {
            result = await runner({
              launchRunId: input.launchRunId,
              projectId: input.projectId,
              environmentId: input.environmentId,
              stepType: step.stepType,
              stepId: step.id,
              unitId: step.reconcileKey !== 'default' ? step.reconcileKey : null,
              reconcileKey: step.reconcileKey,
              shared,
            });
          }
        }
      } else {
        result = {
          status: 'FAILED',
          failureCode: 'UNEXPECTED_STEP',
          failureMessage: step.stepType,
        };
      }

      applyWrites(counters, result.writes);
      assertCloudBillableZero(counters);

      for (const ev of result.auditExtra ?? []) {
        await emit(input.persistence, counters, auditEvents, ev, {
          launchRunId: input.launchRunId,
          stepType: step.stepType,
        });
      }

      if (result.status === 'SUCCESS') {
        step.status = 'SUCCESS';
        await input.persistence.updateStep({
          stepId: step.id,
          status: 'SUCCESS',
          finishedAt: new Date(),
          metadataJson: {
            ...(step.metadataJson ?? {}),
            observedState: result.observedState ?? {},
            technicalDetailsSafe: result.technicalDetailsSafe ?? {},
          },
        });
        counters.launchStateWriteCount += 1;
        await emit(input.persistence, counters, auditEvents, 'LAUNCH_STEP_SUCCESS', {
          launchRunId: input.launchRunId,
          stepType: step.stepType,
        });
        if (step.stepType === 'BUILD_UNIT' || step.stepType === 'BUILD_DOCKER_IMAGE') {
          await emit(input.persistence, counters, auditEvents, 'BUILD_COMPLETED', {
            launchRunId: input.launchRunId,
            stepType: step.stepType,
            artifactId:
              step.stepType === 'BUILD_UNIT'
                ? shared.buildOutputArtifactId
                : shared.dockerImageArtifactId,
          });
        }
        if (step.stepType === 'DEPLOY_WEB') {
          await emit(input.persistence, counters, auditEvents, 'DEPLOY_COMPLETED', {
            launchRunId: input.launchRunId,
            deploymentId: shared.deploymentId,
            serviceInstanceId: shared.serviceInstanceId,
            runtimePort: shared.runtimePort,
          });
        }
        if (step.stepType === 'APPLY_WEB_ROUTE') {
          await emit(input.persistence, counters, auditEvents, 'GATEWAY_ROUTE_APPLIED', {
            launchRunId: input.launchRunId,
            hostname,
            runtimePort: shared.runtimePort,
          });
        }
        if (step.stepType === 'APPLY_WEB_DNS') {
          await emit(input.persistence, counters, auditEvents, 'DNS_CHANGE_COMPLETED', {
            launchRunId: input.launchRunId,
            hostname,
            providerRecordId: shared.dnsProviderRecordId,
          });
        }
      } else if (result.status === 'WAITING_USER') {
        step.status = 'FAILED';
        failedLaunchStep = step.stepType;
        failureCode = result.failureCode ?? 'WAITING_USER';
        retryClass = result.retryClass ?? 'USER_ACTION_REQUIRED';
        safeNextAction = 'Fix the failure then explicitly resume; do not auto-rerun.';
        await input.persistence.updateStep({
          stepId: step.id,
          status: 'FAILED',
          finishedAt: new Date(),
          failureCode: failureCode,
          failureMessage: result.failureMessage ?? null,
        });
        counters.launchStateWriteCount += 1;
        await emit(input.persistence, counters, auditEvents, 'LAUNCH_WAITING_USER', {
          launchRunId: input.launchRunId,
          stepType: step.stepType,
          failureCode,
        });
        finalStatus = 'FAILED';
        break;
      } else {
        step.status = 'FAILED';
        failedLaunchStep = step.stepType;
        failureCode = result.failureCode ?? 'STEP_FAILED';
        retryClass = result.retryClass ?? 'USER_ACTION_REQUIRED';
        safeNextAction = 'Inspect failed step artifacts/logs; explicit resume only.';
        await input.persistence.updateStep({
          stepId: step.id,
          status: 'FAILED',
          finishedAt: new Date(),
          failureCode,
          failureMessage: result.failureMessage ?? null,
        });
        counters.launchStateWriteCount += 1;
        await emit(input.persistence, counters, auditEvents, 'LAUNCH_STEP_FAILED', {
          launchRunId: input.launchRunId,
          stepType: step.stepType,
          failureCode,
        });
        finalStatus = 'FAILED';
        break;
      }
    }

    const stepStatuses: Record<string, string> = {};
    for (const s of stepState.values()) {
      if ((PHASE4_EXPECTED_EXECUTION_STEPS as readonly string[]).includes(s.stepType)) {
        stepStatuses[s.stepType] = s.status;
      }
    }

    const allSuccess = (PHASE4_EXPECTED_EXECUTION_STEPS as readonly string[]).every(
      (t) => stepStatuses[t] === 'SUCCESS',
    );
    const desiredStateSatisfied =
      allSuccess && shared.accessEntryStatus === 'ACTIVE' && shared.webHttps?.ok === true;

    if (allSuccess && desiredStateSatisfied) {
      finalStatus = 'SUCCESS';
      await emit(input.persistence, counters, auditEvents, 'LAUNCH_SUCCESS', {
        launchRunId: input.launchRunId,
        projectId: input.projectId,
        hostname,
      });
    } else if (finalStatus === 'RUNNING' || finalStatus === 'VERIFYING') {
      finalStatus = 'FAILED';
      failureCode = failureCode ?? 'INCOMPLETE_EXECUTION';
    }

    const progress = computeLaunchProgress(
      [...stepState.values()].map((s) => ({
        stage: s.stage as
          | 'ANALYZE'
          | 'DEPENDENCIES'
          | 'INFRASTRUCTURE'
          | 'BUILD'
          | 'DEPLOY'
          | 'PUBLIC_ENTRY'
          | 'VERIFY',
        decision: s.decision,
        status:
          s.status === 'SUCCESS'
            ? 'SUCCESS'
            : s.status === 'FAILED'
              ? 'FAILED'
              : s.decision === 'REUSE' || s.decision === 'SKIP'
                ? 'SUCCESS'
                : (s.status as 'PENDING' | 'READY' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'SKIPPED'),
      })),
    );

    await input.persistence.updateRun({
      launchRunId: input.launchRunId,
      status: finalStatus,
      finishedAt: new Date(),
      failureCode: finalStatus === 'SUCCESS' ? null : failureCode,
      failureMessage: finalStatus === 'SUCCESS' ? null : failureCode,
      currentStep: failedLaunchStep,
    });
    counters.launchStateWriteCount += 1;

    return {
      launchRunId: input.launchRunId,
      projectId: input.projectId,
      initialStatus: 'READY',
      finalStatus,
      planVersion: input.planVersion,
      planFresh: true,
      unitMode: 'WEB_ONLY',
      serverReused: true,
      billableActions: [],
      newBillableResources: [],
      stepStatuses,
      shared,
      desiredStateSatisfied,
      progressPercent: desiredStateSatisfied ? 100 : progress.progressPercent,
      auditEvents,
      writeCounters: counters,
      unlockMode: CONTROLLED_REAL_LAUNCH,
      EXECUTION_STARTED: true,
      failedLaunchStep,
      failureCode,
      retryClass,
      safeNextAction,
    };
  } finally {
    await input.persistence.releaseLaunchLock(lockKey);
  }
}
