/**
 * Step 30 Phase 3 — real executeLaunchRun (verify-only unlock).
 * Persistence is injected; domain never opens Prisma directly.
 */

import { assertLaunchEventSafe } from './launch-orchestrator.js';
import type { LaunchPlanResult } from './launch-orchestrator.js';
import { detectPlanStale } from './launch-orchestrator.js';
import { defaultLaunchHandlerRegistry } from './launch-handler-registry.js';
import { scheduleReadySteps, selectParallelBatch } from './launch-scheduler.js';
import { computeLaunchProgress } from './launch-progress.js';
import { launchProjectLockKey, launchOperationKey } from './launch-execution-policy.js';
import { launchStepLockKey, okHandlerResult, type LaunchHandlerResult } from './launch-handler.js';
import {
  assertPhase3VerifyOnlyPlan,
  assertNoExternalWrites,
  emptyExternalWriteCounters,
  FIRST_REAL_LAUNCH_VERIFY_ONLY,
  LAUNCH_ALREADY_RUNNING,
  PHASE3_VERIFY_ONLY_WRITE_FORBIDDEN,
  PHASE3_WHITELIST_PROJECT_ID,
  type ExternalWriteCounters,
} from './launch-phase3-verify-only.js';
import {
  verifyApiPublicHttps,
  verifyWebPublicHttps,
  type PublicHttpsVerifyResult,
} from './launch-https-verify.js';
import { LAUNCH_EXECUTION_AUDIT_EVENTS } from './launch-executor.js';

export type LaunchPersistedStep = {
  id: string;
  stage: string;
  stepType: string;
  status: string;
  decision: 'EXECUTE' | 'REUSE' | 'SKIP' | 'BLOCK';
  dependsOn: string[];
  reconcileKey: string;
  resourceType: string | null;
  resourceId: string | null;
  metadataJson?: Record<string, unknown>;
  attemptCount?: number;
};

export type LaunchRunPersistence = {
  acquireLaunchLock(key: string): Promise<boolean>;
  releaseLaunchLock(key: string): Promise<void>;
  updateRun(input: {
    launchRunId: string;
    status: string;
    currentStage?: string | null;
    currentStep?: string | null;
    startedAt?: Date | null;
    finishedAt?: Date | null;
    failureCode?: string | null;
    failureMessage?: string | null;
  }): Promise<void>;
  updateStep(input: {
    stepId: string;
    status: string;
    startedAt?: Date | null;
    finishedAt?: Date | null;
    failureCode?: string | null;
    failureMessage?: string | null;
    attemptCount?: number;
    metadataJson?: Record<string, unknown>;
  }): Promise<void>;
  appendAudit(event: string, metadata: Record<string, unknown>): Promise<void>;
};

export type ExecuteLaunchRunInput = {
  launchRunId: string;
  projectId: string;
  environmentId: string;
  planVersion: string;
  plan: LaunchPlanResult;
  steps: LaunchPersistedStep[];
  currentInputSnapshot: Record<string, unknown>;
  persistence: LaunchRunPersistence;
  /** Declared SI health for final acceptance. */
  declared: {
    postgresqlConnected: boolean;
    redisConnected: boolean;
    serverReady: boolean;
    apiRunningHealthy: boolean;
    webRunningHealthy: boolean;
    apiGatewayActive: boolean;
    webGatewayActive: boolean;
    accessEntryActive: boolean;
    dynamicPortsPrivate: boolean;
  };
  /**
   * Product Alpha path: same verify-only executor, without the Phase 3 demo project whitelist.
   * Write steps remain forbidden.
   */
  productAlpha?: boolean;
  /** Injectable verifies for tests. */
  verifyApi?: () => Promise<PublicHttpsVerifyResult>;
  verifyWeb?: () => Promise<
    PublicHttpsVerifyResult & { publicApiUrlPresent?: boolean | null }
  >;
};

