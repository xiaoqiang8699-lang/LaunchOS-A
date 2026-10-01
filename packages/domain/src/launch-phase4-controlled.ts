/**
 * Step 30 Phase 4A — Controlled write-path one-click launch (WEB-only, server reuse).
 * Gate-only in Phase 4A: no artifact/deploy/gateway/DNS writes.
 */

import { classifyLaunchWrites } from './launch-write-plan.js';
import { planDnsARecord } from './dns-apply-plan.js';
import { planNextRuntimePort } from '@launchos/shared';
import type { LaunchPlanResult } from './launch-orchestrator.js';
import { STEP29_PHASE3B_BASELINE } from './dns-activation.js';
export const PHASE4_CONTROLLED_MARK = 'ONE_CLICK_ALPHA_TEST';
export const PHASE4_WHITELIST_SERVER_ID = 'cmub78pz001sdripco5pexhdz';
export const PHASE4_EXPECTED_PUBLIC_IP = '116.62.198.184';
export const PHASE4_ROOT_DOMAIN = 'zsaos.com';

/** Candidate hostnames — first available without conflict wins at gate time. */
export const PHASE4_HOSTNAME_CANDIDATES = [
  'oneclick-web.zsaos.com',
  'oneclick-test.zsaos.com',
] as const;

export const PHASE4A_REAL_EXECUTION_LOCKED = 'PHASE4A_REAL_EXECUTION_LOCKED';
export const PHASE4_PRODUCTION_PROJECT_ID = STEP29_PHASE3B_BASELINE.projectId;

/** Phase 4B fixed acceptance targets (from Phase 4A gate). */
export const PHASE4_TEST_PROJECT_ID = 'cmucerx5e0001ri4w0x6sx5cz';
export const PHASE4_TEST_ENV_ID = 'cmucerx5e0002ri4wagw06jw5';
export const PHASE4_TEST_WEB_UNIT_ID = 'cmucerx680006ri4w0qcdtp8c';
export const PHASE4_TEST_HOSTNAME = 'oneclick-web.zsaos.com';
export const CONTROLLED_REAL_LAUNCH = 'CONTROLLED_REAL_LAUNCH';
export const CONTROLLED_LAUNCH_BILLABLE_ACTION_FORBIDDEN =
  'CONTROLLED_LAUNCH_BILLABLE_ACTION_FORBIDDEN';

export const PHASE4_EXPECTED_EXECUTION_STEPS = [
  'BUILD_UNIT',
  'BUILD_DOCKER_IMAGE',
  'DEPLOY_WEB',
  'APPLY_WEB_ROUTE',
  'APPLY_WEB_DNS',
  'VERIFY_WEB_HTTPS',
  'FINAL_ACCEPTANCE',
] as const;

export const PHASE4_ALLOWED_EXECUTE_STEPS = [
  'ANALYZE_PROJECT',
  'BUILD_UNIT',
  'BUILD_DOCKER_IMAGE',
  'DEPLOY_WEB',
  'INSTALL_GATEWAY',
  'INSTALL_CERTIFICATE',
  'APPLY_WEB_ROUTE',
  'APPLY_WEB_DNS',
  'VERIFY_WEB_HTTPS',
  'FINAL_ACCEPTANCE',
] as const;

export const PHASE4_FORBIDDEN_EXECUTE_STEPS = [
  'PROVISION_POSTGRESQL',
  'CONNECT_POSTGRESQL',
  'PROVISION_REDIS',
  'CONNECT_REDIS',
  'PROVISION_SERVER',
  'DEPLOY_API',
  'APPLY_API_ROUTE',
  'APPLY_API_DNS',
  'VERIFY_API_HTTPS',
] as const;

export type Phase4ControlledGateInput = {
  testProjectId: string;
  testWebUnitId: string;
  launchRunId: string;
  hostname: string;
  plan: LaunchPlanResult;
  serverInstanceId: string;
  /** Existing DNS snapshot for hostname (null = missing). */
  dnsExisting: {
    rr: string;
    type: string;
    value: string;
    recordId?: string | null;
    managedByLaunchOS?: boolean;
  } | null;
  gatewayReady: boolean;
  certificateReusable: boolean;
  productionApiHealthy: boolean;
  productionWebHealthy: boolean;
  reservedPorts: number[];
  remoteListeningPorts: number[];
  launchLockReady: boolean;
};

