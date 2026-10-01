/**
 * Step 30 Phase 1 — Launch plan builder (desired state ← declared + observed).
 * Pure function: no cloud writes, no deploy enqueue, no DNS/gateway mutations.
 */

import {
  getLaunchStepPolicy,
  type LaunchStepType,
} from './launch-execution-policy.js';
import { computeLaunchProgress, type LaunchProgressModel } from './launch-progress.js';
import {
  LAUNCH_STAGE_LABELS_ZH,
  LAUNCH_STAGES,
  type LaunchStageId,
} from './launch-stages.js';

export const LAUNCH_PLAN_VERSION = 'step30-phase2-v1';

export type LaunchStepDecision = 'EXECUTE' | 'REUSE' | 'SKIP' | 'BLOCK';

export type LaunchUnitInput = {
  id: string;
  name: string;
  type: string;
  deployable: boolean;
  status: string;
  /** Explicit override; otherwise derived from type + deployable + status. */
  requiredForLaunch?: boolean;
  requiresPostgresql?: boolean;
  requiresRedis?: boolean;
};

export type UnitDeclaredState = {
  unitId: string;
  type: string;
  artifactReady: boolean;
  artifactId?: string | null;
  serviceStatus?: string | null;
  healthStatus?: string | null;
  serviceInstanceId?: string | null;
  gatewayStatus?: string | null;
  gatewayHostname?: string | null;
  dnsStatus?: string | null;
  /** Declared cert binding / ApplicationSsl ACTIVE. */
  certificateValid?: boolean | null;
};

export type DeclaredWorldState = {
  analysisReady: boolean;
  postgresql: {
    required: boolean;
    status: string;
    connectionId?: string | null;
  };
  redis: {
    required: boolean;
    status: string;
    connectionId?: string | null;
  };
  server: {
    id?: string | null;
    status?: string | null;
    dockerStatus?: string | null;
    compatible?: boolean;
  } | null;
  units: UnitDeclaredState[];
  accessEntryStatus?: string | null;
};

/**
 * Observed facts from read-only probes. null/undefined = unknown (trust declared only if healthy).
 * Explicit false blocks REUSE.
 */
export type ObservedFacts = {
  serverObservedReady?: boolean | null;
  /** unitId → container running */
  containerObservedRunning?: Record<string, boolean | null | undefined>;
  /** unitId → health 2xx */
  healthObserved2xx?: Record<string, boolean | null | undefined>;
  /** unitId → DNS points to expected IP */
  dnsObservedCorrect?: Record<string, boolean | null | undefined>;
  certificateObservedValid?: boolean | null;
  gatewayObservedListening?: boolean | null;
};

export type DesiredLaunchState = {
  dependenciesReady: boolean;
  serverReady: boolean;
  allRequiredUnitsHealthy: boolean;
  publicEntryActive: boolean;
  httpsValid: boolean;
};

export type PlannedLaunchStep = {
  stepType: LaunchStepType;
  stage: LaunchStageId;
  decision: LaunchStepDecision;
  status: 'PENDING' | 'READY' | 'SKIPPED' | 'BLOCKED' | 'WAITING';
  executionOrder: number;
  dependsOn: string[];
  reconcileKey: string;
  resourceType: string | null;
  resourceId: string | null;
  unitId: string | null;
  billable: boolean;
  requiresConfirmation: boolean;
  reason: string;
  reasonZh: string;
};

export type LaunchResourceRef = {
  kind: string;
  id: string | null;
  label: string;
  labelZh: string;
};

export type BillableAction = {
  action: string;
  stepType: LaunchStepType;
  labelZh: string;
  estimatedCostAvailable: boolean;
  profileHint?: string | null;
};

export type LaunchPlanResult = {
  planVersion: string;
  projectId: string;
  environmentId: string;
  steps: PlannedLaunchStep[];
  stages: Array<{
    stage: LaunchStageId;
    labelZh: string;
    decisionSummary: LaunchStepDecision | 'MIXED';
    status: string;
  }>;
  desiredState: DesiredLaunchState;
  currentDesiredStateSatisfied: boolean;
  dependenciesReady: boolean;
  serverReady: boolean;
  apiReady: boolean;
  webReady: boolean;
  publicEntryReady: boolean;
  resourcesToReuse: LaunchResourceRef[];
  resourcesToCreate: LaunchResourceRef[];
  billableActions: BillableAction[];
  requiresConfirmation: boolean;
  estimatedCostAvailable: boolean;
  executionSteps: string[];
  reuseSteps: string[];
  skipSteps: string[];
  blockers: Array<{ code: string; messageZh: string }>;
  canLaunch: boolean;
  suggestedRunStatus: 'READY' | 'WAITING_CONFIRMATION' | 'BLOCKED';
  progress: LaunchProgressModel;
  inputSnapshot: Record<string, unknown>;
  observedFacts: ObservedFacts;
  WRITE_COMMANDS_EXECUTED_THIS_RUN: false;
};

