/**
 * Step 30 Phase 2 — orchestration execution wiring tests (gate-only, no writes).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildConfirmationPayload,
  createConfirmationRecord,
  hashConfirmationPayload,
  validateConfirmation,
} from './launch-confirmation.js';
import {
  evaluateCancelPolicy,
  evaluateLaunchGate,
  executeLaunchRunGateOnly,
  refuseRealExecution,
  reconcileRunningSteps,
} from './launch-executor.js';
import { defaultLaunchHandlerRegistry } from './launch-handler-registry.js';
import { detectLaunchDrift } from './launch-drift.js';
import {
  canParallelBuild,
  canParallelDeploy,
  mustSerializeGateway,
  scheduleReadySteps,
} from './launch-scheduler.js';
import {
  assertLaunchEventSafe,
  buildLaunchPlan,
  type DeclaredWorldState,
  type LaunchUnitInput,
} from './launch-orchestrator.js';
import {
  LAUNCH_STEP_TYPES,
  STEP30_PHASE2_REAL_EXECUTION_LOCKED,
  STEP30_PHASE2_WRITE_COMMANDS,
} from './launch-execution-policy.js';
import { computeLaunchProgress } from './launch-progress.js';

function baseUnits(): LaunchUnitInput[] {
  return [
    {
      id: 'unit-api',
      name: 'API',
      type: 'API',
      deployable: true,
      status: 'CONFIRMED',
      requiresPostgresql: true,
      requiresRedis: true,
    },
    {
      id: 'unit-web',
      name: 'Web',
      type: 'WEB',
      deployable: true,
      status: 'CONFIRMED',
      requiresPostgresql: false,
      requiresRedis: false,
    },
  ];
}

function liveDeclared(): DeclaredWorldState {
  return {
    analysisReady: true,
    postgresql: { required: true, status: 'CONNECTED', connectionId: 'db-1' },
    redis: { required: true, status: 'CONNECTED', connectionId: 'redis-1' },
    server: { id: 'srv-1', status: 'READY', dockerStatus: 'READY', compatible: true },
    units: [
      {
        unitId: 'unit-api',
        type: 'API',
        artifactReady: true,
        artifactId: 'art-api',
        serviceStatus: 'RUNNING',
        healthStatus: 'HEALTHY',
        serviceInstanceId: 'si-api',
        gatewayStatus: 'ACTIVE',
        gatewayHostname: 'api.example.com',
        dnsStatus: 'ACTIVE',
        certificateValid: true,
      },
      {
        unitId: 'unit-web',
        type: 'WEB',
        artifactReady: true,
        artifactId: 'art-web',
        serviceStatus: 'RUNNING',
        healthStatus: 'HEALTHY',
        serviceInstanceId: 'si-web',
        gatewayStatus: 'ACTIVE',
        gatewayHostname: 'web.example.com',
        dnsStatus: 'ACTIVE',
        certificateValid: true,
      },
    ],
    accessEntryStatus: 'ACTIVE',
  };
}

function livePlan() {
  return buildLaunchPlan({
    projectId: 'proj-1',
    environmentId: 'env-1',
    units: baseUnits(),
    declared: liveDeclared(),
    observed: {
      serverObservedReady: true,
      containerObservedRunning: { 'unit-api': true, 'unit-web': true },
      healthObserved2xx: { 'unit-api': true, 'unit-web': true },
      dnsObservedCorrect: { 'unit-api': true, 'unit-web': true },
      certificateObservedValid: true,
      gatewayObservedListening: true,
    },
  });
}

function freshPlan() {
  return buildLaunchPlan({
    projectId: 'proj-fresh',
    environmentId: 'env-1',
    units: baseUnits(),
    declared: {
      analysisReady: false,
      postgresql: { required: true, status: 'MISSING' },
      redis: { required: true, status: 'MISSING' },
      server: null,
      units: [
        { unitId: 'unit-api', type: 'API', artifactReady: false },
        { unitId: 'unit-web', type: 'WEB', artifactReady: false },
      ],
    },
    observed: {},
    serverRecommendation: { vcpu: 2, memoryGb: 4 },
  });
}

function stepsFromPlan(plan: ReturnType<typeof livePlan>) {
  return plan.steps.map((s, i) => ({
    id: `step-${i}`,
    stage: s.stage,
    stepType: s.stepType,
    status: s.status,
    decision: s.decision,
    dependsOn: s.dependsOn,
    reconcileKey: s.reconcileKey,
    resourceType: s.resourceType,
    resourceId: s.resourceId,
  }));
}

describe('step30 phase2 orchestration execution wiring', () => {
  it('1. handler registry complete', () => {
    assert.equal(defaultLaunchHandlerRegistry.isComplete(), true);
    assert.equal(defaultLaunchHandlerRegistry.list().length, LAUNCH_STEP_TYPES.length);
    assert.equal(defaultLaunchHandlerRegistry.require('DEPLOY_API').wraps.includes('MANAGED_SERVER'), true);
    assert.equal(defaultLaunchHandlerRegistry.require('APPLY_API_DNS').writeClass, 'dns');
  });

  it('2. Demo all reuse + verify only', () => {
    const plan = livePlan();
    const gate = evaluateLaunchGate({
      launchRunId: 'run-demo',
      projectId: plan.projectId,
      environmentId: plan.environmentId,
      planVersion: plan.planVersion,
      plan,
      steps: stepsFromPlan(plan),
      currentInputSnapshot: plan.inputSnapshot,
    });
    assert.equal(gate.requiresConfirmation, false);
    assert.equal(gate.writePlan.cloudWritesPlanned, 0);
    assert.equal(gate.writePlan.deploymentWritesPlanned, 0);
    assert.equal(gate.writePlan.gatewayWritesPlanned, 0);
    assert.equal(gate.writePlan.dnsWritesPlanned, 0);
    assert.equal(gate.writePlan.certificateWritesPlanned, 0);
    assert.equal(gate.writePlan.remoteWritesPlanned, 0);
    assert.equal(gate.canExecute, true);
    assert.equal(gate.realExecutionLocked, true);
    assert.ok(gate.executionSteps.every((s) => s.includes('VERIFY') || s === 'FINAL_ACCEPTANCE'));
  });

  it('3. fresh project stops at confirmation', () => {
    const plan = freshPlan();
    const gate = evaluateLaunchGate({
      launchRunId: 'run-fresh',
      projectId: plan.projectId,
      environmentId: plan.environmentId,
      planVersion: plan.planVersion,
      plan,
      steps: stepsFromPlan(plan),
      currentInputSnapshot: plan.inputSnapshot,
    });
    assert.equal(gate.requiresConfirmation, true);
    assert.equal(gate.canExecute, false);
    assert.ok(gate.blockers.some((b) => b.code === 'BILLABLE_ACTION_CONFIRMATION_REQUIRED'));
    assert.equal(gate.writePlan.providerWriteCount, 0);
    // planned counts > 0 but no writes executed
    assert.equal(gate.WRITE_COMMANDS_EXECUTED_THIS_RUN, false);
    assert.ok(gate.writePlan.cloudWritesPlanned > 0);
  });

  it('4. confirmation plan hash mismatch', () => {
    const plan = freshPlan();
    const payload = buildConfirmationPayload({
      planVersion: plan.planVersion,
      projectId: plan.projectId,
      environmentId: plan.environmentId,
      billableActions: plan.billableActions,
      resourcesToCreate: plan.resourcesToCreate,
    });
    const record = createConfirmationRecord({
      confirmationId: 'c1',
      confirmedByUserId: 'u1',
      payload,
    });
    const drifted = {
      ...payload,
      billableActions: [
        ...payload.billableActions,
        { stepType: 'PROVISION_SERVER', labelZh: 'changed' },
      ],
    };
    const check = validateConfirmation({
      record,
      currentPayload: drifted,
      requiresConfirmation: true,
    });
    assert.equal(check.ok, false);
    assert.equal(check.code, 'CONFIRMATION_STALE');
  });

  it('5. valid confirmation allows billable step gate', () => {
    const plan = freshPlan();
    const payload = buildConfirmationPayload({
      planVersion: plan.planVersion,
      projectId: plan.projectId,
      environmentId: plan.environmentId,
      billableActions: plan.billableActions,
      resourcesToCreate: plan.resourcesToCreate,
    });
    const record = createConfirmationRecord({
      confirmationId: 'c2',
      confirmedByUserId: 'u1',
      payload,
    });
    const gate = evaluateLaunchGate({
      launchRunId: 'run-fresh-ok',
      projectId: plan.projectId,
      environmentId: plan.environmentId,
      planVersion: plan.planVersion,
      plan,
      steps: stepsFromPlan(plan),
      currentInputSnapshot: plan.inputSnapshot,
      confirmation: record,
    });
    assert.equal(gate.confirmationSatisfied, true);
    assert.equal(gate.canExecute, true);
    // still locked for real provider writes
    assert.equal(gate.realExecutionLocked, true);
    const provision = gate.steps.find((s) => s.stepType === 'PROVISION_SERVER' && s.wouldExecute);
    assert.ok(provision);
    assert.equal(provision!.confirmationSatisfied, true);
  });

  it('6. plan stale blocks execution', () => {
    const plan = livePlan();
    const gate = evaluateLaunchGate({
      launchRunId: 'run-stale',
      projectId: plan.projectId,
      environmentId: plan.environmentId,
      planVersion: plan.planVersion,
      plan,
      steps: stepsFromPlan(plan),
      currentInputSnapshot: { ...plan.inputSnapshot, serverId: 'other' },
    });
    assert.equal(gate.planStale, true);
    assert.equal(gate.canExecute, false);
    assert.ok(gate.blockers.some((b) => b.code === 'PLAN_STALE'));
  });

  it('7. dependency scheduler', () => {
    const scheduled = scheduleReadySteps([
      {
        id: '1',
        stepType: 'ANALYZE_PROJECT',
        status: 'PENDING',
        decision: 'EXECUTE',
        dependsOn: [],
        reconcileKey: 'default',
      },
      {
        id: '2',
        stepType: 'PLAN_DEPENDENCIES',
        status: 'PENDING',
        decision: 'EXECUTE',
        dependsOn: ['ANALYZE_PROJECT'],
        reconcileKey: 'default',
      },
    ]);
    assert.equal(scheduled[0]!.status, 'READY');
    assert.equal(scheduled[1]!.status, 'PENDING');
    const after = scheduleReadySteps([
      { ...scheduled[0]!, status: 'SUCCESS' },
      scheduled[1]!,
    ]);
    assert.equal(after[1]!.status, 'READY');
  });

  it('8. unit parallel build', () => {
    assert.equal(
      canParallelBuild(
        {
          id: 'a',
          stepType: 'BUILD_UNIT',
          status: 'READY',
          decision: 'EXECUTE',
          dependsOn: [],
          reconcileKey: 'unit-api',
        },
        {
          id: 'b',
          stepType: 'BUILD_UNIT',
          status: 'READY',
          decision: 'EXECUTE',
          dependsOn: [],
          reconcileKey: 'unit-web',
        },
      ),
      true,
    );
  });

  it('9. unit parallel deploy', () => {
    assert.equal(
      canParallelDeploy(
        {
          id: 'a',
          stepType: 'DEPLOY_API',
          status: 'READY',
          decision: 'EXECUTE',
          dependsOn: [],
          reconcileKey: 'unit-api',
        },
        {
          id: 'b',
          stepType: 'DEPLOY_WEB',
          status: 'READY',
          decision: 'EXECUTE',
          dependsOn: [],
          reconcileKey: 'unit-web',
        },
      ),
      true,
    );
  });

  it('10. conflicting gateway step serialized', () => {
    assert.equal(
      mustSerializeGateway(
        {
          id: 'a',
          stepType: 'APPLY_API_ROUTE',
          status: 'READY',
          decision: 'EXECUTE',
          dependsOn: [],
          reconcileKey: 'unit-api',
        },
        {
          id: 'b',
          stepType: 'APPLY_WEB_ROUTE',
          status: 'READY',
          decision: 'EXECUTE',
          dependsOn: [],
          reconcileKey: 'unit-web',
        },
      ),
      true,
    );
  });

  it('11. crash while server create → reconcile unknown (no duplicate)', () => {
    const results = reconcileRunningSteps(
      [
        {
          id: 's1',
          stage: 'INFRASTRUCTURE',
          stepType: 'PROVISION_SERVER',
          status: 'RUNNING',
          decision: 'EXECUTE',
          dependsOn: [],
          reconcileKey: 'default',
          resourceType: 'SERVER',
          resourceId: null,
        },
      ],
      {
        launchRunId: 'run-x',
        projectId: 'p',
        environmentId: 'e',
        confirmationSatisfied: true,
        observedByStepId: { s1: { resourceExists: null } },
      },
    );
    assert.equal(results[0]!.result.status, 'UNKNOWN');
    assert.equal(results[0]!.result.technicalDetailsSafe.noBlindCreate, true);
  });

  it('12. crash while DB create → reconcile', () => {
    const results = reconcileRunningSteps(
      [
        {
          id: 's1',
          stage: 'DEPENDENCIES',
          stepType: 'PROVISION_POSTGRESQL',
          status: 'RUNNING',
          decision: 'EXECUTE',
          dependsOn: [],
          reconcileKey: 'default',
          resourceType: 'DATABASE',
          resourceId: null,
        },
      ],
      {
        launchRunId: 'run-x',
        projectId: 'p',
        environmentId: 'e',
        confirmationSatisfied: true,
        observedByStepId: { s1: { resourceExists: true, resourceId: 'db-new' } },
      },
    );
    assert.equal(results[0]!.result.status, 'SUCCESS');
  });

  it('13. unknown result no duplicate create', () => {
    const handler = defaultLaunchHandlerRegistry.require('PROVISION_REDIS');
    const result = handler.reconcile({
      launchRunId: 'r',
      launchRunStepId: 's',
      projectId: 'p',
      environmentId: 'e',
      stepType: 'PROVISION_REDIS',
      decision: 'EXECUTE',
      reconcileKey: 'default',
      resourceType: 'CACHE',
      resourceId: null,
      metadata: {},
      gateOnly: true,
      realExecutionLocked: true,
      confirmationSatisfied: true,
      observedFacts: {},
    });
    assert.equal((result as { status: string }).status, 'UNKNOWN');
  });

  it('14. deployment crash reconcile', () => {
    const handler = defaultLaunchHandlerRegistry.require('DEPLOY_API');
    const result = handler.reconcile({
      launchRunId: 'r',
      launchRunStepId: 's',
      projectId: 'p',
      environmentId: 'e',
      stepType: 'DEPLOY_API',
      decision: 'EXECUTE',
      reconcileKey: 'unit-api',
      resourceType: 'SERVICE_INSTANCE',
      resourceId: 'si-1',
      metadata: {},
      gateOnly: true,
      realExecutionLocked: true,
      confirmationSatisfied: true,
    }) as { status: string };
    assert.equal(result.status, 'SUCCESS');
  });

  it('15. DNS crash reconcile', () => {
    const results = reconcileRunningSteps(
      [
        {
          id: 'dns1',
          stage: 'PUBLIC_ENTRY',
          stepType: 'APPLY_API_DNS',
          status: 'RECONCILING',
          decision: 'EXECUTE',
          dependsOn: [],
          reconcileKey: 'unit-api',
          resourceType: 'DNS',
          resourceId: null,
        },
      ],
      {
        launchRunId: 'run-dns',
        projectId: 'p',
        environmentId: 'e',
        confirmationSatisfied: true,
      },
    );
    assert.equal(results[0]!.result.status, 'SUCCESS');
  });

  it('16. user-code failure waits user', () => {
    const cancel = evaluateCancelPolicy({
      runStatus: 'WAITING_CONFIRMATION',
      steps: [{ status: 'WAITING', billable: true }],
    });
    assert.equal(cancel.allowed, true);
  });

  it('17. resume after user fix — confirmation then canExecute', () => {
    const plan = freshPlan();
    const payload = buildConfirmationPayload({
      planVersion: plan.planVersion,
      projectId: plan.projectId,
      environmentId: plan.environmentId,
      billableActions: plan.billableActions,
      resourcesToCreate: plan.resourcesToCreate,
    });
    const record = createConfirmationRecord({
      confirmationId: 'c3',
      confirmedByUserId: 'u1',
      payload,
    });
    const gate = executeLaunchRunGateOnly({
      launchRunId: 'run-resume',
      projectId: plan.projectId,
      environmentId: plan.environmentId,
      planVersion: plan.planVersion,
      plan,
      steps: stepsFromPlan(plan),
      currentInputSnapshot: plan.inputSnapshot,
      confirmation: record,
    });
    assert.equal(gate.canExecute, true);
    assert.equal(gate.WRITE_COMMANDS_EXECUTED_THIS_RUN, false);
  });

  it('18. drift detection deployment', () => {
    const report = detectLaunchDrift({
      dependencyOk: true,
      serverOk: true,
      units: [
        {
          unitId: 'unit-api',
          declaredHealthy: true,
          containerObservedRunning: false,
        },
      ],
      accessEntryActive: true,
    });
    assert.equal(report.severity, 'REPAIRABLE');
    assert.ok(report.findings.some((f) => f.kind === 'deployment'));
  });

  it('18b. exited runtime is deployment drift, not gateway or dns', () => {
    const report = detectLaunchDrift({
      dependencyOk: true,
      serverOk: true,
      units: [
        {
          unitId: 'unit-web',
          declaredHealthy: false,
          containerObservedRunning: false,
          gatewayActive: true,
          dnsObservedCorrect: true,
        },
      ],
      accessEntryActive: true,
    });
    assert.ok(report.findings.some((f) => f.code === 'RUNTIME_CONTAINER_EXITED'));
    assert.equal(report.findings.some((f) => f.kind === 'gateway'), false);
    assert.equal(report.findings.some((f) => f.kind === 'dns'), false);
  });

  it('19. drift detection DNS', () => {
    const report = detectLaunchDrift({
      dependencyOk: true,
      serverOk: true,
      units: [{ unitId: 'u', declaredHealthy: true, dnsObservedCorrect: false }],
    });
    assert.ok(report.findings.some((f) => f.kind === 'dns'));
  });

  it('20. drift detection certificate', () => {
    const report = detectLaunchDrift({
      dependencyOk: true,
      serverOk: true,
      units: [],
      certificateExpired: true,
    });
    assert.ok(report.findings.some((f) => f.kind === 'certificate'));
    assert.equal(report.severity, 'USER_ACTION_REQUIRED');
  });

  it('21. cancel safe waiting step', () => {
    const r = evaluateCancelPolicy({
      runStatus: 'READY',
      steps: [{ status: 'READY' }, { status: 'WAITING' }],
    });
    assert.equal(r.status, 'CANCELLED');
  });

  it('22. cancel during provider create', () => {
    const r = evaluateCancelPolicy({
      runStatus: 'RUNNING',
      steps: [{ status: 'RUNNING', billable: true, writeClass: 'cloud' }],
    });
    assert.equal(r.status, 'CANCELLATION_PENDING_RECONCILE');
  });

  it('23. event secret scan', () => {
    assert.doesNotThrow(() =>
      assertLaunchEventSafe({ event: 'LAUNCH_STEP_SUCCESS', launchRunId: 'r1' }),
    );
    assert.throws(() => assertLaunchEventSafe({ password: 'x' }));
  });

  it('24. progress calculation', () => {
    const plan = livePlan();
    const progress = computeLaunchProgress(
      plan.steps.map((s) => ({
        stage: s.stage,
        decision: s.decision,
        status: s.decision === 'REUSE' || s.decision === 'SKIP' ? 'SUCCESS' : 'READY',
      })),
    );
    assert.ok(progress.progressPercent >= 90);
  });

  it('25. real execution locked', () => {
    const refused = refuseRealExecution();
    assert.equal(refused.code, STEP30_PHASE2_REAL_EXECUTION_LOCKED);
    assert.equal(STEP30_PHASE2_WRITE_COMMANDS, false);
    assert.equal(hashConfirmationPayload(buildConfirmationPayload({
      planVersion: 'v',
      projectId: 'p',
      environmentId: 'e',
      billableActions: [],
      resourcesToCreate: [],
    })).length, 64);
  });
});