export type Phase4ControlledGateResult = {
  testProjectId: string;
  testWebUnitId: string;
  launchRunId: string;
  hostname: string;
  planVersion: string;
  planFresh: true;
  unitMode: 'WEB_ONLY';
  postgresqlRequired: false;
  redisRequired: false;
  serverReuse: boolean;
  serverInstanceId: string;
  requiresConfirmation: boolean;
  billableActions: LaunchPlanResult['billableActions'];
  newBillableResources: string[];
  executionSteps: string[];
  reuseSteps: string[];
  skipSteps: string[];
  apiStepsPresent: boolean;
  plannedArtifactWrites: number;
  plannedDeploymentEnqueues: number;
  plannedRemoteWrites: number;
  plannedGatewayWrites: number;
  plannedDnsWrites: number;
  plannedEcsCreates: number;
  plannedRdsCreates: number;
  plannedRedisCreates: number;
  plannedSecurityGroupWrites: number;
  plannedCertificateIssues: number;
  hostnameAvailable: boolean;
  dnsConflict: boolean;
  dnsAction: string;
  gatewayReady: boolean;
  certificateReusable: boolean;
  productionApiHealthy: boolean;
  productionWebHealthy: boolean;
  launchLockReady: boolean;
  reservedPorts: number[];
  remoteListeningPorts: number[];
  selectedRuntimePort: number | null;
  portConflict: boolean;
  canExecuteControlledLaunch: boolean;
  blockers: Array<{ code: string; messageZh: string }>;
  EXECUTION_STARTED: false;
  WRITE_COMMANDS_EXECUTED_THIS_RUN: false;
  realExecutionLocked: true;
  lockCode: typeof PHASE4A_REAL_EXECUTION_LOCKED;
};

export function isWebOnlyPlan(plan: LaunchPlanResult): boolean {
  const types = (plan.inputSnapshot.unitTypes as string[] | undefined) ?? [];
  const hasWeb = types.some((t) => t === 'WEB' || t === 'ADMIN');
  const hasApi = types.some((t) => t === 'API');
  return hasWeb && !hasApi;
}