export type BuildLaunchPlanInput = {
  projectId: string;
  environmentId: string;
  units: LaunchUnitInput[];
  declared: DeclaredWorldState;
  observed?: ObservedFacts | null;
  /** Optional server recommendation for confirmation UI. */
  serverRecommendation?: {
    profileLabel?: string;
    vcpu?: number;
    memoryGb?: number;
  } | null;
  planVersion?: string;
};

function isLaunchableUnit(u: LaunchUnitInput): boolean {
  if (u.requiredForLaunch != null) return u.requiredForLaunch;
  if (!u.deployable) return false;
  if (u.status === 'IGNORED' || u.status === 'UNSUPPORTED') return false;
  return u.type === 'WEB' || u.type === 'API' || u.type === 'ADMIN';
}

function isHealthyService(status?: string | null, health?: string | null): boolean {
  return status === 'RUNNING' && (health === 'HEALTHY' || health === 'UNKNOWN' || !health);
}

function observedOk(
  value: boolean | null | undefined,
  requireObserved: boolean,
): boolean {
  if (value === false) return false;
  if (value === true) return true;
  // unknown: allow reuse only when we don't require live observation
  return !requireObserved;
}

function decideReuseOrExecute(opts: {
  declaredOk: boolean;
  observed?: boolean | null;
  requireObserved?: boolean;
  reasonReuse: string;
  reasonReuseZh: string;
  reasonExecute: string;
  reasonExecuteZh: string;
}): { decision: LaunchStepDecision; reason: string; reasonZh: string } {
  const obsOk = observedOk(opts.observed, opts.requireObserved ?? false);
  if (opts.declaredOk && obsOk) {
    return {
      decision: 'REUSE',
      reason: opts.reasonReuse,
      reasonZh: opts.reasonReuseZh,
    };
  }
  return {
    decision: 'EXECUTE',
    reason: opts.reasonExecute,
    reasonZh: opts.reasonExecuteZh,
  };
}

function stepKey(stepType: string, reconcileKey: string): string {
  return reconcileKey === 'default' ? stepType : `${stepType}:${reconcileKey}`;
}

