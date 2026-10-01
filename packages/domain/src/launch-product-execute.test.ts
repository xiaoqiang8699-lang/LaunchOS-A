import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { buildConfirmationPayload, createConfirmationRecord, hashConfirmationPayload } from './launch-confirmation.js';
import { buildLaunchPlan } from './launch-orchestrator.js';
import { assertPhase3VerifyOnlyPlan } from './launch-phase3-verify-only.js';
import { executeLaunchRun, type LaunchRunPersistence } from './launch-run-executor.js';
import {
  assertAlphaApplicationScope,
  canRoleExecuteLaunch,
  duplicateLaunchMessage,
  evaluateProductBillingGate,
  evaluateProductPlanFreshness,
} from './launch-product-execute.js';
import type { PublicHttpsVerifyResult } from './launch-https-verify.js';

const KNOWN = ['VERIFY_WEB_HTTPS', 'VERIFY_API_HTTPS', 'FINAL_ACCEPTANCE', 'BUILD_UNIT', 'DEPLOY_WEB'];

test('requiresConfirmation false allows execute gate', () => {
  const payload = buildConfirmationPayload({
    planVersion: 'v',
    projectId: 'p',
    environmentId: 'e',
    billableActions: [],
    resourcesToCreate: [],
  });
  const gate = evaluateProductBillingGate({
    requiresConfirmation: false,
    billableStepTypes: [],
    record: null,
    currentPayload: payload,
  });
  assert.equal(gate.ok, true);
});

test('billable action without confirmation is blocked', () => {
  const payload = buildConfirmationPayload({
    planVersion: 'v',
    projectId: 'p',
    environmentId: 'e',
    billableActions: [],
    resourcesToCreate: [{ kind: 'SERVER', labelZh: '服务器' }],
  });
  const gate = evaluateProductBillingGate({
    requiresConfirmation: true,
    billableStepTypes: ['PROVISION_SERVER'],
    record: null,
    currentPayload: payload,
  });
  assert.equal(gate.ok, false);
  assert.equal(gate.code, 'BILLABLE_ACTION_CONFIRMATION_REQUIRED');
  assert.match(gate.messageZh, /确认云资源费用/);
});

test('valid billable confirmation passes', () => {
  const payload = buildConfirmationPayload({
    planVersion: 'v',
    projectId: 'p',
    environmentId: 'e',
    billableActions: [
      {
        action: 'CREATE_ECS',
        stepType: 'PROVISION_SERVER',
        labelZh: '创建服务器',
        estimatedCostAvailable: false,
      },
    ],
    resourcesToCreate: [{ kind: 'SERVER', labelZh: '服务器' }],
  });
  const record = createConfirmationRecord({
    confirmationId: 'c1',
    confirmedByUserId: 'u',
    payload,
  });
  const gate = evaluateProductBillingGate({
    requiresConfirmation: true,
    billableStepTypes: ['PROVISION_SERVER'],
    record,
    currentPayload: payload,
  });
  assert.equal(gate.ok, true);
  assert.equal(record.confirmedPlanHash, hashConfirmationPayload(payload));
});

test('confirmation hash stale is blocked', () => {
  const payload = buildConfirmationPayload({
    planVersion: 'v',
    projectId: 'p',
    environmentId: 'e',
    billableActions: [
      {
        action: 'CREATE_RDS',
        stepType: 'PROVISION_POSTGRESQL',
        labelZh: '数据库',
        estimatedCostAvailable: false,
      },
    ],
    resourcesToCreate: [{ kind: 'DATABASE', labelZh: '数据库' }],
  });
  const record = createConfirmationRecord({
    confirmationId: 'c1',
    confirmedByUserId: 'u',
    payload,
  });
  const changed = { ...payload, resourcesToCreate: [{ kind: 'DATABASE', labelZh: '另一套数据库' }] };
  const gate = evaluateProductBillingGate({
    requiresConfirmation: true,
    billableStepTypes: ['PROVISION_POSTGRESQL'],
    record,
    currentPayload: changed,
  });
  assert.equal(gate.ok, false);
});

test('PLAN_STALE is blocked', () => {
  const fresh = evaluateProductPlanFreshness({
    savedSnapshot: { unitIds: ['u1'] },
    currentSnapshot: { unitIds: ['u1', 'u2'] },
  });
  assert.equal(fresh.ok, false);
  assert.equal(fresh.code, 'PLAN_STALE');
  assert.equal(fresh.messageZh, '上线计划发生变化，请重新确认。');
});

test('VIEWER cannot execute and MEMBER can', () => {
  assert.equal(canRoleExecuteLaunch('VIEWER'), false);
  assert.equal(canRoleExecuteLaunch('MEMBER'), true);
  assert.equal(canRoleExecuteLaunch('OWNER'), true);
  assert.equal(canRoleExecuteLaunch('ADMIN'), true);
});

test('duplicate launch message', () => {
  assert.equal(duplicateLaunchMessage().code, 'LAUNCH_ALREADY_RUNNING');
  assert.equal(duplicateLaunchMessage().messageZh, '应用正在上线，请稍候。');
});