export function assertPhase4ControlledPlan(plan: LaunchPlanResult): {
  ok: boolean;
  blockers: Array<{ code: string; messageZh: string }>;
  apiStepsPresent: boolean;
  planned: ReturnType<typeof classifyLaunchWrites>;
  plannedEcsCreates: number;
  plannedRdsCreates: number;
  plannedRedisCreates: number;
  plannedArtifactWrites: number;
  plannedDeploymentEnqueues: number;
  plannedCertificateIssues: number;
} {
  const blockers: Array<{ code: string; messageZh: string }> = [];
  const exec = plan.executionSteps;

  if (!isWebOnlyPlan(plan)) {
    blockers.push({ code: 'PHASE4_NOT_WEB_ONLY', messageZh: 'Phase 4 仅允许 WEB-only 测试项目' });
  }

  // Dependency: must not require PG/Redis
  if (plan.inputSnapshot.requiresPostgresql === true) {
    blockers.push({
      code: 'PHASE4_POSTGRES_FORBIDDEN',
      messageZh: 'WEB-only 测试不得需要 PostgreSQL',
    });
  }
  if (plan.inputSnapshot.requiresRedis === true) {
    blockers.push({
      code: 'PHASE4_REDIS_FORBIDDEN',
      messageZh: 'WEB-only 测试不得需要 Redis',
    });
  }

  if (plan.requiresConfirmation || plan.billableActions.length > 0) {
    blockers.push({
      code: 'PHASE4_BILLABLE_FORBIDDEN',
      messageZh: '受控写路径不得包含收费云资源创建',
    });
  }
  if (plan.resourcesToCreate.length > 0) {
    blockers.push({
      code: 'PHASE4_RESOURCE_CREATE_FORBIDDEN',
      messageZh: '不得规划创建 ECS/RDS/Redis 等新云资源',
    });
  }

  const apiStepsPresent = exec.some((s) =>
    (PHASE4_FORBIDDEN_EXECUTE_STEPS as readonly string[]).includes(s),
  );
  if (apiStepsPresent) {
    for (const s of exec) {
      if ((PHASE4_FORBIDDEN_EXECUTE_STEPS as readonly string[]).includes(s)) {
        blockers.push({
          code: 'PHASE4_FORBIDDEN_STEP',
          messageZh: `禁止执行步骤: ${s}`,
        });
      }
    }
  }

  // Must plan web deploy path
  const mustHave = [
    'BUILD_UNIT',
    'BUILD_DOCKER_IMAGE',
    'DEPLOY_WEB',
    'APPLY_WEB_ROUTE',
    'APPLY_WEB_DNS',
    'VERIFY_WEB_HTTPS',
    'FINAL_ACCEPTANCE',
  ];
  for (const m of mustHave) {
    if (!exec.includes(m)) {
      blockers.push({
        code: 'PHASE4_MISSING_EXECUTE_STEP',
        messageZh: `缺少必要执行步骤: ${m}`,
      });
    }
  }

  const planned = classifyLaunchWrites(
    plan.steps.map((s) => ({ stepType: s.stepType, decision: s.decision })),
  );

  let plannedEcsCreates = 0;
  let plannedRdsCreates = 0;
  let plannedRedisCreates = 0;
  let plannedArtifactWrites = 0;
  let plannedDeploymentEnqueues = 0;
  let plannedCertificateIssues = 0;

  for (const s of plan.steps) {
    if (s.decision !== 'EXECUTE') continue;
    if (s.stepType === 'PROVISION_SERVER') plannedEcsCreates += 1;
    if (s.stepType === 'PROVISION_POSTGRESQL') plannedRdsCreates += 1;
    if (s.stepType === 'PROVISION_REDIS') plannedRedisCreates += 1;
    if (s.stepType === 'BUILD_UNIT' || s.stepType === 'BUILD_DOCKER_IMAGE') {
      plannedArtifactWrites += 1;
    }
    if (s.stepType === 'DEPLOY_WEB' || s.stepType === 'DEPLOY_API') {
      plannedDeploymentEnqueues += 1;
    }
    if (s.stepType === 'INSTALL_CERTIFICATE') {
      plannedCertificateIssues += 1;
    }
  }

  if (plannedEcsCreates + plannedRdsCreates + plannedRedisCreates > 0) {
    blockers.push({
      code: 'PHASE4_CLOUD_CREATE_FORBIDDEN',
      messageZh: '禁止规划 ECS/RDS/Redis 创建',
    });
  }

  // Server must be reuse
  const provisionServer = plan.steps.find((s) => s.stepType === 'PROVISION_SERVER');
  if (provisionServer && provisionServer.decision === 'EXECUTE') {
    blockers.push({
      code: 'PHASE4_SERVER_MUST_REUSE',
      messageZh: '必须复用已有 Managed Server，不得创建 ECS',
    });
  }

  const unique = [...new Map(blockers.map((b) => [b.code + b.messageZh, b])).values()];
  return {
    ok: unique.length === 0,
    blockers: unique,
    apiStepsPresent,
    planned,
    plannedEcsCreates,
    plannedRdsCreates,
    plannedRedisCreates,
    plannedArtifactWrites,
    plannedDeploymentEnqueues,
    plannedCertificateIssues,
  };
}

export function evaluateHostnameAvailability(input: {
  hostname: string;
  rootDomain: string;
  desiredIp: string;
  existing: Phase4ControlledGateInput['dnsExisting'];
}): { hostnameAvailable: boolean; dnsConflict: boolean; action: string } {
  const plan = planDnsARecord({
    hostname: input.hostname,
    rootDomain: input.rootDomain,
    desiredIp: input.desiredIp,
    existing: input.existing,
  });
  return {
    hostnameAvailable: plan.action === 'CREATE' || plan.action === 'NO_CHANGE',
    dnsConflict: plan.action === 'DNS_RECORD_CONFLICT',
    action: plan.action,
  };
}

export function planControlledRuntimePort(input: {
  reservedPorts: number[];
  remoteListeningPorts: number[];
  productionPorts?: number[];
}): { selectedRuntimePort: number | null; portConflict: boolean; blocked: number[] } {
  const production = input.productionPorts ?? [39000, 39002];
  const blocked = [
    ...new Set([...input.reservedPorts, ...input.remoteListeningPorts, ...production]),
  ];
  const selectedRuntimePort = planNextRuntimePort(blocked);
  return {
    selectedRuntimePort,
    portConflict: selectedRuntimePort == null || production.includes(selectedRuntimePort),
    blocked,
  };
}

