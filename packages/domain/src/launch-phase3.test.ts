/**
 * Step 30 Phase 3 — verify-only real executor fixtures (no network required).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildLaunchPlan } from './launch-orchestrator.js';
import {
  assertPhase3VerifyOnlyPlan,
  PHASE3_VERIFY_ONLY_WRITE_FORBIDDEN,
  PHASE3_WHITELIST_PROJECT_ID,
  LAUNCH_ALREADY_RUNNING,
} from './launch-phase3-verify-only.js';
import { executeLaunchRun, type LaunchRunPersistence } from './launch-run-executor.js';
import type { PublicHttpsVerifyResult } from './launch-https-verify.js';

function livePlan() {
  return buildLaunchPlan({
    projectId: PHASE3_WHITELIST_PROJECT_ID,
    environmentId: 'env-1',
    units: [
      {
        id: 'cmu3j272x0005ri7wlxlbajeu',
        name: 'API',
        type: 'API',
        deployable: true,
        status: 'CONFIRMED',
        requiresPostgresql: true,
        requiresRedis: true,
      },
      {
        id: 'cmu3j27340007ri7wcno1xrai',
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
      postgresql: { required: true, status: 'CONNECTED', connectionId: 'db' },
      redis: { required: true, status: 'CONNECTED', connectionId: 'redis' },
      server: {
        id: 'cmub78pz001sdripco5pexhdz',
        status: 'READY',
        dockerStatus: 'READY',
        compatible: true,
      },
      units: [
        {
          unitId: 'cmu3j272x0005ri7wlxlbajeu',
          type: 'API',
          artifactReady: true,
          serviceStatus: 'RUNNING',
          healthStatus: 'HEALTHY',
          serviceInstanceId: 'cmuc66642002hritk6h3cbwhe',
          gatewayStatus: 'ACTIVE',
          gatewayHostname: 'api-launchos.zsaos.com',
          dnsStatus: 'ACTIVE',
          certificateValid: true,
        },
        {
          unitId: 'cmu3j27340007ri7wcno1xrai',
          type: 'WEB',
          artifactReady: true,
          serviceStatus: 'RUNNING',
          healthStatus: 'HEALTHY',
          serviceInstanceId: 'cmucaxah704r9ritkb30z16uw',
          gatewayStatus: 'ACTIVE',
          gatewayHostname: 'web-launchos.zsaos.com',
          dnsStatus: 'ACTIVE',
          certificateValid: true,
        },
      ],
      accessEntryStatus: 'ACTIVE',
    },
    observed: {
      serverObservedReady: true,
      containerObservedRunning: {
        cmu3j272x0005ri7wlxlbajeu: true,
        cmu3j27340007ri7wcno1xrai: true,
      },
      healthObserved2xx: {
        cmu3j272x0005ri7wlxlbajeu: true,
        cmu3j27340007ri7wcno1xrai: true,
      },
      dnsObservedCorrect: {
        cmu3j272x0005ri7wlxlbajeu: true,
        cmu3j27340007ri7wcno1xrai: true,
      },
      certificateObservedValid: true,
      gatewayObservedListening: true,
    },
  });
}

function okHttps(hostname: string, url: string): PublicHttpsVerifyResult {
  return {
    ok: true,
    hostname,
    url,
    dnsCorrect: true,
    dnsAddresses: ['116.62.198.184'],
    tcp443: true,
    tlsOk: true,
    certificateValid: true,
    daysRemaining: 60,
    httpStatus: 200,
    failureCode: null,
    failureMessage: null,
    bodySnippetSafe: 'ok',
  };
}

function memoryPersistence(lockOk = true): LaunchRunPersistence & {
  events: string[];
  runs: string[];
} {
  const events: string[] = [];
  const runs: string[] = [];
  let held = false;
  return {
    events,
    runs,
    async acquireLaunchLock() {
      if (!lockOk || held) return false;
      held = true;
      return true;
    },
    async releaseLaunchLock() {
      held = false;
    },
    async updateRun(input) {
      runs.push(input.status);
    },
    async updateStep() {},
    async appendAudit(event) {
      events.push(event);
    },
  };
}

describe('step30 phase3 first real verify-only', () => {
  it('whitelist plan is verify-only', () => {
    const plan = livePlan();
    const check = assertPhase3VerifyOnlyPlan(PHASE3_WHITELIST_PROJECT_ID, plan);
    assert.equal(check.ok, true);
    assert.equal(check.verifyOnlyPlan, true);
    assert.deepEqual(check.writeCapableExecuteSteps, []);
    assert.ok(check.executableSteps.includes('FINAL_ACCEPTANCE'));
  });

  it('1. API public HTTPS verify fail → FAILED, counters zero', async () => {
    const plan = livePlan();
    const persistence = memoryPersistence();
    const result = await executeLaunchRun({
      launchRunId: 'run-fail-api',
      projectId: PHASE3_WHITELIST_PROJECT_ID,
      environmentId: 'env-1',
      planVersion: plan.planVersion,
      plan,
      steps: plan.steps.map((s, i) => ({
        id: `s${i}`,
        stage: s.stage,
        stepType: s.stepType,
        status: s.decision === 'EXECUTE' ? 'READY' : 'SKIPPED',
        decision: s.decision,
        dependsOn: s.dependsOn,
        reconcileKey: s.reconcileKey,
        resourceType: s.resourceType,
        resourceId: s.resourceId,
      })),
      currentInputSnapshot: plan.inputSnapshot,
      persistence,
      declared: {
        postgresqlConnected: true,
        redisConnected: true,
        serverReady: true,
        apiRunningHealthy: true,
        webRunningHealthy: true,
        apiGatewayActive: true,
        webGatewayActive: true,
        accessEntryActive: true,
        dynamicPortsPrivate: true,
      },
      verifyApi: async () => ({
        ...okHttps('api-launchos.zsaos.com', 'https://api-launchos.zsaos.com/health'),
        ok: false,
        httpStatus: 500,
        failureCode: 'HTTPS_STATUS_UNEXPECTED',
        failureMessage: '500',
      }),
      verifyWeb: async () => ({
        ...okHttps('web-launchos.zsaos.com', 'https://web-launchos.zsaos.com/'),
        publicApiUrlPresent: true,
      }),
    });
    assert.equal(result.VERIFY_API_HTTPS, 'FAILED');
    assert.notEqual(result.FINAL_ACCEPTANCE, 'SUCCESS');
    assert.equal(result.writeCounters.cloudProviderWriteCount, 0);
    assert.equal(result.WRITE_COMMANDS_EXECUTED_THIS_RUN, false);
  });

  it('2. Web verify fail → FINAL not SUCCESS', async () => {
    const plan = livePlan();
    const result = await executeLaunchRun({
      launchRunId: 'run-fail-web',
      projectId: PHASE3_WHITELIST_PROJECT_ID,
      environmentId: 'env-1',
      planVersion: plan.planVersion,
      plan,
      steps: plan.steps.map((s, i) => ({
        id: `s${i}`,
        stage: s.stage,
        stepType: s.stepType,
        status: s.decision === 'EXECUTE' ? 'READY' : 'SKIPPED',
        decision: s.decision,
        dependsOn: s.dependsOn,
        reconcileKey: s.reconcileKey,
        resourceType: s.resourceType,
        resourceId: s.resourceId,
      })),
      currentInputSnapshot: plan.inputSnapshot,
      persistence: memoryPersistence(),
      declared: {
        postgresqlConnected: true,
        redisConnected: true,
        serverReady: true,
        apiRunningHealthy: true,
        webRunningHealthy: true,
        apiGatewayActive: true,
        webGatewayActive: true,
        accessEntryActive: true,
        dynamicPortsPrivate: true,
      },
      verifyApi: async () => okHttps('api-launchos.zsaos.com', 'https://api-launchos.zsaos.com/health'),
      verifyWeb: async () => ({
        ...okHttps('web-launchos.zsaos.com', 'https://web-launchos.zsaos.com/'),
        ok: false,
        failureCode: 'HTTPS_STATUS_UNEXPECTED',
        failureMessage: 'fail',
        publicApiUrlPresent: null,
      }),
    });
    assert.equal(result.VERIFY_WEB_HTTPS, 'FAILED');
    assert.notEqual(result.FINAL_ACCEPTANCE, 'SUCCESS');
  });

  it('3. DNS drift during execution', async () => {
    const plan = livePlan();
    const result = await executeLaunchRun({
      launchRunId: 'run-dns',
      projectId: PHASE3_WHITELIST_PROJECT_ID,
      environmentId: 'env-1',
      planVersion: plan.planVersion,
      plan,
      steps: plan.steps.map((s, i) => ({
        id: `s${i}`,
        stage: s.stage,
        stepType: s.stepType,
        status: s.decision === 'EXECUTE' ? 'READY' : 'SKIPPED',
        decision: s.decision,
        dependsOn: s.dependsOn,
        reconcileKey: s.reconcileKey,
        resourceType: s.resourceType,
        resourceId: s.resourceId,
      })),
      currentInputSnapshot: plan.inputSnapshot,
      persistence: memoryPersistence(),
      declared: {
        postgresqlConnected: true,
        redisConnected: true,
        serverReady: true,
        apiRunningHealthy: true,
        webRunningHealthy: true,
        apiGatewayActive: true,
        webGatewayActive: true,
        accessEntryActive: true,
        dynamicPortsPrivate: true,
      },
      verifyApi: async () => ({
        ...okHttps('api-launchos.zsaos.com', 'https://api-launchos.zsaos.com/health'),
        ok: false,
        dnsCorrect: false,
        failureCode: 'DNS_DRIFT_WRONG_VALUE',
        failureMessage: 'dns',
      }),
      verifyWeb: async () => ({
        ...okHttps('web-launchos.zsaos.com', 'https://web-launchos.zsaos.com/'),
        publicApiUrlPresent: true,
      }),
    });
    assert.equal(result.desiredStateSatisfied, false);
    assert.equal(result.apiPublicHttps?.failureCode, 'DNS_DRIFT_WRONG_VALUE');
  });

  it('4. certificate invalid during execution', async () => {
    const plan = livePlan();
    const result = await executeLaunchRun({
      launchRunId: 'run-cert',
      projectId: PHASE3_WHITELIST_PROJECT_ID,
      environmentId: 'env-1',
      planVersion: plan.planVersion,
      plan,
      steps: plan.steps.map((s, i) => ({
        id: `s${i}`,
        stage: s.stage,
        stepType: s.stepType,
        status: s.decision === 'EXECUTE' ? 'READY' : 'SKIPPED',
        decision: s.decision,
        dependsOn: s.dependsOn,
        reconcileKey: s.reconcileKey,
        resourceType: s.resourceType,
        resourceId: s.resourceId,
      })),
      currentInputSnapshot: plan.inputSnapshot,
      persistence: memoryPersistence(),
      declared: {
        postgresqlConnected: true,
        redisConnected: true,
        serverReady: true,
        apiRunningHealthy: true,
        webRunningHealthy: true,
        apiGatewayActive: true,
        webGatewayActive: true,
        accessEntryActive: true,
        dynamicPortsPrivate: true,
      },
      verifyApi: async () => ({
        ...okHttps('api-launchos.zsaos.com', 'https://api-launchos.zsaos.com/health'),
        ok: false,
        tlsOk: false,
        certificateValid: false,
        failureCode: 'CERTIFICATE_INVALID',
        failureMessage: 'cert',
      }),
      verifyWeb: async () => ({
        ...okHttps('web-launchos.zsaos.com', 'https://web-launchos.zsaos.com/'),
        publicApiUrlPresent: true,
      }),
    });
    assert.equal(result.VERIFY_API_HTTPS, 'FAILED');
  });

  it('5. plan stale before execution → throws, no handlers', async () => {
    const plan = livePlan();
    await assert.rejects(
      () =>
        executeLaunchRun({
          launchRunId: 'run-stale',
          projectId: PHASE3_WHITELIST_PROJECT_ID,
          environmentId: 'env-1',
          planVersion: plan.planVersion,
          plan,
          steps: plan.steps.map((s, i) => ({
            id: `s${i}`,
            stage: s.stage,
            stepType: s.stepType,
            status: 'READY',
            decision: s.decision,
            dependsOn: s.dependsOn,
            reconcileKey: s.reconcileKey,
            resourceType: null,
            resourceId: null,
          })),
          currentInputSnapshot: { ...plan.inputSnapshot, serverId: 'changed' },
          persistence: memoryPersistence(),
          declared: {
            postgresqlConnected: true,
            redisConnected: true,
            serverReady: true,
            apiRunningHealthy: true,
            webRunningHealthy: true,
            apiGatewayActive: true,
            webGatewayActive: true,
            accessEntryActive: true,
            dynamicPortsPrivate: true,
          },
        }),
      /PLAN_STALE/,
    );
  });

  it('6. concurrent LaunchRun rejected', async () => {
    const plan = livePlan();
    await assert.rejects(
      () =>
        executeLaunchRun({
          launchRunId: 'run-lock',
          projectId: PHASE3_WHITELIST_PROJECT_ID,
          environmentId: 'env-1',
          planVersion: plan.planVersion,
          plan,
          steps: plan.steps.map((s, i) => ({
            id: `s${i}`,
            stage: s.stage,
            stepType: s.stepType,
            status: 'READY',
            decision: s.decision,
            dependsOn: s.dependsOn,
            reconcileKey: s.reconcileKey,
            resourceType: null,
            resourceId: null,
          })),
          currentInputSnapshot: plan.inputSnapshot,
          persistence: memoryPersistence(false),
          declared: {
            postgresqlConnected: true,
            redisConnected: true,
            serverReady: true,
            apiRunningHealthy: true,
            webRunningHealthy: true,
            apiGatewayActive: true,
            webGatewayActive: true,
            accessEntryActive: true,
            dynamicPortsPrivate: true,
          },
        }),
      new RegExp(LAUNCH_ALREADY_RUNNING),
    );
  });

  it('7-9. success path: events safe, writes zero, progress 100', async () => {
    const plan = livePlan();
    const persistence = memoryPersistence();
    const result = await executeLaunchRun({
      launchRunId: 'run-ok',
      projectId: PHASE3_WHITELIST_PROJECT_ID,
      environmentId: 'env-1',
      planVersion: plan.planVersion,
      plan,
      steps: plan.steps.map((s, i) => ({
        id: `s${i}`,
        stage: s.stage,
        stepType: s.stepType,
        status: s.decision === 'EXECUTE' ? 'READY' : 'SKIPPED',
        decision: s.decision,
        dependsOn: s.dependsOn,
        reconcileKey: s.reconcileKey,
        resourceType: s.resourceType,
        resourceId: s.resourceId,
      })),
      currentInputSnapshot: plan.inputSnapshot,
      persistence,
      declared: {
        postgresqlConnected: true,
        redisConnected: true,
        serverReady: true,
        apiRunningHealthy: true,
        webRunningHealthy: true,
        apiGatewayActive: true,
        webGatewayActive: true,
        accessEntryActive: true,
        dynamicPortsPrivate: true,
      },
      verifyApi: async () => okHttps('api-launchos.zsaos.com', 'https://api-launchos.zsaos.com/health'),
      verifyWeb: async () => ({
        ...okHttps('web-launchos.zsaos.com', 'https://web-launchos.zsaos.com/'),
        publicApiUrlPresent: true,
      }),
    });
    assert.equal(result.finalStatus, 'SUCCESS');
    assert.equal(result.VERIFY_API_HTTPS, 'SUCCESS');
    assert.equal(result.VERIFY_WEB_HTTPS, 'SUCCESS');
    assert.equal(result.FINAL_ACCEPTANCE, 'SUCCESS');
    assert.equal(result.progressPercent, 100);
    assert.equal(result.desiredStateSatisfied, true);
    assert.ok(persistence.events.includes('LAUNCH_EXECUTION_STARTED'));
    assert.ok(persistence.events.includes('LAUNCH_SUCCESS'));
    assert.equal(result.writeCounters.deploymentEnqueueCount, 0);
    assert.equal(result.writeCounters.gatewayWriteCount, 0);
    assert.equal(result.writeCounters.dnsWriteCount, 0);
    assert.ok(result.writeCounters.launchStateWriteCount > 0);
    assert.equal(result.finalAcceptanceWaitedForDependencies, true);
  });

  it('non-whitelist project forbidden', () => {
    const plan = livePlan();
    const check = assertPhase3VerifyOnlyPlan('other-project', plan);
    assert.equal(check.ok, false);
    assert.ok(
      check.blockers.some((b) => b.code === 'PHASE3_PROJECT_NOT_WHITELISTED') ||
        check.blockers.some((b) => b.code === PHASE3_VERIFY_ONLY_WRITE_FORBIDDEN),
    );
  });
});