test('supported Alpha WEB is allowed', () => {
  const scope = assertAlphaApplicationScope({
    unitTypes: ['WEB'],
    stepTypes: ['VERIFY_WEB_HTTPS', 'FINAL_ACCEPTANCE'],
    knownStepTypes: KNOWN,
  });
  assert.equal(scope.ok, true);
});

test('unsupported topology is rejected', () => {
  const scope = assertAlphaApplicationScope({
    unitTypes: ['WEB', 'WORKER'],
    stepTypes: ['VERIFY_WEB_HTTPS'],
    knownStepTypes: KNOWN,
  });
  assert.equal(scope.ok, false);
  assert.equal(scope.code, 'ALPHA_UNSUPPORTED_APPLICATION');
  assert.equal(scope.messageZh, '当前 Alpha 暂不支持这个应用结构。');
});

test('product service calls executeLaunchRun and not step-30 scripts', () => {
  const source = readFileSync(resolve(__dirname, '../../../apps/api/src/launch/launch.service.ts'), 'utf8');
  assert.match(source, /executeLaunchRun\(/);
  assert.doesNotMatch(source, /scripts\/step-30/);
  assert.doesNotMatch(source, /refuseRealExecution\(\)/);
});

function okHttps(hostname: string): PublicHttpsVerifyResult {
  return {
    ok: true,
    hostname,
    url: `https://${hostname}/`,
    dnsCorrect: true,
    dnsAddresses: ['116.62.198.184'],
    tcp443: true,
    tlsOk: true,
    certificateValid: true,
    daysRemaining: 70,
    httpStatus: 200,
    failureCode: null,
    failureMessage: null,
    bodySnippetSafe: 'ok',
  };
}

function memoryPersistence(): LaunchRunPersistence & { events: string[] } {
  const events: string[] = [];
  let held = false;
  return {
    events,
    async acquireLaunchLock() {
      if (held) return false;
      held = true;
      return true;
    },
    async releaseLaunchLock() {
      held = false;
    },
    async updateRun() {},
    async updateStep() {},
    async appendAudit(event) {
      events.push(event);
    },
  };
}

test('alpha web verify-only plan invokes executeLaunchRun', async () => {
  const plan = buildLaunchPlan({
    projectId: 'cmucerx5e0001ri4w0x6sx5cz',
    environmentId: 'env-web',
    units: [
      {
        id: 'web-unit',
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
      postgresql: { required: false, status: 'NOT_REQUIRED', connectionId: null },
      redis: { required: false, status: 'NOT_REQUIRED', connectionId: null },
      server: { id: 'cmub78pz001sdripco5pexhdz', status: 'READY', dockerStatus: 'READY', compatible: true },
      units: [
        {
          unitId: 'web-unit',
          type: 'WEB',
          artifactReady: true,
          serviceStatus: 'RUNNING',
          healthStatus: 'HEALTHY',
          serviceInstanceId: 'si-web',
          gatewayStatus: 'ACTIVE',
          gatewayHostname: 'oneclick-web.zsaos.com',
          dnsStatus: 'ACTIVE',
          certificateValid: true,
        },
      ],
      accessEntryStatus: 'ACTIVE',
    },
    observed: {
      serverObservedReady: true,
      containerObservedRunning: { 'web-unit': true },
      healthObserved2xx: { 'web-unit': true },
      dnsObservedCorrect: { 'web-unit': true },
      certificateObservedValid: true,
      gatewayObservedListening: true,
    },
  });
  const check = assertPhase3VerifyOnlyPlan(plan.projectId, plan, { skipProjectWhitelist: true });
  assert.equal(check.ok, true);
  const persistence = memoryPersistence();
  const result = await executeLaunchRun({
    launchRunId: 'run-alpha-web',
    projectId: plan.projectId,
    environmentId: 'env-web',
    planVersion: plan.planVersion,
    plan,
    steps: plan.steps.map((s, i) => ({
      id: `s${i}`,
      stage: s.stage,
      stepType: s.stepType,
      status: s.decision === 'EXECUTE' ? 'PENDING' : 'SKIPPED',
      decision: s.decision,
      dependsOn: s.dependsOn,
      reconcileKey: s.reconcileKey,
      resourceType: s.resourceType,
      resourceId: s.resourceId,
    })),
    currentInputSnapshot: plan.inputSnapshot,
    persistence,
    productAlpha: true,
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
    verifyWeb: async () => ({ ...okHttps('oneclick-web.zsaos.com'), publicApiUrlPresent: null }),
  });
  assert.equal(result.finalStatus, 'SUCCESS');
  assert.equal(result.FINAL_ACCEPTANCE, 'SUCCESS');
  assert.ok(persistence.events.includes('LAUNCH_EXECUTION_STARTED'));
  assert.ok(persistence.events.includes('LAUNCH_SUCCESS'));
  assert.equal(result.writeCounters.deploymentEnqueueCount, 0);
  assert.equal(result.writeCounters.dnsWriteCount, 0);
  assert.equal(result.writeCounters.gatewayWriteCount, 0);
});