export function buildLaunchPlan(input: BuildLaunchPlanInput): LaunchPlanResult {
  const planVersion = input.planVersion ?? LAUNCH_PLAN_VERSION;
  const observed = input.observed ?? {};
  const launchUnits = input.units.filter(isLaunchableUnit);
  const apiUnits = launchUnits.filter((u) => u.type === 'API');
  const webUnits = launchUnits.filter((u) => u.type === 'WEB' || u.type === 'ADMIN');

  const requiresPg =
    input.declared.postgresql.required ||
    launchUnits.some((u) => u.requiresPostgresql === true);
  const requiresRedis =
    input.declared.redis.required || launchUnits.some((u) => u.requiresRedis === true);

  const pgConnected = input.declared.postgresql.status === 'CONNECTED';
  const redisConnected = input.declared.redis.status === 'CONNECTED';
  /** When requirements are already satisfied or explicitly not required, skip re-planning. */
  const depsAlreadyKnown =
    (!requiresPg || pgConnected) && (!requiresRedis || redisConnected);

  const serverDeclaredReady =
    !!input.declared.server?.id &&
    (input.declared.server.status === 'READY' ||
      input.declared.server.status === 'RUNNING' ||
      input.declared.server.dockerStatus === 'READY') &&
    input.declared.server.compatible !== false;

  const serverObserved = observed.serverObservedReady;
  const serverReady =
    serverDeclaredReady && observedOk(serverObserved, serverObserved != null);

  const steps: PlannedLaunchStep[] = [];
  let order = 0;

  const push = (
    stepType: LaunchStepType,
    decision: LaunchStepDecision,
    opts: {
      dependsOn?: string[];
      reconcileKey?: string;
      resourceType?: string | null;
      resourceId?: string | null;
      unitId?: string | null;
      reason: string;
      reasonZh: string;
      statusOverride?: PlannedLaunchStep['status'];
    },
  ) => {
    const policy = getLaunchStepPolicy(stepType)!;
    const reconcileKey = opts.reconcileKey ?? 'default';
    let status: PlannedLaunchStep['status'] = 'PENDING';
    if (decision === 'SKIP') status = 'SKIPPED';
    else if (decision === 'BLOCK') status = 'BLOCKED';
    else if (decision === 'REUSE') status = 'SKIPPED';
    else if (policy.requiresConfirmation && decision === 'EXECUTE') status = 'WAITING';
    else status = 'READY';
    if (opts.statusOverride) status = opts.statusOverride;

    steps.push({
      stepType,
      stage: policy.stage,
      decision,
      status,
      executionOrder: order++,
      dependsOn: opts.dependsOn ?? [],
      reconcileKey,
      resourceType: opts.resourceType ?? null,
      resourceId: opts.resourceId ?? null,
      unitId: opts.unitId ?? null,
      billable: policy.billable && decision === 'EXECUTE',
      requiresConfirmation: policy.requiresConfirmation && decision === 'EXECUTE',
      reason: opts.reason,
      reasonZh: opts.reasonZh,
    });
  };

  // —— ANALYZE ——
  push(
    'ANALYZE_PROJECT',
    input.declared.analysisReady ? 'REUSE' : 'EXECUTE',
    {
      reason: input.declared.analysisReady ? 'analysis_ready' : 'analysis_needed',
      reasonZh: input.declared.analysisReady ? '应用分析已完成，可复用' : '需要分析应用',
    },
  );

  // —— DEPENDENCIES ——
  push('PLAN_DEPENDENCIES', depsAlreadyKnown ? 'REUSE' : 'EXECUTE', {
    dependsOn: [stepKey('ANALYZE_PROJECT', 'default')],
    reason: depsAlreadyKnown ? 'dependencies_already_resolved' : 'plan_dependencies',
    reasonZh: depsAlreadyKnown ? '依赖需求已明确，可复用' : '根据单元需求规划依赖',
  });

  if (!requiresPg) {
    push('PROVISION_POSTGRESQL', 'SKIP', {
      dependsOn: [stepKey('PLAN_DEPENDENCIES', 'default')],
      reason: 'postgresql_not_required',
      reasonZh: '当前应用不需要数据库',
    });
    push('CONNECT_POSTGRESQL', 'SKIP', {
      dependsOn: [stepKey('PROVISION_POSTGRESQL', 'default')],
      reason: 'postgresql_not_required',
      reasonZh: '当前应用不需要数据库',
    });
  } else if (pgConnected) {
    push('PROVISION_POSTGRESQL', 'SKIP', {
      dependsOn: [stepKey('PLAN_DEPENDENCIES', 'default')],
      resourceType: 'DATABASE',
      resourceId: input.declared.postgresql.connectionId ?? null,
      reason: 'postgresql_already_connected',
      reasonZh: '数据库已连接，无需创建',
    });
    push('CONNECT_POSTGRESQL', 'REUSE', {
      dependsOn: [stepKey('PROVISION_POSTGRESQL', 'default')],
      resourceType: 'DATABASE',
      resourceId: input.declared.postgresql.connectionId ?? null,
      reason: 'postgresql_connected',
      reasonZh: '复用已连接的数据库',
    });
  } else {
    push('PROVISION_POSTGRESQL', 'EXECUTE', {
      dependsOn: [stepKey('PLAN_DEPENDENCIES', 'default')],
      resourceType: 'DATABASE',
      reason: 'postgresql_missing',
      reasonZh: '需要创建或接入数据库',
    });
    push('CONNECT_POSTGRESQL', 'EXECUTE', {
      dependsOn: [stepKey('PROVISION_POSTGRESQL', 'default')],
      resourceType: 'DATABASE',
      reason: 'postgresql_connect_needed',
      reasonZh: '需要连接数据库',
    });
  }

  if (!requiresRedis) {
    push('PROVISION_REDIS', 'SKIP', {
      dependsOn: [stepKey('PLAN_DEPENDENCIES', 'default')],
      reason: 'redis_not_required',
      reasonZh: '当前应用不需要 Redis',
    });
    push('CONNECT_REDIS', 'SKIP', {
      dependsOn: [stepKey('PROVISION_REDIS', 'default')],
      reason: 'redis_not_required',
      reasonZh: '当前应用不需要 Redis',
    });
  } else if (redisConnected) {
    push('PROVISION_REDIS', 'SKIP', {
      dependsOn: [stepKey('PLAN_DEPENDENCIES', 'default')],
      resourceType: 'CACHE',
      resourceId: input.declared.redis.connectionId ?? null,
      reason: 'redis_already_connected',
      reasonZh: 'Redis 已连接，无需创建',
    });
    push('CONNECT_REDIS', 'REUSE', {
      dependsOn: [stepKey('PROVISION_REDIS', 'default')],
      resourceType: 'CACHE',
      resourceId: input.declared.redis.connectionId ?? null,
      reason: 'redis_connected',
      reasonZh: '复用已连接的 Redis',
    });
  } else {
    push('PROVISION_REDIS', 'EXECUTE', {
      dependsOn: [stepKey('PLAN_DEPENDENCIES', 'default')],
      resourceType: 'CACHE',
      reason: 'redis_missing',
      reasonZh: '需要创建或接入 Redis',
    });
    push('CONNECT_REDIS', 'EXECUTE', {
      dependsOn: [stepKey('PROVISION_REDIS', 'default')],
      resourceType: 'CACHE',
      reason: 'redis_connect_needed',
      reasonZh: '需要连接 Redis',
    });
  }

  const depsReady =
    (!requiresPg || pgConnected) && (!requiresRedis || redisConnected);

  // —— INFRASTRUCTURE ——
  push('PLAN_SERVER', serverReady ? 'REUSE' : 'EXECUTE', {
    dependsOn: [
      stepKey('CONNECT_POSTGRESQL', 'default'),
      stepKey('CONNECT_REDIS', 'default'),
    ],
    reason: serverReady ? 'server_plan_reuse' : 'server_plan_needed',
    reasonZh: serverReady ? '已有可用服务器规划' : '需要规划服务器',
  });

  if (serverReady) {
    push('PROVISION_SERVER', 'SKIP', {
      dependsOn: [stepKey('PLAN_SERVER', 'default')],
      resourceType: 'SERVER',
      resourceId: input.declared.server?.id ?? null,
      reason: 'server_ready_skip_provision',
      reasonZh: '已有就绪服务器，跳过创建',
    });
    const initDecision = decideReuseOrExecute({
      declaredOk: serverDeclaredReady,
      observed: serverObserved,
      requireObserved: serverObserved != null,
      reasonReuse: 'server_initialized',
      reasonReuseZh: '服务器运行环境已就绪，可复用',
      reasonExecute: 'server_needs_init_or_repair',
      reasonExecuteZh: '服务器需要初始化或修复运行环境',
    });
    push('INITIALIZE_SERVER', initDecision.decision, {
      dependsOn: [stepKey('PROVISION_SERVER', 'default')],
      resourceType: 'SERVER',
      resourceId: input.declared.server?.id ?? null,
      reason: initDecision.reason,
      reasonZh: initDecision.reasonZh,
    });
  } else if (input.declared.server?.id && !serverReady) {
    // Declared server exists but not ready / observed unhealthy → repair init, do not create
    push('PROVISION_SERVER', 'SKIP', {
      dependsOn: [stepKey('PLAN_SERVER', 'default')],
      resourceType: 'SERVER',
      resourceId: input.declared.server.id,
      reason: 'server_exists_repair',
      reasonZh: '服务器已存在但未就绪，跳过创建并修复',
    });
    push('INITIALIZE_SERVER', 'EXECUTE', {
      dependsOn: [stepKey('PROVISION_SERVER', 'default')],
      resourceType: 'SERVER',
      resourceId: input.declared.server.id,
      reason: 'server_init_repair',
      reasonZh: '需要初始化或修复服务器运行环境',
    });
  } else {
    push('PROVISION_SERVER', 'EXECUTE', {
      dependsOn: [stepKey('PLAN_SERVER', 'default')],
      resourceType: 'SERVER',
      reason: 'server_missing_billable',
      reasonZh: '需要创建云服务器（需确认费用）',
    });
    push('INITIALIZE_SERVER', 'EXECUTE', {
      dependsOn: [stepKey('PROVISION_SERVER', 'default')],
      resourceType: 'SERVER',
      reason: 'server_init_after_create',
      reasonZh: '创建后需要初始化服务器',
    });
  }

  // —— BUILD + DEPLOY per unit ——
  const deployStepKeys: string[] = [];

  for (const unit of launchUnits) {
    const declared = input.declared.units.find((u) => u.unitId === unit.id);
    const containerObs = observed.containerObservedRunning?.[unit.id];
    const healthObs = observed.healthObserved2xx?.[unit.id];

    const artifactReady = !!declared?.artifactReady;
    const serviceHealthy =
      isHealthyService(declared?.serviceStatus, declared?.healthStatus) &&
      observedOk(containerObs, containerObs != null) &&
      observedOk(healthObs, healthObs != null);

    const buildDecision = artifactReady
      ? decideReuseOrExecute({
          declaredOk: true,
          observed: null,
          reasonReuse: 'artifact_ready',
          reasonReuseZh: '已有构建产物，可复用',
          reasonExecute: 'artifact_rebuild',
          reasonExecuteZh: '需要重新构建',
        })
      : {
          decision: 'EXECUTE' as const,
          reason: 'artifact_missing',
          reasonZh: '需要构建应用',
        };

    push('BUILD_UNIT', buildDecision.decision, {
      dependsOn: [stepKey('INITIALIZE_SERVER', 'default')],
      reconcileKey: unit.id,
      unitId: unit.id,
      resourceType: 'ARTIFACT',
      resourceId: declared?.artifactId ?? null,
      reason: buildDecision.reason,
      reasonZh: buildDecision.reasonZh,
    });
    push('BUILD_DOCKER_IMAGE', buildDecision.decision, {
      dependsOn: [stepKey('BUILD_UNIT', unit.id)],
      reconcileKey: unit.id,
      unitId: unit.id,
      resourceType: 'IMAGE',
      reason: buildDecision.reason,
      reasonZh:
        buildDecision.decision === 'REUSE' ? '镜像可复用' : '需要构建运行镜像',
    });

    const deployType: LaunchStepType =
      unit.type === 'API' ? 'DEPLOY_API' : 'DEPLOY_WEB';
    const deployDecision = serviceHealthy
      ? {
          decision: 'REUSE' as const,
          reason: 'service_healthy',
          reasonZh: '服务运行正常，可复用',
        }
      : declared?.serviceStatus && declared.serviceStatus !== 'RUNNING'
        ? {
            decision: 'EXECUTE' as const,
            reason: 'service_unhealthy_redeploy',
            reasonZh: '服务不健康，需要重新部署',
          }
        : {
            decision: 'EXECUTE' as const,
            reason: 'service_missing',
            reasonZh: '需要部署应用',
          };

    // Stale declared HEALTHY but observed dead → must redeploy
    if (
      isHealthyService(declared?.serviceStatus, declared?.healthStatus) &&
      (containerObs === false || healthObs === false)
    ) {
      deployDecision.decision = 'EXECUTE';
      deployDecision.reason = 'stale_declared_unhealthy_observed';
      deployDecision.reasonZh = '记录显示健康但实际未运行，需要重新部署';
    }

    push(deployType, deployDecision.decision, {
      dependsOn: [stepKey('BUILD_DOCKER_IMAGE', unit.id)],
      reconcileKey: unit.id,
      unitId: unit.id,
      resourceType: 'SERVICE_INSTANCE',
      resourceId: declared?.serviceInstanceId ?? null,
      reason: deployDecision.reason,
      reasonZh: deployDecision.reasonZh,
    });
    deployStepKeys.push(stepKey(deployType, unit.id));
  }

  // —— PUBLIC ENTRY ——
  const gatewayActive = launchUnits.every((unit) => {
    const d = input.declared.units.find((u) => u.unitId === unit.id);
    return d?.gatewayStatus === 'ACTIVE';
  });
  const dnsActive = launchUnits.every((unit) => {
    const d = input.declared.units.find((u) => u.unitId === unit.id);
    const dnsObs = observed.dnsObservedCorrect?.[unit.id];
    if (d?.dnsStatus !== 'ACTIVE' && d?.gatewayStatus !== 'ACTIVE') return false;
    // Prefer gateway ACTIVE + hostname as public entry signal when dnsStatus unset
    const declaredDnsOk =
      d?.dnsStatus === 'ACTIVE' ||
      (d?.gatewayStatus === 'ACTIVE' && !!d?.gatewayHostname);
    return declaredDnsOk && observedOk(dnsObs, dnsObs != null);
  });
  const certOk =
    (input.declared.units.every((u) => u.certificateValid !== false) &&
      observedOk(observed.certificateObservedValid, observed.certificateObservedValid != null)) ||
    (gatewayActive &&
      observed.certificateObservedValid !== false &&
      input.declared.accessEntryStatus === 'ACTIVE');

  const publicEntryReady =
    (input.declared.accessEntryStatus === 'ACTIVE' || (gatewayActive && dnsActive && certOk)) &&
    observedOk(observed.gatewayObservedListening, observed.gatewayObservedListening != null);

  const peDepends = deployStepKeys.length
    ? deployStepKeys
    : [stepKey('INITIALIZE_SERVER', 'default')];

  if (publicEntryReady) {
    push('INSTALL_GATEWAY', 'REUSE', {
      dependsOn: peDepends,
      reason: 'gateway_active',
      reasonZh: '访问网关已就绪，可复用',
    });
    push('INSTALL_CERTIFICATE', 'REUSE', {
      dependsOn: [stepKey('INSTALL_GATEWAY', 'default')],
      reason: 'certificate_valid',
      reasonZh: 'HTTPS 证书有效，可复用',
    });
  } else {
    push('INSTALL_GATEWAY', 'EXECUTE', {
      dependsOn: peDepends,
      reason: 'gateway_needed',
      reasonZh: '需要安装或配置访问网关',
    });
    push('INSTALL_CERTIFICATE', 'EXECUTE', {
      dependsOn: [stepKey('INSTALL_GATEWAY', 'default')],
      reason: 'certificate_needed',
      reasonZh: '需要准备 HTTPS 证书',
    });
  }

  for (const unit of apiUnits) {
    const d = input.declared.units.find((u) => u.unitId === unit.id);
    const dnsObs = observed.dnsObservedCorrect?.[unit.id];
    const routeOk = d?.gatewayStatus === 'ACTIVE';
    const dnsOk =
      (d?.dnsStatus === 'ACTIVE' || routeOk) &&
      observedOk(dnsObs, dnsObs != null) &&
      dnsObs !== false;

    push('APPLY_API_ROUTE', routeOk && publicEntryReady ? 'REUSE' : 'EXECUTE', {
      dependsOn: [stepKey('INSTALL_CERTIFICATE', 'default')],
      reconcileKey: unit.id,
      unitId: unit.id,
      resourceType: 'GATEWAY_ROUTE',
      reason: routeOk ? 'api_route_active' : 'api_route_needed',
      reasonZh: routeOk ? 'API 访问路由已配置' : '需要配置 API 访问路由',
    });
    push(
      'APPLY_API_DNS',
      dnsOk && publicEntryReady
        ? 'REUSE'
        : dnsObs === false
          ? 'EXECUTE'
          : routeOk && publicEntryReady
            ? 'REUSE'
            : 'EXECUTE',
      {
        dependsOn: [stepKey('APPLY_API_ROUTE', unit.id)],
        reconcileKey: unit.id,
        unitId: unit.id,
        resourceType: 'DNS',
        reason: dnsObs === false ? 'api_dns_wrong' : dnsOk ? 'api_dns_active' : 'api_dns_needed',
        reasonZh:
          dnsObs === false
            ? 'API 域名解析不正确，需要修复'
            : dnsOk
              ? 'API 域名已正确指向'
              : '需要配置 API 域名',
      },
    );
  }

  for (const unit of webUnits) {
    const d = input.declared.units.find((u) => u.unitId === unit.id);
    const dnsObs = observed.dnsObservedCorrect?.[unit.id];
    const routeOk = d?.gatewayStatus === 'ACTIVE';
    const dnsOk =
      (d?.dnsStatus === 'ACTIVE' || routeOk) &&
      observedOk(dnsObs, dnsObs != null) &&
      dnsObs !== false;

    push('APPLY_WEB_ROUTE', routeOk && publicEntryReady ? 'REUSE' : 'EXECUTE', {
      dependsOn: [stepKey('INSTALL_CERTIFICATE', 'default')],
      reconcileKey: unit.id,
      unitId: unit.id,
      resourceType: 'GATEWAY_ROUTE',
      reason: routeOk ? 'web_route_active' : 'web_route_needed',
      reasonZh: routeOk ? 'Web 访问路由已配置' : '需要配置 Web 访问路由',
    });
    push(
      'APPLY_WEB_DNS',
      dnsOk && publicEntryReady
        ? 'REUSE'
        : dnsObs === false
          ? 'EXECUTE'
          : routeOk && publicEntryReady
            ? 'REUSE'
            : 'EXECUTE',
      {
        dependsOn: [stepKey('APPLY_WEB_ROUTE', unit.id)],
        reconcileKey: unit.id,
        unitId: unit.id,
        resourceType: 'DNS',
        reason: dnsObs === false ? 'web_dns_wrong' : dnsOk ? 'web_dns_active' : 'web_dns_needed',
        reasonZh:
          dnsObs === false
            ? 'Web 域名解析不正确，需要修复'
            : dnsOk
              ? 'Web 域名已正确指向'
              : '需要配置 Web 域名',
      },
    );
  }

  // —— VERIFY ——
  const verifyDepends: string[] = [];
  for (const unit of apiUnits) {
    const d = input.declared.units.find((u) => u.unitId === unit.id);
    const httpsOk =
      publicEntryReady &&
      d?.gatewayStatus === 'ACTIVE' &&
      observed.certificateObservedValid !== false;
    push('VERIFY_API_HTTPS', httpsOk ? 'EXECUTE' : 'EXECUTE', {
      dependsOn: [stepKey('APPLY_API_DNS', unit.id)],
      reconcileKey: unit.id,
      unitId: unit.id,
      reason: 'verify_api_https',
      reasonZh: '验证 API 公网 HTTPS',
    });
    verifyDepends.push(stepKey('VERIFY_API_HTTPS', unit.id));
  }
  for (const unit of webUnits) {
    push('VERIFY_WEB_HTTPS', 'EXECUTE', {
      dependsOn: [stepKey('APPLY_WEB_DNS', unit.id)],
      reconcileKey: unit.id,
      unitId: unit.id,
      reason: 'verify_web_https',
      reasonZh: '验证 Web 公网 HTTPS',
    });
    verifyDepends.push(stepKey('VERIFY_WEB_HTTPS', unit.id));
  }

  push('FINAL_ACCEPTANCE', 'EXECUTE', {
    dependsOn: verifyDepends.length ? verifyDepends : [stepKey('INSTALL_CERTIFICATE', 'default')],
    reason: 'final_acceptance',
    reasonZh: '完成上线检查',
  });

  // —— aggregates ——
  const resourcesToReuse: LaunchResourceRef[] = [];
  const resourcesToCreate: LaunchResourceRef[] = [];
  const billableActions: BillableAction[] = [];

  for (const s of steps) {
    if (s.decision === 'REUSE' && s.resourceType) {
      resourcesToReuse.push({
        kind: s.resourceType,
        id: s.resourceId,
        label: s.stepType,
        labelZh: s.reasonZh,
      });
    }
    if (s.decision === 'EXECUTE' && s.billable) {
      resourcesToCreate.push({
        kind: s.resourceType ?? s.stepType,
        id: null,
        label: s.stepType,
        labelZh: s.reasonZh,
      });
      billableActions.push({
        action: s.stepType,
        stepType: s.stepType,
        labelZh: s.reasonZh,
        estimatedCostAvailable: false,
        profileHint:
          s.stepType === 'PROVISION_SERVER' && input.serverRecommendation
            ? `${input.serverRecommendation.vcpu ?? '?'} 核 ${input.serverRecommendation.memoryGb ?? '?'}G`
            : null,
      });
    }
  }

  // Deduplicate reuse by kind+id
  const reuseSeen = new Set<string>();
  const resourcesToReuseDedup = resourcesToReuse.filter((r) => {
    const k = `${r.kind}:${r.id ?? r.label}`;
    if (reuseSeen.has(k)) return false;
    reuseSeen.add(k);
    return true;
  });

  const apiReady = apiUnits.every((unit) => {
    const d = input.declared.units.find((u) => u.unitId === unit.id);
    const c = observed.containerObservedRunning?.[unit.id];
    const h = observed.healthObserved2xx?.[unit.id];
    return (
      isHealthyService(d?.serviceStatus, d?.healthStatus) &&
      observedOk(c, c != null) &&
      observedOk(h, h != null)
    );
  });
  const webReady =
    webUnits.length === 0 ||
    webUnits.every((unit) => {
      const d = input.declared.units.find((u) => u.unitId === unit.id);
      const c = observed.containerObservedRunning?.[unit.id];
      const h = observed.healthObserved2xx?.[unit.id];
      return (
        isHealthyService(d?.serviceStatus, d?.healthStatus) &&
        observedOk(c, c != null) &&
        observedOk(h, h != null)
      );
    });

  const desiredState: DesiredLaunchState = {
    dependenciesReady: depsReady,
    serverReady,
    allRequiredUnitsHealthy:
      (apiUnits.length === 0 || apiReady) && (webUnits.length === 0 || webReady),
    publicEntryActive: publicEntryReady,
    httpsValid: publicEntryReady && observed.certificateObservedValid !== false,
  };

  const currentDesiredStateSatisfied =
    desiredState.dependenciesReady &&
    desiredState.serverReady &&
    desiredState.allRequiredUnitsHealthy &&
    desiredState.publicEntryActive &&
    desiredState.httpsValid;

  const blockers: Array<{ code: string; messageZh: string }> = [];
  if (launchUnits.length === 0) {
    blockers.push({ code: 'NO_LAUNCH_UNITS', messageZh: '没有可上线的应用单元' });
  }
  if (requiresPg && !pgConnected) {
    blockers.push({ code: 'POSTGRESQL_REQUIRED', messageZh: '需要先准备数据库' });
  }
  if (requiresRedis && !redisConnected) {
    blockers.push({ code: 'REDIS_REQUIRED', messageZh: '需要先准备 Redis' });
  }
  if (!serverReady && !input.declared.server?.id) {
    blockers.push({
      code: 'SERVER_CONFIRMATION_REQUIRED',
      messageZh: '需要确认创建云服务器后才能继续',
    });
  }

  const requiresConfirmation = billableActions.length > 0;
  const suggestedRunStatus = blockers.some((b) => b.code === 'NO_LAUNCH_UNITS')
    ? 'BLOCKED'
    : requiresConfirmation
      ? 'WAITING_CONFIRMATION'
      : 'READY';

  const stages = LAUNCH_STAGES.map((stage) => {
    const stageSteps = steps.filter((s) => s.stage === stage);
    const decisions = new Set(stageSteps.map((s) => s.decision));
    let decisionSummary: LaunchStepDecision | 'MIXED' = 'SKIP';
    if (decisions.size === 1) decisionSummary = [...decisions][0]!;
    else if (decisions.size > 1) {
      if ([...decisions].every((d) => d === 'REUSE' || d === 'SKIP')) {
        decisionSummary = 'REUSE';
      } else {
        decisionSummary = 'MIXED';
      }
    }
    return {
      stage,
      labelZh: LAUNCH_STAGE_LABELS_ZH[stage],
      decisionSummary,
      status: decisionSummary === 'REUSE' || decisionSummary === 'SKIP' ? 'SUCCESS' : 'WAITING',
    };
  });

  const progress = computeLaunchProgress(
    steps.map((s) => ({
      stage: s.stage,
      decision: s.decision,
      status: s.decision === 'REUSE' || s.decision === 'SKIP' ? 'SUCCESS' : s.status,
    })),
  );

  const inputSnapshot = {
    planVersion,
    projectId: input.projectId,
    environmentId: input.environmentId,
    unitIds: launchUnits.map((u) => u.id),
    unitTypes: launchUnits.map((u) => u.type),
    requiresPostgresql: requiresPg,
    requiresRedis,
    postgresqlStatus: input.declared.postgresql.status,
    redisStatus: input.declared.redis.status,
    serverId: input.declared.server?.id ?? null,
    serverStatus: input.declared.server?.status ?? null,
    accessEntryStatus: input.declared.accessEntryStatus ?? null,
    serviceInstanceIds: input.declared.units.map((u) => u.serviceInstanceId).filter(Boolean),
    gatewayStatuses: input.declared.units.map((u) => ({
      unitId: u.unitId,
      status: u.gatewayStatus,
    })),
    // never include secrets / connection strings
  };

  return {
    planVersion,
    projectId: input.projectId,
    environmentId: input.environmentId,
    steps,
    stages,
    desiredState,
    currentDesiredStateSatisfied,
    dependenciesReady: depsReady,
    serverReady,
    apiReady: apiUnits.length === 0 ? true : apiReady,
    webReady,
    publicEntryReady,
    resourcesToReuse: resourcesToReuseDedup,
    resourcesToCreate,
    billableActions,
    requiresConfirmation,
    estimatedCostAvailable: billableActions.some((a) => a.estimatedCostAvailable),
    executionSteps: steps.filter((s) => s.decision === 'EXECUTE').map((s) => s.stepType),
    reuseSteps: steps.filter((s) => s.decision === 'REUSE').map((s) => s.stepType),
    skipSteps: steps.filter((s) => s.decision === 'SKIP').map((s) => s.stepType),
    blockers,
    canLaunch: !requiresConfirmation && blockers.length === 0 && launchUnits.length > 0,
    suggestedRunStatus: suggestedRunStatus === 'BLOCKED' ? 'WAITING_CONFIRMATION' : suggestedRunStatus,
    progress,
    inputSnapshot,
    observedFacts: observed,
    WRITE_COMMANDS_EXECUTED_THIS_RUN: false,
  };
}