export function evaluatePhase4ControlledGate(
  input: Phase4ControlledGateInput,
): Phase4ControlledGateResult {
  const plan = applyControlledInfrastructureReuse(input.plan, {
    gatewayReady: input.gatewayReady,
    certificateReusable: input.certificateReusable,
    serverInstanceId: input.serverInstanceId,
  });
  const planCheck = assertPhase4ControlledPlan(plan);
  const host = evaluateHostnameAvailability({
    hostname: input.hostname,
    rootDomain: PHASE4_ROOT_DOMAIN,
    desiredIp: PHASE4_EXPECTED_PUBLIC_IP,
    existing: input.dnsExisting,
  });
  const port = planControlledRuntimePort({
    reservedPorts: input.reservedPorts,
    remoteListeningPorts: input.remoteListeningPorts,
  });

  const serverReuse =
    input.serverInstanceId === PHASE4_WHITELIST_SERVER_ID &&
    plan.serverReady === true &&
    !plan.executionSteps.includes('PROVISION_SERVER');

  const blockers = [...planCheck.blockers];
  if (planCheck.plannedArtifactWrites < 1) {
    blockers.push({
      code: 'PHASE4_ARTIFACT_BUILD_REQUIRED',
      messageZh: '必须规划真实 Artifact 构建',
    });
  }
  if (planCheck.plannedDeploymentEnqueues !== 1) {
    blockers.push({
      code: 'PHASE4_ONE_WEB_DEPLOY_REQUIRED',
      messageZh: '必须且仅规划一次 Web 部署',
    });
  }
  if (planCheck.planned.gatewayWritesPlanned < 1) {
    blockers.push({
      code: 'PHASE4_GATEWAY_ROUTE_REQUIRED',
      messageZh: '必须规划 GatewayRoute 写入',
    });
  }
  if (planCheck.planned.dnsWritesPlanned < 1) {
    blockers.push({
      code: 'PHASE4_DNS_WRITE_REQUIRED',
      messageZh: '必须规划 DNS CREATE',
    });
  }
  if (!serverReuse) {
    blockers.push({
      code: 'PHASE4_SERVER_REUSE_REQUIRED',
      messageZh: '必须复用指定 Managed Server',
    });
  }
  if (host.dnsConflict || !host.hostnameAvailable) {
    blockers.push({
      code: host.dnsConflict ? 'DNS_RECORD_CONFLICT' : 'HOSTNAME_UNAVAILABLE',
      messageZh: host.dnsConflict
        ? '测试域名已存在且所有权不明确'
        : '测试域名不可用',
    });
  }
  if (!input.gatewayReady) {
    blockers.push({ code: 'GATEWAY_NOT_READY', messageZh: '网关未就绪' });
  }
  if (!input.certificateReusable) {
    blockers.push({ code: 'CERTIFICATE_NOT_REUSABLE', messageZh: '证书不可复用' });
  }
  if (!input.productionApiHealthy || !input.productionWebHealthy) {
    blockers.push({
      code: 'PRODUCTION_BASELINE_UNHEALTHY',
      messageZh: '正式环境 API/Web 健康检查未通过，禁止继续',
    });
  }
  if (port.portConflict || port.selectedRuntimePort == null) {
    blockers.push({
      code: 'PORT_ALLOCATION_FAILED',
      messageZh: '无法分配不冲突的运行端口',
    });
  }
  if (!input.launchLockReady) {
    blockers.push({ code: 'LAUNCH_LOCK_NOT_READY', messageZh: '上线锁不可用' });
  }
  if (input.testProjectId === PHASE4_PRODUCTION_PROJECT_ID) {
    blockers.push({
      code: 'PHASE4_PRODUCTION_PROJECT_FORBIDDEN',
      messageZh: '禁止对正式 Demo Project 执行 Phase 4',
    });
  }

  const unique = [...new Map(blockers.map((b) => [b.code + b.messageZh, b])).values()];

  return {
    testProjectId: input.testProjectId,
    testWebUnitId: input.testWebUnitId,
    launchRunId: input.launchRunId,
    hostname: input.hostname,
    planVersion: plan.planVersion,
    planFresh: true,
    unitMode: 'WEB_ONLY',
    postgresqlRequired: false,
    redisRequired: false,
    serverReuse,
    serverInstanceId: input.serverInstanceId,
    requiresConfirmation: plan.requiresConfirmation,
    billableActions: plan.billableActions,
    newBillableResources: [],
    executionSteps: plan.executionSteps,
    reuseSteps: plan.reuseSteps,
    skipSteps: plan.skipSteps,
    apiStepsPresent: planCheck.apiStepsPresent,
    plannedArtifactWrites: planCheck.plannedArtifactWrites,
    plannedDeploymentEnqueues: planCheck.plannedDeploymentEnqueues,
    plannedRemoteWrites: planCheck.planned.remoteWritesPlanned + planCheck.plannedDeploymentEnqueues,
    plannedGatewayWrites: planCheck.planned.gatewayWritesPlanned,
    plannedDnsWrites: planCheck.planned.dnsWritesPlanned,
    plannedEcsCreates: planCheck.plannedEcsCreates,
    plannedRdsCreates: planCheck.plannedRdsCreates,
    plannedRedisCreates: planCheck.plannedRedisCreates,
    plannedSecurityGroupWrites: 0,
    plannedCertificateIssues: planCheck.plannedCertificateIssues,
    hostnameAvailable: host.hostnameAvailable && !host.dnsConflict,
    dnsConflict: host.dnsConflict,
    dnsAction: host.action,
    gatewayReady: input.gatewayReady,
    certificateReusable: input.certificateReusable,
    productionApiHealthy: input.productionApiHealthy,
    productionWebHealthy: input.productionWebHealthy,
    launchLockReady: input.launchLockReady,
    reservedPorts: input.reservedPorts,
    remoteListeningPorts: input.remoteListeningPorts,
    selectedRuntimePort: port.selectedRuntimePort,
    portConflict: port.portConflict,
    canExecuteControlledLaunch: unique.length === 0,
    blockers: unique,
    EXECUTION_STARTED: false,
    WRITE_COMMANDS_EXECUTED_THIS_RUN: false,
    realExecutionLocked: true,
    lockCode: PHASE4A_REAL_EXECUTION_LOCKED,
  };
}

