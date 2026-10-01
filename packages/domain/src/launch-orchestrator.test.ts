import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACTIVE_LAUNCH_RUN_STATUSES,
  STEP30_PHASE1_WRITE_COMMANDS,
  STEP30_REAL_EXECUTION_LOCKED,
  classifyLaunchFailure,
  getLaunchStepPolicy,
  launchProjectLockKey,
} from './launch-execution-policy.js';
import {
  assertLaunchEventSafe,
  buildLaunchPlan,
  detectPlanStale,
  planResumeStep,
  type BuildLaunchPlanInput,
  type DeclaredWorldState,
  type LaunchUnitInput,
} from './launch-orchestrator.js';
import { computeLaunchProgress } from './launch-progress.js';
import { LAUNCH_USER_CODE_POLICY, launchErrorUserMessage } from './launch-user-messages.js';

function baseUnitsWebApi(): LaunchUnitInput[] {
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
    server: {
      id: 'srv-1',
      status: 'READY',
      dockerStatus: 'READY',
      compatible: true,
    },
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

function plan(partial: Partial<BuildLaunchPlanInput> & Pick<BuildLaunchPlanInput, 'declared' | 'units'>) {
  return buildLaunchPlan({
    projectId: 'proj-1',
    environmentId: 'env-1',
    observed: {
      serverObservedReady: true,
      containerObservedRunning: { 'unit-api': true, 'unit-web': true },
      healthObserved2xx: { 'unit-api': true, 'unit-web': true },
      dnsObservedCorrect: { 'unit-api': true, 'unit-web': true },
      certificateObservedValid: true,
      gatewayObservedListening: true,
    },
    ...partial,
  });
}

describe('step30 phase1 launch orchestrator', () => {
  it('1. already-live project → reuse (no create / no billable)', () => {
    const result = plan({ units: baseUnitsWebApi(), declared: liveDeclared() });
    assert.equal(result.resourcesToCreate.length, 0);
    assert.equal(result.billableActions.length, 0);
    assert.equal(result.requiresConfirmation, false);
    assert.equal(result.currentDesiredStateSatisfied, true);
    assert.equal(result.WRITE_COMMANDS_EXECUTED_THIS_RUN, false);
    assert.ok(result.reuseSteps.includes('CONNECT_POSTGRESQL'));
    assert.ok(result.reuseSteps.includes('DEPLOY_API'));
    assert.ok(result.reuseSteps.includes('DEPLOY_WEB'));
    assert.ok(result.executionSteps.includes('FINAL_ACCEPTANCE'));
    assert.ok(result.executionSteps.includes('VERIFY_API_HTTPS'));
    assert.ok(!result.executionSteps.includes('PROVISION_SERVER'));
  });

  it('2. fresh Web+API → resource confirmation', () => {
    const result = plan({
      units: baseUnitsWebApi(),
      declared: {
        analysisReady: false,
        postgresql: { required: true, status: 'MISSING' },
        redis: { required: true, status: 'MISSING' },
        server: null,
        units: [
          { unitId: 'unit-api', type: 'API', artifactReady: false },
          { unitId: 'unit-web', type: 'WEB', artifactReady: false },
        ],
        accessEntryStatus: null,
      },
      observed: {},
      serverRecommendation: { profileLabel: '标准', vcpu: 2, memoryGb: 4 },
    });
    assert.ok(result.requiresConfirmation);
    assert.equal(result.suggestedRunStatus, 'WAITING_CONFIRMATION');
    assert.ok(result.billableActions.some((a) => a.stepType === 'PROVISION_SERVER'));
    assert.ok(result.billableActions.some((a) => a.stepType === 'PROVISION_POSTGRESQL'));
    assert.ok(result.billableActions.some((a) => a.stepType === 'PROVISION_REDIS'));
    assert.ok(result.executionSteps.includes('DEPLOY_API'));
    assert.ok(result.executionSteps.includes('DEPLOY_WEB'));
    assert.ok(result.executionSteps.includes('APPLY_WEB_DNS'));
  });

  it('3. Web-only → no DB/Redis steps as required', () => {
    const result = plan({
      units: [
        {
          id: 'unit-web',
          name: 'Web',
          type: 'WEB',
          deployable: true,
          status: 'CONFIRMED',
          requiresPostgresql: false,
          requiresRedis: false,
        },
      ],
      declared: {
        analysisReady: true,
        postgresql: { required: false, status: 'NOT_REQUIRED' },
        redis: { required: false, status: 'NOT_REQUIRED' },
        server: null,
        units: [{ unitId: 'unit-web', type: 'WEB', artifactReady: false }],
      },
      observed: {},
    });
    assert.ok(result.skipSteps.includes('PROVISION_POSTGRESQL'));
    assert.ok(result.skipSteps.includes('CONNECT_REDIS'));
    assert.ok(!result.executionSteps.includes('DEPLOY_API'));
    assert.ok(result.executionSteps.includes('DEPLOY_WEB'));
    assert.ok(result.requiresConfirmation); // needs server
  });

  it('4. API-only → no Web route/DNS', () => {
    const result = plan({
      units: [
        {
          id: 'unit-api',
          name: 'API',
          type: 'API',
          deployable: true,
          status: 'CONFIRMED',
          requiresPostgresql: true,
          requiresRedis: true,
        },
      ],
      declared: {
        analysisReady: true,
        postgresql: { required: true, status: 'MISSING' },
        redis: { required: true, status: 'MISSING' },
        server: null,
        units: [{ unitId: 'unit-api', type: 'API', artifactReady: false }],
      },
      observed: {},
    });
    assert.ok(result.executionSteps.includes('DEPLOY_API'));
    assert.ok(result.executionSteps.includes('APPLY_API_DNS'));
    assert.ok(!result.executionSteps.includes('DEPLOY_WEB'));
    assert.ok(!result.executionSteps.includes('APPLY_WEB_ROUTE'));
    assert.ok(!result.executionSteps.includes('APPLY_WEB_DNS'));
  });

  it('5. stale DB HEALTHY declared but observed unhealthy → not reuse deploy', () => {
    const declared = liveDeclared();
    const result = plan({
      units: baseUnitsWebApi(),
      declared,
      observed: {
        serverObservedReady: true,
        containerObservedRunning: { 'unit-api': false, 'unit-web': true },
        healthObserved2xx: { 'unit-api': false, 'unit-web': true },
        dnsObservedCorrect: { 'unit-api': true, 'unit-web': true },
        certificateObservedValid: true,
        gatewayObservedListening: true,
      },
    });
    const deployApi = result.steps.find(
      (s) => s.stepType === 'DEPLOY_API' && s.reconcileKey === 'unit-api',
    );
    assert.equal(deployApi?.decision, 'EXECUTE');
    assert.equal(result.currentDesiredStateSatisfied, false);
  });

  it('6. READY server but observed not ready → initialize/repair', () => {
    const declared = liveDeclared();
    const result = plan({
      units: baseUnitsWebApi(),
      declared,
      observed: {
        serverObservedReady: false,
        containerObservedRunning: { 'unit-api': true, 'unit-web': true },
        healthObserved2xx: { 'unit-api': true, 'unit-web': true },
        dnsObservedCorrect: { 'unit-api': true, 'unit-web': true },
        certificateObservedValid: true,
        gatewayObservedListening: true,
      },
    });
    const init = result.steps.find((s) => s.stepType === 'INITIALIZE_SERVER');
    assert.equal(init?.decision, 'EXECUTE');
    assert.equal(
      result.steps.find((s) => s.stepType === 'PROVISION_SERVER')?.decision,
      'SKIP',
    );
  });

  it('7. healthy deployment → reuse', () => {
    const result = plan({ units: baseUnitsWebApi(), declared: liveDeclared() });
    assert.equal(
      result.steps.find((s) => s.stepType === 'DEPLOY_API')?.decision,
      'REUSE',
    );
  });

  it('8. unhealthy SI → redeploy', () => {
    const declared = liveDeclared();
    declared.units[0]!.serviceStatus = 'FAILED';
    declared.units[0]!.healthStatus = 'UNHEALTHY';
    const result = plan({ units: baseUnitsWebApi(), declared });
    assert.equal(
      result.steps.find((s) => s.stepType === 'DEPLOY_API')?.decision,
      'EXECUTE',
    );
  });

  it('9. ACTIVE DNS but wrong observed value → repair', () => {
    const result = plan({
      units: baseUnitsWebApi(),
      declared: liveDeclared(),
      observed: {
        serverObservedReady: true,
        containerObservedRunning: { 'unit-api': true, 'unit-web': true },
        healthObserved2xx: { 'unit-api': true, 'unit-web': true },
        dnsObservedCorrect: { 'unit-api': false, 'unit-web': true },
        certificateObservedValid: true,
        gatewayObservedListening: true,
      },
    });
    const dns = result.steps.find(
      (s) => s.stepType === 'APPLY_API_DNS' && s.reconcileKey === 'unit-api',
    );
    assert.equal(dns?.decision, 'EXECUTE');
  });

  it('10. billable step requires confirmation', () => {
    assert.equal(getLaunchStepPolicy('PROVISION_SERVER')?.requiresConfirmation, true);
    assert.equal(getLaunchStepPolicy('PROVISION_SERVER')?.billable, true);
    assert.equal(getLaunchStepPolicy('DEPLOY_WEB')?.billable, false);
    assert.equal(getLaunchStepPolicy('DEPLOY_WEB')?.requiresConfirmation, false);
  });

  it('11. duplicate click lock key', () => {
    assert.equal(launchProjectLockKey('p1', 'e1'), 'launch:p1:e1');
    assert.ok(ACTIVE_LAUNCH_RUN_STATUSES.includes('RUNNING'));
    assert.ok(ACTIVE_LAUNCH_RUN_STATUSES.includes('WAITING_CONFIRMATION'));
  });

  it('12. resume after crash — billable RUNNING must reconcile', () => {
    const action = planResumeStep({
      stepType: 'PROVISION_SERVER',
      stepStatus: 'RUNNING',
      billable: true,
      observedResourceExists: null,
    });
    assert.equal(action.action, 'RECONCILE_PROVIDER');
  });

  it('13. provider timeout reconcile', () => {
    assert.equal(classifyLaunchFailure('PROVIDER_TIMEOUT'), 'RETRYABLE');
    const action = planResumeStep({
      stepType: 'PROVISION_SERVER',
      stepStatus: 'RUNNING',
      billable: true,
      failureCode: 'PROVIDER_TIMEOUT',
    });
    assert.equal(action.action, 'RECONCILE_PROVIDER');
  });

  it('14. user-code failure waits for user', () => {
    assert.equal(classifyLaunchFailure('INVALID_USER_CODE'), 'USER_ACTION_REQUIRED');
    const action = planResumeStep({
      stepType: 'BUILD_UNIT',
      stepStatus: 'FAILED',
      billable: false,
      failureCode: 'BUILD_FAIL',
    });
    assert.equal(action.action, 'WAIT_USER');
  });

  it('15. no auto code modification', () => {
    assert.equal(LAUNCH_USER_CODE_POLICY.autoModifySource, false);
    assert.equal(LAUNCH_USER_CODE_POLICY.produceFixPrompt, true);
  });

  it('16. no secrets in events', () => {
    assert.doesNotThrow(() =>
      assertLaunchEventSafe({ projectId: 'p1', stepType: 'DEPLOY_API' }),
    );
    assert.throws(() => assertLaunchEventSafe({ password: 'x' }));
    assert.throws(() => assertLaunchEventSafe({ note: 'DATABASE_URL=postgres://' }));
  });

  it('17. plan stale detection', () => {
    const a = { serverId: 's1', postgresqlStatus: 'CONNECTED', redisStatus: 'CONNECTED', accessEntryStatus: 'ACTIVE', unitIds: ['a'] };
    const b = { ...a, serverId: 's2' };
    assert.equal(detectPlanStale(a, a).stale, false);
    assert.equal(detectPlanStale(a, b).stale, true);
  });

  it('18. stage progress weighting', () => {
    const live = plan({ units: baseUnitsWebApi(), declared: liveDeclared() });
    assert.ok(live.progress.progressPercent >= 70);
    const weights = live.progress.stages.reduce((n, s) => n + s.weight, 0);
    assert.equal(weights, 100);
    const emptyProgress = computeLaunchProgress([]);
    assert.equal(emptyProgress.progressPercent, 100); // all stages skipped
  });

  it('19. Phase 1 real execution refused constant', () => {
    assert.equal(STEP30_REAL_EXECUTION_LOCKED, 'STEP30_REAL_EXECUTION_LOCKED');
    assert.equal(STEP30_PHASE1_WRITE_COMMANDS, false);
    assert.match(
      launchErrorUserMessage(STEP30_REAL_EXECUTION_LOCKED),
      /下一阶段|上线计划/,
    );
  });

  it('Chinese stage labels present', () => {
    const result = plan({ units: baseUnitsWebApi(), declared: liveDeclared() });
    assert.ok(result.stages.some((s) => s.labelZh === '部署应用'));
  });
});