/** Detect material plan drift before real execution (Phase 2+). */
export function detectPlanStale(
  snapshot: Record<string, unknown>,
  current: Record<string, unknown>,
): { stale: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const keys = [
    'serverId',
    'postgresqlStatus',
    'redisStatus',
    'accessEntryStatus',
    'unitIds',
  ] as const;
  for (const key of keys) {
    const a = JSON.stringify(snapshot[key] ?? null);
    const b = JSON.stringify(current[key] ?? null);
    if (a !== b) reasons.push(key);
  }
  return { stale: reasons.length > 0, reasons };
}

export type ResumeStepAction =
  | { action: 'REUSE'; reason: string }
  | { action: 'CONTINUE'; reason: string }
  | { action: 'RECONCILE_PROVIDER'; reason: string }
  | { action: 'RETRY'; reason: string }
  | { action: 'WAIT_USER'; reason: string };

/**
 * Resume rules: never blindly re-create billable resources mid-flight.
 */
export function planResumeStep(input: {
  stepType: string;
  stepStatus: string;
  billable: boolean;
  observedResourceExists?: boolean | null;
  failureCode?: string | null;
}): ResumeStepAction {
  if (input.stepStatus === 'SUCCESS' || input.stepStatus === 'SKIPPED') {
    return { action: 'REUSE', reason: 'already_done' };
  }
  if (input.stepStatus === 'RUNNING' && input.billable) {
    return {
      action: 'RECONCILE_PROVIDER',
      reason: 'billable_in_flight_must_reconcile',
    };
  }
  if (input.billable && input.observedResourceExists === true) {
    return { action: 'REUSE', reason: 'provider_resource_exists' };
  }
  if (input.failureCode) {
    const code = input.failureCode.toUpperCase();
    if (
      code.includes('INVALID_USER_CODE') ||
      code.includes('BUILD_FAIL') ||
      code.includes('SECRET_MISSING') ||
      code.includes('NOT_ENOUGH_BALANCE')
    ) {
      return { action: 'WAIT_USER', reason: code };
    }
  }
  if (input.stepStatus === 'RUNNING') {
    return { action: 'RECONCILE_PROVIDER', reason: 'reconcile_then_continue' };
  }
  return { action: 'CONTINUE', reason: 'resume_pending' };
}

/** Event names for analytics (never include secrets). */
export const LAUNCH_AUDIT_EVENTS = [
  'LAUNCH_PLAN_CREATED',
  'LAUNCH_STARTED',
  'LAUNCH_STAGE_STARTED',
  'LAUNCH_STEP_STARTED',
  'LAUNCH_STEP_REUSED',
  'LAUNCH_STEP_SUCCESS',
  'LAUNCH_STEP_FAILED',
  'LAUNCH_WAITING_CONFIRMATION',
  'LAUNCH_RESUMED',
  'LAUNCH_SUCCESS',
] as const;

export function assertLaunchEventSafe(metadata: Record<string, unknown>): void {
  const banned = /password|secret|connectionString|DATABASE_URL|REDIS_URL|credential|token/i;
  for (const [k, v] of Object.entries(metadata)) {
    if (banned.test(k)) throw new Error(`launch event forbids key: ${k}`);
    if (typeof v === 'string' && banned.test(v)) {
      throw new Error(`launch event forbids secret-like value for ${k}`);
    }
  }
}