export function applyControlledInfrastructureReuse(
  plan: LaunchPlanResult,
  opts: { gatewayReady: boolean; certificateReusable: boolean; serverInstanceId: string },
): LaunchPlanResult {
  const steps = plan.steps.map((s) => {
    if (s.stepType === 'INSTALL_GATEWAY' && opts.gatewayReady && s.decision === 'EXECUTE') {
      return {
        ...s,
        decision: 'REUSE' as const,
        status: 'SKIPPED' as const,
        billable: false,
        requiresConfirmation: false,
        reason: 'gateway_runtime_reuse',
        reasonZh: '网关运行时已就绪，可复用',
      };
    }
    if (
      s.stepType === 'INSTALL_CERTIFICATE' &&
      opts.certificateReusable &&
      s.decision === 'EXECUTE'
    ) {
      return {
        ...s,
        decision: 'REUSE' as const,
        status: 'SKIPPED' as const,
        billable: false,
        requiresConfirmation: false,
        reason: 'certificate_reuse',
        reasonZh: '通配证书有效，可复用',
      };
    }
    if (s.stepType === 'PROVISION_SERVER' && s.decision === 'EXECUTE') {
      return {
        ...s,
        decision: 'SKIP' as const,
        status: 'SKIPPED' as const,
        billable: false,
        requiresConfirmation: false,
        resourceId: opts.serverInstanceId,
        reason: 'forced_server_reuse',
        reasonZh: '强制复用已有服务器',
      };
    }
    return s;
  });

  const executionSteps = steps.filter((s) => s.decision === 'EXECUTE').map((s) => s.stepType);
  const reuseSteps = steps.filter((s) => s.decision === 'REUSE').map((s) => s.stepType);
  const skipSteps = steps.filter((s) => s.decision === 'SKIP').map((s) => s.stepType);

  return {
    ...plan,
    steps,
    executionSteps,
    reuseSteps,
    skipSteps,
    billableActions: [],
    resourcesToCreate: [],
    requiresConfirmation: false,
    serverReady: true,
  };
}

/** Failure-path policy fixtures for Phase 4A engineering (no real writes). */
export function phase4FailurePreventsDns(input: {
  buildFailed?: boolean;
  deployFailed?: boolean;
  gatewayLocalVerifyFailed?: boolean;
}): { dnsAllowed: boolean; reason: string } {
  if (input.buildFailed) return { dnsAllowed: false, reason: 'BUILD_FAILED' };
  if (input.deployFailed) return { dnsAllowed: false, reason: 'DEPLOY_FAILED' };
  if (input.gatewayLocalVerifyFailed) {
    return { dnsAllowed: false, reason: 'GATEWAY_LOCAL_VERIFY_FAILED' };
  }
  return { dnsAllowed: true, reason: 'OK' };
}