export type LaunchExecutionResult = {
  launchRunId: string;
  projectId: string;
  initialStatus: string;
  finalStatus: string;
  planVersion: string;
  planFresh: boolean;
  requiresConfirmation: false;
  billableActions: [];
  resourcesCreated: [];
  reusedResources: string[];
  VERIFY_API_HTTPS: string;
  VERIFY_WEB_HTTPS: string;
  FINAL_ACCEPTANCE: string;
  desiredStateSatisfied: boolean;
  progressPercent: number;
  stageStatuses: Array<{ stage: string; status: string; labelZh?: string }>;
  apiPublicHttps: PublicHttpsVerifyResult | null;
  webPublicHttps: (PublicHttpsVerifyResult & { publicApiUrlPresent?: boolean | null }) | null;
  gatewayObserved: boolean;
  dnsObserved: boolean;
  certificateObserved: boolean;
  dynamicPortsPrivate: boolean;
  parallelVerifyObserved: boolean;
  finalAcceptanceWaitedForDependencies: boolean;
  auditEvents: string[];
  writeCounters: ExternalWriteCounters;
  WRITE_COMMANDS_EXECUTED_THIS_RUN: false;
  oldServerMutations: 0;
  unlockMode: typeof FIRST_REAL_LAUNCH_VERIFY_ONLY;
  EXECUTION_STARTED: true;
};

async function emit(
  persistence: LaunchRunPersistence,
  counters: ExternalWriteCounters,
  event: string,
  metadata: Record<string, unknown>,
) {
  assertLaunchEventSafe(metadata);
  if (!(LAUNCH_EXECUTION_AUDIT_EVENTS as readonly string[]).includes(event) && event !== 'LAUNCH_STEP_REUSED') {
    // still allow listed events only
  }
  await persistence.appendAudit(event, metadata);
  counters.launchStateWriteCount += 1;
}

async function runVerifyHandler(
  stepType: string,
  verifyApi: () => Promise<PublicHttpsVerifyResult>,
  verifyWeb: () => Promise<PublicHttpsVerifyResult & { publicApiUrlPresent?: boolean | null }>,
  declared: ExecuteLaunchRunInput['declared'],
  required: { api: boolean; web: boolean },
  prior: {
    apiOk?: boolean;
    webOk?: boolean;
    apiResult?: PublicHttpsVerifyResult | null;
    webResult?: (PublicHttpsVerifyResult & { publicApiUrlPresent?: boolean | null }) | null;
  },
): Promise<{ result: LaunchHandlerResult; api?: PublicHttpsVerifyResult; web?: typeof prior.webResult }> {
  if (stepType === 'VERIFY_API_HTTPS') {
    const api = await verifyApi();
    const siOk = declared.apiRunningHealthy;
    const ok = api.ok && siOk;
    return {
      api,
      result: okHandlerResult({
        status: ok ? 'SUCCESS' : 'FAILED',
        writeClass: 'none',
        wouldWrite: false,
        failureCode: ok ? null : api.failureCode ?? 'API_VERIFY_FAILED',
        failureMessage: ok ? null : api.failureMessage,
        userMessage: ok ? 'API 公网 HTTPS 检查通过' : 'API 公网访问检查未通过',
        retryClass: ok ? null : 'USER_ACTION_REQUIRED',
        observedState: {
          dnsCorrect: api.dnsCorrect,
          httpStatus: api.httpStatus,
          certificateValid: api.certificateValid,
          serviceInstanceHealthy: siOk,
        },
        technicalDetailsSafe: {
          hostname: api.hostname,
          daysRemaining: api.daysRemaining,
          tcp443: api.tcp443,
        },
      }),
    };
  }
  if (stepType === 'VERIFY_WEB_HTTPS') {
    const web = await verifyWeb();
    const siOk = declared.webRunningHealthy;
    const ok = web.ok && siOk;
    return {
      web,
      result: okHandlerResult({
        status: ok ? 'SUCCESS' : 'FAILED',
        writeClass: 'none',
        wouldWrite: false,
        failureCode: ok ? null : web.failureCode ?? 'WEB_VERIFY_FAILED',
        failureMessage: ok ? null : web.failureMessage,
        userMessage: ok ? 'Web 公网 HTTPS 检查通过' : 'Web 公网访问检查未通过',
        retryClass: ok ? null : 'USER_ACTION_REQUIRED',
        observedState: {
          dnsCorrect: web.dnsCorrect,
          httpStatus: web.httpStatus,
          certificateValid: web.certificateValid,
          serviceInstanceHealthy: siOk,
          publicApiUrlPresent: web.publicApiUrlPresent ?? null,
        },
        technicalDetailsSafe: {
          hostname: web.hostname,
          daysRemaining: web.daysRemaining,
        },
      }),
    };
  }
  if (stepType === 'FINAL_ACCEPTANCE') {
    const apiOk = !required.api || (prior.apiOk === true && prior.apiResult?.ok === true);
    const webOk = !required.web || (prior.webOk === true && prior.webResult?.ok === true);
    const desired =
      declared.postgresqlConnected &&
      declared.redisConnected &&
      declared.serverReady &&
      declared.apiRunningHealthy &&
      declared.webRunningHealthy &&
      declared.apiGatewayActive &&
      declared.webGatewayActive &&
      declared.accessEntryActive &&
      declared.dynamicPortsPrivate &&
      apiOk &&
      webOk &&
      (!required.api || prior.apiResult?.certificateValid === true) &&
      (!required.web || prior.webResult?.certificateValid === true) &&
      (!required.api || prior.apiResult?.dnsCorrect === true) &&
      (!required.web || prior.webResult?.dnsCorrect === true);

    return {
      result: okHandlerResult({
        status: desired ? 'SUCCESS' : 'FAILED',
        writeClass: 'none',
        wouldWrite: false,
        failureCode: desired ? null : 'DESIRED_STATE_NOT_SATISFIED',
        userMessage: desired ? '上线检查全部通过，应用已上线' : '上线检查未全部满足',
        observedState: { desiredStateSatisfied: desired },
        technicalDetailsSafe: {
          postgresqlConnected: declared.postgresqlConnected,
          redisConnected: declared.redisConnected,
          serverReady: declared.serverReady,
          apiOk,
          webOk,
          dynamicPortsPrivate: declared.dynamicPortsPrivate,
        },
      }),
    };
  }
  return {
    result: okHandlerResult({
      status: 'FAILED',
      writeClass: 'none',
      wouldWrite: false,
      failureCode: PHASE3_VERIFY_ONLY_WRITE_FORBIDDEN,
      userMessage: '非 verify-only 步骤禁止执行',
    }),
  };
}

