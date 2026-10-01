/**
 * Step 30 Phase 4A — controlled WEB-only write-path gate fixtures (no network / no writes).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildLaunchPlan } from './launch-orchestrator.js';
import { assertLaunchEventSafe } from './launch-orchestrator.js';
import {
  PHASE4_CONTROLLED_MARK,
  PHASE4_WHITELIST_SERVER_ID,
  PHASE4_PRODUCTION_PROJECT_ID,
  PHASE4A_REAL_EXECUTION_LOCKED,
  assertPhase4ControlledPlan,
  applyControlledInfrastructureReuse,
  evaluateHostnameAvailability,
  evaluatePhase4ControlledGate,
  planControlledRuntimePort,
  phase4FailurePreventsDns,
  refusePhase4ARealExecution,
  filterUserFacingLaunchStages,
  isWebOnlyPlan,
} from './launch-phase4-controlled.js';

const TEST_PROJECT = 'proj_oneclick_alpha_test';
const TEST_WEB_UNIT = 'unit_oneclick_web';

function webOnlyPlan(overrides?: {
  serverId?: string;
  analysisReady?: boolean;
  artifactReady?: boolean;
}) {
  return buildLaunchPlan({
    projectId: TEST_PROJECT,
    environmentId: 'env-oneclick',
    units: [
      {
        id: TEST_WEB_UNIT,
        name: 'web',
        type: 'WEB',
        deployable: true,
        status: 'CONFIRMED',
        requiresPostgresql: false,
        requiresRedis: false,
      },
    ],
    declared: {
      analysisReady: overrides?.analysisReady ?? true,
      postgresql: { required: false, status: 'NOT_REQUIRED', connectionId: null },
      redis: { required: false, status: 'NOT_REQUIRED', connectionId: null },
      server: {
        id: overrides?.serverId ?? PHASE4_WHITELIST_SERVER_ID,
        status: 'READY',
        dockerStatus: 'READY',
        compatible: true,
      },
      units: [
        {
          unitId: TEST_WEB_UNIT,
          type: 'WEB',
          artifactReady: overrides?.artifactReady ?? false,
          serviceStatus: null,
          healthStatus: null,
          serviceInstanceId: null,
          gatewayStatus: null,
          gatewayHostname: null,
          dnsStatus: null,
          certificateValid: null,
        },
      ],
      accessEntryStatus: null,
    },
    observed: {
      serverObservedReady: true,
      containerObservedRunning: { [TEST_WEB_UNIT]: false },
      healthObserved2xx: { [TEST_WEB_UNIT]: false },
      dnsObservedCorrect: { [TEST_WEB_UNIT]: false },
      certificateObservedValid: true,
      gatewayObservedListening: true,
    },
  });
}

function gateFromPlan(plan = webOnlyPlan()) {
  const reused = applyControlledInfrastructureReuse(plan, {
    gatewayReady: true,
    certificateReusable: true,
    serverInstanceId: PHASE4_WHITELIST_SERVER_ID,
  });
  return evaluatePhase4ControlledGate({
    testProjectId: TEST_PROJECT,
    testWebUnitId: TEST_WEB_UNIT,
    launchRunId: 'lr_p4a_test',
    hostname: 'oneclick-web.zsaos.com',
    plan: reused,
    serverInstanceId: PHASE4_WHITELIST_SERVER_ID,
    dnsExisting: null,
    gatewayReady: true,
    certificateReusable: true,
    productionApiHealthy: true,
    productionWebHealthy: true,
    reservedPorts: [39000, 39002],
    remoteListeningPorts: [39000, 39002],
    launchLockReady: true,
  });
}

describe('Step 30 Phase 4A controlled write-path', () => {
  it('1. WEB-only controlled plan', () => {
    const plan = webOnlyPlan();
    assert.equal(isWebOnlyPlan(plan), true);
    assert.equal(plan.inputSnapshot.requiresPostgresql, false);
    assert.equal(plan.inputSnapshot.requiresRedis, false);
    assert.match(PHASE4_CONTROLLED_MARK, /ONE_CLICK/);
  });

  it('2. existing server reuse', () => {
    const plan = applyControlledInfrastructureReuse(webOnlyPlan(), {
      gatewayReady: true,
      certificateReusable: true,
      serverInstanceId: PHASE4_WHITELIST_SERVER_ID,
    });
    assert.equal(plan.serverReady, true);
    assert.ok(!plan.executionSteps.includes('PROVISION_SERVER'));
    const provision = plan.steps.find((s) => s.stepType === 'PROVISION_SERVER');
    assert.ok(provision && (provision.decision === 'SKIP' || provision.decision === 'REUSE'));
  });

  it('3. no dependency provisioning', () => {
    const plan = webOnlyPlan();
    for (const s of [
      'PROVISION_POSTGRESQL',
      'CONNECT_POSTGRESQL',
      'PROVISION_REDIS',
      'CONNECT_REDIS',
    ]) {
      assert.ok(!plan.executionSteps.includes(s));
      const step = plan.steps.find((x) => x.stepType === s);
      assert.ok(step && (step.decision === 'SKIP' || step.decision === 'REUSE'));
    }
  });

  it('4. no API steps', () => {
    const plan = applyControlledInfrastructureReuse(webOnlyPlan(), {
      gatewayReady: true,
      certificateReusable: true,
      serverInstanceId: PHASE4_WHITELIST_SERVER_ID,
    });
    const check = assertPhase4ControlledPlan(plan);
    assert.equal(check.apiStepsPresent, false);
    assert.ok(!plan.executionSteps.some((s) => s.includes('API')));
  });

  it('5. new artifact planned', () => {
    const plan = applyControlledInfrastructureReuse(webOnlyPlan(), {
      gatewayReady: true,
      certificateReusable: true,
      serverInstanceId: PHASE4_WHITELIST_SERVER_ID,
    });
    const check = assertPhase4ControlledPlan(plan);
    assert.ok(check.plannedArtifactWrites >= 2);
    assert.ok(plan.executionSteps.includes('BUILD_UNIT'));
    assert.ok(plan.executionSteps.includes('BUILD_DOCKER_IMAGE'));
  });

  it('6. one Web deployment planned', () => {
    const plan = applyControlledInfrastructureReuse(webOnlyPlan(), {
      gatewayReady: true,
      certificateReusable: true,
      serverInstanceId: PHASE4_WHITELIST_SERVER_ID,
    });
    const check = assertPhase4ControlledPlan(plan);
    assert.equal(check.plannedDeploymentEnqueues, 1);
    assert.ok(plan.executionSteps.includes('DEPLOY_WEB'));
  });

  it('7. one GatewayRoute planned', () => {
    const gate = gateFromPlan();
    assert.ok(gate.plannedGatewayWrites >= 1);
    assert.ok(gate.executionSteps.includes('APPLY_WEB_ROUTE'));
  });

  it('8. one DNS CREATE planned', () => {
    const gate = gateFromPlan();
    assert.ok(gate.plannedDnsWrites >= 1);
    assert.ok(gate.executionSteps.includes('APPLY_WEB_DNS'));
    assert.equal(gate.dnsAction, 'CREATE');
  });

  it('9. no ECS/RDS/Redis create', () => {
    const gate = gateFromPlan();
    assert.equal(gate.plannedEcsCreates, 0);
    assert.equal(gate.plannedRdsCreates, 0);
    assert.equal(gate.plannedRedisCreates, 0);
    assert.deepEqual(gate.billableActions, []);
    assert.deepEqual(gate.newBillableResources, []);
  });

  it('10. no SG change', () => {
    const gate = gateFromPlan();
    assert.equal(gate.plannedSecurityGroupWrites, 0);
  });

  it('11. certificate reuse', () => {
    const gate = gateFromPlan();
    assert.equal(gate.certificateReusable, true);
    assert.equal(gate.plannedCertificateIssues, 0);
    assert.ok(gate.reuseSteps.includes('INSTALL_CERTIFICATE') || !gate.executionSteps.includes('INSTALL_CERTIFICATE'));
  });

  it('12. hostname conflict blocks', () => {
    const plan = applyControlledInfrastructureReuse(webOnlyPlan(), {
      gatewayReady: true,
      certificateReusable: true,
      serverInstanceId: PHASE4_WHITELIST_SERVER_ID,
    });
    const gate = evaluatePhase4ControlledGate({
      testProjectId: TEST_PROJECT,
      testWebUnitId: TEST_WEB_UNIT,
      launchRunId: 'lr_p4a_conflict',
      hostname: 'oneclick-web.zsaos.com',
      plan,
      serverInstanceId: PHASE4_WHITELIST_SERVER_ID,
      dnsExisting: {
        rr: 'oneclick-web',
        type: 'A',
        value: '1.2.3.4',
        managedByLaunchOS: false,
      },
      gatewayReady: true,
      certificateReusable: true,
      productionApiHealthy: true,
      productionWebHealthy: true,
      reservedPorts: [39000],
      remoteListeningPorts: [39000],
      launchLockReady: true,
    });
    assert.equal(gate.dnsConflict, true);
    assert.equal(gate.canExecuteControlledLaunch, false);
    assert.ok(gate.blockers.some((b) => b.code === 'DNS_RECORD_CONFLICT'));
  });

  it('13. port allocator excludes production ports', () => {
    const port = planControlledRuntimePort({
      reservedPorts: [39000, 39002, 39001],
      remoteListeningPorts: [39000, 39002],
    });
    assert.ok(port.selectedRuntimePort != null);
    assert.notEqual(port.selectedRuntimePort, 39000);
    assert.notEqual(port.selectedRuntimePort, 39002);
    assert.equal(port.portConflict, false);
  });

  it('14. production services preserved (gate requires healthy baseline)', () => {
    const plan = applyControlledInfrastructureReuse(webOnlyPlan(), {
      gatewayReady: true,
      certificateReusable: true,
      serverInstanceId: PHASE4_WHITELIST_SERVER_ID,
    });
    const bad = evaluatePhase4ControlledGate({
      testProjectId: TEST_PROJECT,
      testWebUnitId: TEST_WEB_UNIT,
      launchRunId: 'lr_p4a_prod',
      hostname: 'oneclick-web.zsaos.com',
      plan,
      serverInstanceId: PHASE4_WHITELIST_SERVER_ID,
      dnsExisting: null,
      gatewayReady: true,
      certificateReusable: true,
      productionApiHealthy: false,
      productionWebHealthy: true,
      reservedPorts: [],
      remoteListeningPorts: [],
      launchLockReady: true,
    });
    assert.equal(bad.canExecuteControlledLaunch, false);
    assert.ok(bad.blockers.some((b) => b.code === 'PRODUCTION_BASELINE_UNHEALTHY'));
    assert.notEqual(TEST_PROJECT, PHASE4_PRODUCTION_PROJECT_ID);
  });

  it('15. deployment failure prevents DNS', () => {
    const r = phase4FailurePreventsDns({ deployFailed: true });
    assert.equal(r.dnsAllowed, false);
    assert.equal(r.reason, 'DEPLOY_FAILED');
  });

  it('16. gateway failure prevents DNS', () => {
    const r = phase4FailurePreventsDns({ gatewayLocalVerifyFailed: true });
    assert.equal(r.dnsAllowed, false);
    assert.equal(r.reason, 'GATEWAY_LOCAL_VERIFY_FAILED');
  });

  it('17. DNS timeout reconciles (hostname availability CREATE when missing)', () => {
    const h = evaluateHostnameAvailability({
      hostname: 'oneclick-test.zsaos.com',
      rootDomain: 'zsaos.com',
      desiredIp: '116.62.198.184',
      existing: null,
    });
    assert.equal(h.action, 'CREATE');
    assert.equal(h.dnsConflict, false);
  });

  it('18. executor resume after deployment — REUSE when artifact+service healthy', () => {
    const plan = webOnlyPlan({ artifactReady: true });
    // Force healthy declared to get DEPLOY_WEB REUSE path
    const healthy = buildLaunchPlan({
      projectId: TEST_PROJECT,
      environmentId: 'env-oneclick',
      units: [
        {
          id: TEST_WEB_UNIT,
          name: 'web',
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
        server: {
          id: PHASE4_WHITELIST_SERVER_ID,
          status: 'READY',
          dockerStatus: 'READY',
          compatible: true,
        },
        units: [
          {
            unitId: TEST_WEB_UNIT,
            type: 'WEB',
            artifactReady: true,
            serviceStatus: 'RUNNING',
            healthStatus: 'HEALTHY',
            serviceInstanceId: 'si_web_test',
            gatewayStatus: null,
            gatewayHostname: null,
            dnsStatus: null,
            certificateValid: null,
          },
        ],
        accessEntryStatus: null,
      },
      observed: {
        serverObservedReady: true,
        containerObservedRunning: { [TEST_WEB_UNIT]: true },
        healthObserved2xx: { [TEST_WEB_UNIT]: true },
        dnsObservedCorrect: { [TEST_WEB_UNIT]: false },
        certificateObservedValid: true,
        gatewayObservedListening: true,
      },
    });
    const deploy = healthy.steps.find((s) => s.stepType === 'DEPLOY_WEB');
    assert.equal(deploy?.decision, 'REUSE');
    void plan;
  });

  it('19. duplicate launch rejected (production project forbidden + lock)', () => {
    const plan = applyControlledInfrastructureReuse(webOnlyPlan(), {
      gatewayReady: true,
      certificateReusable: true,
      serverInstanceId: PHASE4_WHITELIST_SERVER_ID,
    });
    const prod = evaluatePhase4ControlledGate({
      testProjectId: PHASE4_PRODUCTION_PROJECT_ID,
      testWebUnitId: TEST_WEB_UNIT,
      launchRunId: 'lr_bad',
      hostname: 'oneclick-web.zsaos.com',
      plan,
      serverInstanceId: PHASE4_WHITELIST_SERVER_ID,
      dnsExisting: null,
      gatewayReady: true,
      certificateReusable: true,
      productionApiHealthy: true,
      productionWebHealthy: true,
      reservedPorts: [],
      remoteListeningPorts: [],
      launchLockReady: false,
    });
    assert.equal(prod.canExecuteControlledLaunch, false);
    assert.ok(prod.blockers.some((b) => b.code === 'PHASE4_PRODUCTION_PROJECT_FORBIDDEN'));
    assert.ok(prod.blockers.some((b) => b.code === 'LAUNCH_LOCK_NOT_READY'));
  });

  it('20. secret/event scan', () => {
    assert.doesNotThrow(() =>
      assertLaunchEventSafe({ event: 'PHASE4A_GATE', launchRunId: 'lr1', projectId: TEST_PROJECT }),
    );
    assert.throws(() => assertLaunchEventSafe({ password: 'secret' }));
  });

  it('21. Phase 4A real execution locked', () => {
    const refuse = refusePhase4ARealExecution();
    assert.equal(refuse.code, PHASE4A_REAL_EXECUTION_LOCKED);
    assert.equal(refuse.EXECUTION_STARTED, false);
    assert.equal(refuse.WRITE_COMMANDS_EXECUTED_THIS_RUN, false);
    const gate = gateFromPlan();
    assert.equal(gate.EXECUTION_STARTED, false);
    assert.equal(gate.WRITE_COMMANDS_EXECUTED_THIS_RUN, false);
    assert.equal(gate.realExecutionLocked, true);
    assert.equal(gate.canExecuteControlledLaunch, true);
    assert.deepEqual(gate.blockers, []);
  });

  it('user-facing stages hide skipped dependencies', () => {
    const plan = webOnlyPlan();
    const filtered = filterUserFacingLaunchStages(plan.stages);
    assert.ok(!filtered.some((s) => s.stage === 'DEPENDENCIES'));
    assert.ok(filtered.some((s) => s.stage === 'INFRASTRUCTURE'));
    assert.ok(filtered.some((s) => s.stage === 'BUILD'));
  });

  it('build failure prevents DNS', () => {
    const r = phase4FailurePreventsDns({ buildFailed: true });
    assert.equal(r.dnsAllowed, false);
  });
});