export function refusePhase4ARealExecution(): {
  code: typeof PHASE4A_REAL_EXECUTION_LOCKED;
  messageZh: string;
  WRITE_COMMANDS_EXECUTED_THIS_RUN: false;
  EXECUTION_STARTED: false;
} {
  return {
    code: PHASE4A_REAL_EXECUTION_LOCKED,
    messageZh: 'Phase 4A 仅开放 Gate-only，真实写路径执行在 Phase 4B 开放。',
    WRITE_COMMANDS_EXECUTED_THIS_RUN: false,
    EXECUTION_STARTED: false,
  };
}

/** Hide NOT_REQUIRED dependency stage from end-user launch UI. */
export function filterUserFacingLaunchStages<
  T extends { stage: string; decisionSummary: string },
>(stages: T[], opts?: { hideDependenciesWhenSkipped?: boolean; hideApiWhenAbsent?: boolean }): T[] {
  const hideDeps = opts?.hideDependenciesWhenSkipped !== false;
  return stages.filter((s) => {
    if (
      hideDeps &&
      s.stage === 'DEPENDENCIES' &&
      (s.decisionSummary === 'SKIP' || s.decisionSummary === 'REUSE')
    ) {
      return false;
    }
    return true;
  });
}

export function isPhase4ControlledHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  return (PHASE4_HOSTNAME_CANDIDATES as readonly string[]).includes(h);
}

/** Runtime guard: refuse any billable provision step mid-execution. */
export function assertNoBillableControlledSteps(executionSteps: string[]): void {
  const forbidden = [
    'PROVISION_SERVER',
    'PROVISION_POSTGRESQL',
    'PROVISION_REDIS',
  ];
  for (const s of executionSteps) {
    if (forbidden.includes(s)) {
      throw new Error(
        `${CONTROLLED_LAUNCH_BILLABLE_ACTION_FORBIDDEN}:${s}`,
      );
    }
  }
}

export function assertPhase4BExecutionPlan(
  projectId: string,
  plan: LaunchPlanResult,
): { ok: boolean; blockers: Array<{ code: string; messageZh: string }> } {
  if (projectId !== PHASE4_TEST_PROJECT_ID) {
    return {
      ok: false,
      blockers: [
        {
          code: 'PHASE4_TEST_PROJECT_MISMATCH',
          messageZh: 'Phase 4B 仅允许指定 ONE_CLICK 测试项目',
        },
      ],
    };
  }
  const planned = applyControlledInfrastructureReuse(plan, {
    gatewayReady: true,
    certificateReusable: true,
    serverInstanceId: PHASE4_WHITELIST_SERVER_ID,
  });
  try {
    assertNoBillableControlledSteps(planned.executionSteps);
  } catch (e) {
    return {
      ok: false,
      blockers: [
        {
          code: CONTROLLED_LAUNCH_BILLABLE_ACTION_FORBIDDEN,
          messageZh: e instanceof Error ? e.message : 'billable forbidden',
        },
      ],
    };
  }
  const check = assertPhase4ControlledPlan(planned);
  const expected = [...PHASE4_EXPECTED_EXECUTION_STEPS];
  const actual = planned.executionSteps.filter((s) =>
    (PHASE4_EXPECTED_EXECUTION_STEPS as readonly string[]).includes(s),
  );
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    check.blockers.push({
      code: 'PLAN_STALE',
      messageZh: `执行步骤与 Phase 4B 期望不一致: ${actual.join(',')}`,
    });
  }
  if (planned.serverReady !== true) {
    check.blockers.push({
      code: 'PHASE4_SERVER_REUSE_REQUIRED',
      messageZh: '必须复用已有服务器',
    });
  }
  return { ok: check.blockers.length === 0, blockers: check.blockers };
}

export function emptyControlledWriteCounters() {
  return {
    artifactWriteCount: 0,
    deploymentEnqueueCount: 0,
    remoteWriteCount: 0,
    gatewayWriteCount: 0,
    dnsWriteCount: 0,
    launchStateWriteCount: 0,
    cloudProviderWriteCount: 0,
    certificateWriteCount: 0,
    ecsCreateCount: 0,
    rdsCreateCount: 0,
    redisCreateCount: 0,
    securityGroupWriteCount: 0,
  };
}

export type ControlledWriteCounters = ReturnType<typeof emptyControlledWriteCounters>;