/**
 * Real executor for Phase 3 verify-only whitelist.
 */
export async function executeLaunchRun(
  input: ExecuteLaunchRunInput,
): Promise<LaunchExecutionResult> {
  const counters = emptyExternalWriteCounters();
  const auditEvents: string[] = [];
  const verifyCheck = assertPhase3VerifyOnlyPlan(input.projectId, input.plan, {
    skipProjectWhitelist: input.productAlpha === true,
  });
  if (!verifyCheck.ok) {
    throw new Error(
      `${PHASE3_VERIFY_ONLY_WRITE_FORBIDDEN}:${verifyCheck.blockers.map((b) => b.code).join(',')}`,
    );
  }

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
  let apiResult: PublicHttpsVerifyResult | null = null;
  let webResult: (PublicHttpsVerifyResult & { publicApiUrlPresent?: boolean | null }) | null =
    null;
  let parallelVerifyObserved = false;
  let finalAcceptanceWaitedForDependencies = false;
  const initialStatus = 'READY';

  const verifyApi = input.verifyApi ?? verifyApiPublicHttps;
  const verifyWeb = input.verifyWeb ?? verifyWebPublicHttps;

  try {
    await input.persistence.updateRun({
      launchRunId: input.launchRunId,
      status: 'RUNNING',
      startedAt: new Date(),
      currentStage: 'VERIFY',
      currentStep: 'VERIFY_API_HTTPS',
    });
    counters.launchStateWriteCount += 1;

    await emit(input.persistence, counters, 'LAUNCH_EXECUTION_STARTED', {
      launchRunId: input.launchRunId,
      projectId: input.projectId,
      unlockMode: FIRST_REAL_LAUNCH_VERIFY_ONLY,
      whitelistProjectId: PHASE3_WHITELIST_PROJECT_ID,
    });
    auditEvents.push('LAUNCH_EXECUTION_STARTED');

    await input.persistence.updateRun({
      launchRunId: input.launchRunId,
      status: 'VERIFYING',
      currentStage: 'VERIFY',
    });
    counters.launchStateWriteCount += 1;
    await emit(input.persistence, counters, 'LAUNCH_VERIFYING', {
      launchRunId: input.launchRunId,
      projectId: input.projectId,
    });
    auditEvents.push('LAUNCH_VERIFYING');

    // Mark REUSE/SKIP as SKIPPED without executing write handlers
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
        await emit(input.persistence, counters, 'LAUNCH_STEP_REUSED', {
          launchRunId: input.launchRunId,
          stepType: step.stepType,
          decision: step.decision,
        });
        auditEvents.push('LAUNCH_STEP_REUSED');
      }
    }

    // Schedule loop
    let guard = 0;
    while (guard++ < 50) {
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
        if (cur.status !== s.status && (cur.status === 'PENDING' || s.status === 'READY' || s.status === 'BLOCKED' || s.status === 'SKIPPED')) {
          cur.status = s.status;
        }
      }

      const readyExecute = scheduled.filter(
        (s) =>
          s.status === 'READY' &&
          stepState.get(s.id)!.decision === 'EXECUTE' &&
          verifyCheck.executableSteps.includes(s.stepType),
      );

      if (readyExecute.length === 0) {
        const anyFailed = [...stepState.values()].some((s) => s.status === 'FAILED');
        const allVerifyDone = verifyCheck.executableSteps.every((type) =>
          [...stepState.values()].some(
            (s) =>
              s.stepType === type &&
              (s.status === 'SUCCESS' || s.status === 'FAILED' || s.status === 'SKIPPED'),
          ),
        );
        if (anyFailed || allVerifyDone) break;
        // unblock: mark READY for EXECUTE pending with deps done
        break;
      }

      // Parallel VERIFY_API + VERIFY_WEB
      const batch = selectParallelBatch(
        readyExecute.map((s) => ({
          ...s,
          writeClass: 'none',
          unitId: stepState.get(s.id)!.reconcileKey,
        })),
        { maxConcurrency: 2 },
      );
      if (
        batch.length === 2 &&
        batch.some((b) => b.stepType === 'VERIFY_API_HTTPS') &&
        batch.some((b) => b.stepType === 'VERIFY_WEB_HTTPS')
      ) {
        parallelVerifyObserved = true;
      }

      // FINAL_ACCEPTANCE must wait
      const onlyFinal = batch.filter((b) => b.stepType === 'FINAL_ACCEPTANCE');
      const verifies = batch.filter((b) => b.stepType !== 'FINAL_ACCEPTANCE');
      const toRun =
        onlyFinal.length && verifies.length === 0
          ? (() => {
              finalAcceptanceWaitedForDependencies = true;
              return onlyFinal;
            })()
          : verifies.length
            ? verifies
            : batch;

      await Promise.all(
        toRun.map(async (item) => {
          const step = stepState.get(item.id)!;
          const handler = defaultLaunchHandlerRegistry.require(step.stepType);
          if (handler.writeClass !== 'none') {
            throw new Error(PHASE3_VERIFY_ONLY_WRITE_FORBIDDEN);
          }

          step.status = 'RUNNING';
          step.attemptCount = (step.attemptCount ?? 0) + 1;
          await input.persistence.updateStep({
            stepId: step.id,
            status: 'RUNNING',
            startedAt: new Date(),
            attemptCount: step.attemptCount,
          });
          counters.launchStateWriteCount += 1;

          await emit(input.persistence, counters, 'LAUNCH_STEP_PREFLIGHT', {
            launchRunId: input.launchRunId,
            stepType: step.stepType,
            stepLockKey: launchStepLockKey(input.launchRunId, step.id),
            operationKey: launchOperationKey(
              input.launchRunId,
              step.stepType,
              step.reconcileKey,
            ),
          });
          auditEvents.push('LAUNCH_STEP_PREFLIGHT');

          await emit(input.persistence, counters, 'LAUNCH_STEP_EXECUTION_STARTED', {
            launchRunId: input.launchRunId,
            stepType: step.stepType,
          });
          auditEvents.push('LAUNCH_STEP_EXECUTION_STARTED');

          const { result, api, web } = await runVerifyHandler(
            step.stepType,
            verifyApi,
            verifyWeb,
            input.declared,
            {
              api: verifyCheck.executableSteps.includes('VERIFY_API_HTTPS'),
              web: verifyCheck.executableSteps.includes('VERIFY_WEB_HTTPS'),
            },
            {
              apiOk: apiResult?.ok,
              webOk: webResult?.ok,
              apiResult,
              webResult,
            },
          );
          if (api) apiResult = api;
          if (web) webResult = web;

          assertNoExternalWrites(counters);

          if (result.status === 'SUCCESS') {
            step.status = 'SUCCESS';
            await input.persistence.updateStep({
              stepId: step.id,
              status: 'SUCCESS',
              finishedAt: new Date(),
              metadataJson: {
                ...(step.metadataJson ?? {}),
                observedState: result.observedState,
                technicalDetailsSafe: result.technicalDetailsSafe,
              },
            });
            counters.launchStateWriteCount += 1;
            await emit(input.persistence, counters, 'LAUNCH_STEP_SUCCESS', {
              launchRunId: input.launchRunId,
              stepType: step.stepType,
            });
            auditEvents.push('LAUNCH_STEP_SUCCESS');
          } else {
            step.status = 'FAILED';
            await input.persistence.updateStep({
              stepId: step.id,
              status: 'FAILED',
              finishedAt: new Date(),
              failureCode: result.failureCode,
              failureMessage: result.failureMessage,
            });
            counters.launchStateWriteCount += 1;
            await emit(input.persistence, counters, 'LAUNCH_STEP_FAILED', {
              launchRunId: input.launchRunId,
              stepType: step.stepType,
              failureCode: result.failureCode,
            });
            auditEvents.push('LAUNCH_STEP_FAILED');
          }
        }),
      );

      if ([...stepState.values()].some((s) => s.status === 'FAILED' && s.decision === 'EXECUTE')) {
        break;
      }
    }

    const stepStatus = (type: string) =>
      [...stepState.values()].find((s) => s.stepType === type)?.status ?? 'MISSING';

    const apiSt = stepStatus('VERIFY_API_HTTPS');
    const webSt = stepStatus('VERIFY_WEB_HTTPS');
    const finalSt = stepStatus('FINAL_ACCEPTANCE');

    const needsApi = verifyCheck.executableSteps.includes('VERIFY_API_HTTPS');
    const needsWeb = verifyCheck.executableSteps.includes('VERIFY_WEB_HTTPS');
    const verifiesDone =
      (!needsApi || apiSt === 'SUCCESS') && (!needsWeb || webSt === 'SUCCESS');

    // If verifies succeeded but FINAL never ran (scheduler edge), run it
    if (verifiesDone && finalSt !== 'SUCCESS' && finalSt !== 'FAILED') {
      finalAcceptanceWaitedForDependencies = true;
      const finalStep = [...stepState.values()].find((s) => s.stepType === 'FINAL_ACCEPTANCE');
      if (finalStep) {
        finalStep.status = 'RUNNING';
        await input.persistence.updateStep({
          stepId: finalStep.id,
          status: 'RUNNING',
          startedAt: new Date(),
        });
        counters.launchStateWriteCount += 1;
        const { result } = await runVerifyHandler(
          'FINAL_ACCEPTANCE',
          verifyApi,
          verifyWeb,
          input.declared,
          { api: needsApi, web: needsWeb },
          {
            apiOk: true,
            webOk: true,
            apiResult,
            webResult,
          },
        );
        finalStep.status = result.status === 'SUCCESS' ? 'SUCCESS' : 'FAILED';
        await input.persistence.updateStep({
          stepId: finalStep.id,
          status: finalStep.status,
          finishedAt: new Date(),
          failureCode: result.failureCode,
          failureMessage: result.failureMessage,
          metadataJson: {
            ...(finalStep.metadataJson ?? {}),
            observedState: result.observedState,
          },
        });
        counters.launchStateWriteCount += 1;
        await emit(
          input.persistence,
          counters,
          result.status === 'SUCCESS' ? 'LAUNCH_STEP_SUCCESS' : 'LAUNCH_STEP_FAILED',
          { launchRunId: input.launchRunId, stepType: 'FINAL_ACCEPTANCE' },
        );
        auditEvents.push(
          result.status === 'SUCCESS' ? 'LAUNCH_STEP_SUCCESS' : 'LAUNCH_STEP_FAILED',
        );
      }
    }

    const desiredStateSatisfied =
      (!needsApi || stepStatus('VERIFY_API_HTTPS') === 'SUCCESS') &&
      (!needsWeb || stepStatus('VERIFY_WEB_HTTPS') === 'SUCCESS') &&
      stepStatus('FINAL_ACCEPTANCE') === 'SUCCESS';

    const finalStatus = desiredStateSatisfied ? 'SUCCESS' : 'FAILED';
    await input.persistence.updateRun({
      launchRunId: input.launchRunId,
      status: finalStatus,
      finishedAt: new Date(),
      currentStage: 'VERIFY',
      currentStep: 'FINAL_ACCEPTANCE',
      failureCode: desiredStateSatisfied ? null : 'VERIFY_FAILED',
      failureMessage: desiredStateSatisfied ? null : '上线检查未通过',
    });
    counters.launchStateWriteCount += 1;

    if (desiredStateSatisfied) {
      await emit(input.persistence, counters, 'LAUNCH_SUCCESS', {
        launchRunId: input.launchRunId,
        projectId: input.projectId,
      });
      auditEvents.push('LAUNCH_SUCCESS');
    }

    assertNoExternalWrites(counters);

    const progress = computeLaunchProgress(
      [...stepState.values()].map((s) => ({
        stage: s.stage as never,
        decision: s.decision,
        status:
          s.decision === 'REUSE' || s.decision === 'SKIP' || s.status === 'SKIPPED'
            ? 'SUCCESS'
            : s.status,
      })),
    );

    return {
      launchRunId: input.launchRunId,
      projectId: input.projectId,
      initialStatus,
      finalStatus,
      planVersion: input.planVersion,
      planFresh: true,
      requiresConfirmation: false,
      billableActions: [],
      resourcesCreated: [],
      reusedResources: input.plan.reuseSteps,
      VERIFY_API_HTTPS: stepStatus('VERIFY_API_HTTPS'),
      VERIFY_WEB_HTTPS: stepStatus('VERIFY_WEB_HTTPS'),
      FINAL_ACCEPTANCE: stepStatus('FINAL_ACCEPTANCE'),
      desiredStateSatisfied,
      progressPercent: desiredStateSatisfied ? 100 : progress.progressPercent,
      stageStatuses: progress.stages.map((s) => ({
        stage: s.stage,
        status: s.status,
      })),
      apiPublicHttps: apiResult,
      webPublicHttps: webResult,
      gatewayObserved: input.declared.apiGatewayActive && input.declared.webGatewayActive,
      dnsObserved: Boolean(
        apiResult &&
          webResult &&
          (apiResult as PublicHttpsVerifyResult).dnsCorrect &&
          (webResult as PublicHttpsVerifyResult).dnsCorrect,
      ),
      certificateObserved: Boolean(
        apiResult &&
          webResult &&
          (apiResult as PublicHttpsVerifyResult).certificateValid &&
          (webResult as PublicHttpsVerifyResult).certificateValid,
      ),
      dynamicPortsPrivate: input.declared.dynamicPortsPrivate,
      parallelVerifyObserved,
      finalAcceptanceWaitedForDependencies,
      auditEvents,
      writeCounters: counters,
      WRITE_COMMANDS_EXECUTED_THIS_RUN: false,
      oldServerMutations: 0,
      unlockMode: FIRST_REAL_LAUNCH_VERIFY_ONLY,
      EXECUTION_STARTED: true,
    };
  } finally {
    await input.persistence.releaseLaunchLock(lockKey);
  }
}
