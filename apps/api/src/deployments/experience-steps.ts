import {
  CloudResourceStatus,
  DeploymentStatus,
  DeploymentStepStatus,
  HealthStatus,
  RemoteDeploymentStatus,
  ServiceStatus,
} from '@launchos/database';
import { defaultUnitDisplayName } from '../deployable-units/unit-product';

export type ExperienceStatus = 'SUCCESS' | 'RUNNING' | 'FAILED' | 'WAITING';

export type EngineStepSnapshot = {
  stepKey: string;
  status: DeploymentStepStatus;
  startedAt?: Date | string | null;
  finishedAt?: Date | string | null;
  errorMessage?: string | null;
  attempt?: number;
};

export type ExperienceStepView = {
  key: string;
  name: string;
  status: ExperienceStatus;
  detail: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  failureReason: string | null;
};

export type ExperienceProgressView = {
  currentAction: string | null;
  currentStepKey: string | null;
  currentStepStartedAt: string | null;
  lastActivityAt: string | null;
  unitLabel: string;
  unitType: string | null;
};

type BuildInput = {
  status: DeploymentStatus;
  serverInstanceId: string | null;
  steps: EngineStepSnapshot[];
  remoteDeployments: { status: RemoteDeploymentStatus }[];
  cloudResources: { status: CloudResourceStatus }[];
  service?: {
    status: ServiceStatus;
    healthStatus?: HealthStatus | null;
  } | null;
  deployableUnit?: {
    name: string;
    type: string;
    rootPath?: string | null;
  } | null;
  lastActivityAt?: Date | string | null;
  /** Beta M2 — artifact-reuse rollback uses friendlier product labels. */
  isRollback?: boolean;
};

const PRODUCT_ORDER = [
  'ANALYZE',
  'PREPARE_ENV',
  'BUILD_UPLOAD',
  'START_SERVICE',
  'GO_LIVE',
] as const;

type ProductKey = (typeof PRODUCT_ORDER)[number];

const PRODUCT_NAMES: Record<ProductKey, string> = {
  ANALYZE: '分析应用',
  PREPARE_ENV: '准备环境',
  BUILD_UPLOAD: '构建并上传',
  START_SERVICE: '启动服务',
  GO_LIVE: '完成上线',
};

const ROLLBACK_PRODUCT_NAMES: Record<ProductKey, string> = {
  ANALYZE: '准备历史版本',
  PREPARE_ENV: '准备历史版本',
  BUILD_UPLOAD: '准备历史版本',
  START_SERVICE: '启动服务',
  GO_LIVE: '切换访问入口',
};

const RUNNING_DETAILS: Record<ProductKey, (unit: string) => string> = {
  ANALYZE: (unit) => `正在分析${unit}…`,
  PREPARE_ENV: () => '正在准备运行环境…',
  BUILD_UPLOAD: (unit) => `正在构建并上传${unit}…`,
  START_SERVICE: (unit) => `正在启动${unit}服务…`,
  GO_LIVE: (unit) => `正在检查${unit}是否正常运行…`,
};

const ROLLBACK_RUNNING_DETAILS: Record<ProductKey, (unit: string) => string> = {
  ANALYZE: () => '正在准备历史版本…',
  PREPARE_ENV: () => '正在准备历史版本…',
  BUILD_UPLOAD: () => '正在准备历史版本…',
  START_SERVICE: (unit) => `正在启动${unit}服务…`,
  GO_LIVE: () => '正在切换访问入口并做公网检查…',
};

const CURRENT_ACTIONS: Record<ProductKey, (unit: string) => string> = {
  ANALYZE: (unit) => `正在分析${unit}`,
  PREPARE_ENV: () => '正在准备运行环境',
  BUILD_UPLOAD: (unit) => `正在构建并上传${unit}`,
  START_SERVICE: (unit) => `正在启动${unit}服务`,
  GO_LIVE: (unit) => `正在检查${unit}是否正常运行`,
};

const ROLLBACK_CURRENT_ACTIONS: Record<ProductKey, (unit: string) => string> = {
  ANALYZE: () => '正在准备历史版本',
  PREPARE_ENV: () => '正在准备历史版本',
  BUILD_UPLOAD: () => '正在准备历史版本',
  START_SERVICE: (unit) => `正在启动${unit}服务`,
  GO_LIVE: () => '正在切换访问入口',
};

const FAILURE_REASONS: Record<ProductKey, string> = {
  ANALYZE: '代码分析失败',
  PREPARE_ENV: '准备环境失败',
  BUILD_UPLOAD: '构建或上传失败',
  START_SERVICE: '服务启动失败',
  GO_LIVE: '健康检查失败',
};

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

function latestStepsByKey(steps: EngineStepSnapshot[]): Map<string, EngineStepSnapshot> {
  const map = new Map<string, EngineStepSnapshot>();
  for (const step of steps) {
    const current = map.get(step.stepKey);
    if (!current || (step.attempt ?? 0) >= (current.attempt ?? 0)) {
      map.set(step.stepKey, step);
    }
  }
  return map;
}

function fromEngine(status: DeploymentStepStatus | undefined): ExperienceStatus {
  if (!status || status === DeploymentStepStatus.PENDING) {
    return 'WAITING';
  }
  if (status === DeploymentStepStatus.RUNNING) {
    return 'RUNNING';
  }
  if (status === DeploymentStepStatus.FAILED) {
    return 'FAILED';
  }
  // SUCCESS and SKIPPED both count as completed for product aggregation
  return 'SUCCESS';
}

function combine(statuses: ExperienceStatus[]): ExperienceStatus {
  if (statuses.length === 0) {
    return 'WAITING';
  }
  if (statuses.includes('FAILED')) {
    return 'FAILED';
  }
  if (statuses.includes('RUNNING')) {
    return 'RUNNING';
  }
  if (statuses.every((item) => item === 'SUCCESS')) {
    return 'SUCCESS';
  }
  if (statuses.some((item) => item === 'SUCCESS') && statuses.some((item) => item === 'WAITING')) {
    return 'RUNNING';
  }
  return 'WAITING';
}

function earliestStarted(steps: EngineStepSnapshot[]): string | null {
  const times = steps
    .map((step) => toIso(step.startedAt))
    .filter((value): value is string => Boolean(value))
    .sort();
  return times[0] ?? null;
}

function latestFinished(steps: EngineStepSnapshot[]): string | null {
  const times = steps
    .map((step) => toIso(step.finishedAt))
    .filter((value): value is string => Boolean(value))
    .sort();
  return times[times.length - 1] ?? null;
}

function firstError(steps: EngineStepSnapshot[]): string | null {
  for (const step of steps) {
    if (step.status === DeploymentStepStatus.FAILED && step.errorMessage) {
      return step.errorMessage.split('\n')[0] || step.errorMessage;
    }
  }
  return null;
}

function pickEngine(
  byKey: Map<string, EngineStepSnapshot>,
  keys: string[],
): EngineStepSnapshot[] {
  return keys.map((key) => byKey.get(key)).filter((item): item is EngineStepSnapshot => Boolean(item));
}

function enforceSequential(statuses: ExperienceStatus[]): ExperienceStatus[] {
  const result = [...statuses];
  for (let i = 1; i < result.length; i += 1) {
    const previous = result[i - 1]!;
    if (previous === 'SUCCESS') {
      continue;
    }
    // Product UI must not show later completed/failed/running while earlier steps are incomplete.
    result[i] = 'WAITING';
  }
  return result;
}

function resolvePrepare(
  input: BuildInput,
  analyze: ExperienceStatus,
  active: boolean,
): ExperienceStatus {
  const cloud = input.cloudResources[0];
  if (cloud?.status === CloudResourceStatus.CREATING) {
    return analyze === 'SUCCESS' ? 'RUNNING' : 'WAITING';
  }
  if (cloud?.status === CloudResourceStatus.FAILED) {
    return 'FAILED';
  }
  if (input.serverInstanceId || cloud?.status === CloudResourceStatus.RUNNING) {
    if (analyze === 'SUCCESS') {
      return 'SUCCESS';
    }
    if (analyze === 'RUNNING' || (active && analyze === 'WAITING')) {
      return 'WAITING';
    }
    return 'WAITING';
  }
  if (analyze === 'SUCCESS' && active) {
    return 'RUNNING';
  }
  return 'WAITING';
}

function resolveGoLive(
  input: BuildInput,
  healthRaw: ExperienceStatus,
  startService: ExperienceStatus,
): ExperienceStatus {
  const service = input.service;
  const healthy =
    service?.status === ServiceStatus.RUNNING && service.healthStatus === HealthStatus.HEALTHY;

  if (input.status === DeploymentStatus.SUCCESS && healthy) {
    return 'SUCCESS';
  }

  if (healthRaw === 'FAILED') {
    return startService === 'SUCCESS' || startService === 'FAILED' ? 'FAILED' : 'WAITING';
  }

  if (input.status === DeploymentStatus.FAILED && startService === 'SUCCESS') {
    return 'FAILED';
  }

  if (startService !== 'SUCCESS') {
    return healthRaw === 'RUNNING' ? 'WAITING' : healthRaw;
  }

  // Start finished: go-live stays in progress until service is healthy.
  if (healthy) {
    return input.status === DeploymentStatus.SUCCESS ? 'SUCCESS' : 'RUNNING';
  }

  if (service?.healthStatus === HealthStatus.UNHEALTHY && input.status === DeploymentStatus.FAILED) {
    return 'FAILED';
  }

  if (healthRaw === 'RUNNING' || healthRaw === 'SUCCESS' || healthRaw === 'WAITING') {
    return 'RUNNING';
  }

  return healthRaw;
}

function failureReasonFor(key: ProductKey, engineSteps: EngineStepSnapshot[]): string {
  const message = firstError(engineSteps);
  if (key === 'BUILD_UPLOAD') {
    const build = engineSteps.find((step) => step.stepKey === 'BUILD_APPLICATION');
    const store = engineSteps.find((step) => step.stepKey === 'STORE_ARTIFACT');
    if (build?.status === DeploymentStepStatus.FAILED) {
      return '构建失败';
    }
    if (store?.status === DeploymentStepStatus.FAILED) {
      return '上传失败';
    }
  }
  if (key === 'GO_LIVE') {
    return message?.includes('Health') || message?.includes('健康')
      ? '健康检查失败'
      : FAILURE_REASONS.GO_LIVE;
  }
  if (message && key === 'ANALYZE') {
    return '代码分析失败';
  }
  if (key === 'START_SERVICE') {
    return '服务启动失败';
  }
  return FAILURE_REASONS[key];
}

export function buildExperienceProgress(input: BuildInput): {
  steps: ExperienceStepView[];
  progress: ExperienceProgressView;
} {
  const unitLabel = input.deployableUnit
    ? defaultUnitDisplayName(
        input.deployableUnit.type,
        input.deployableUnit.rootPath || '.',
        input.deployableUnit.name,
      )
    : '应用';

  const active =
    input.status === DeploymentStatus.CREATED ||
    input.status === DeploymentStatus.QUEUED ||
    input.status === DeploymentStatus.RUNNING;

  const byKey = latestStepsByKey(input.steps);
  const validate = pickEngine(byKey, ['VALIDATE_SOURCE']);
  const buildUpload = pickEngine(byKey, ['BUILD_APPLICATION', 'STORE_ARTIFACT']);
  const start = pickEngine(byKey, ['DEPLOY_APPLICATION', 'REMOTE_DEPLOY']);
  const health = pickEngine(byKey, ['HEALTH_CHECK']);

  let analyze = fromEngine(validate[0]?.status);
  if (active && analyze === 'WAITING' && !validate[0]) {
    analyze = 'RUNNING';
  }

  let prepare = resolvePrepare(input, analyze, active);

  let buildStatus = combine(buildUpload.map((step) => fromEngine(step.status)));
  // Fold remote upload progress that happens inside DEPLOY_APPLICATION into build/upload
  // only when STORE is done and DEPLOY is uploading — product label is "构建并上传".
  // DEPLOY_APPLICATION itself belongs to start service once artifact is stored.
  if (buildStatus === 'WAITING' && active && prepare === 'SUCCESS') {
    buildStatus = 'RUNNING';
  }

  const remoteRecord = input.remoteDeployments[0];
  const startParts = start.map((step) => fromEngine(step.status));
  if (remoteRecord?.status === RemoteDeploymentStatus.CONNECTING || remoteRecord?.status === RemoteDeploymentStatus.DEPLOYING) {
    startParts.push('RUNNING');
  } else if (remoteRecord?.status === RemoteDeploymentStatus.FAILED) {
    startParts.push('FAILED');
  } else if (remoteRecord?.status === RemoteDeploymentStatus.RUNNING) {
    startParts.push('SUCCESS');
  }
  let startStatus = startParts.length > 0 ? combine(startParts) : 'WAITING';
  if (startStatus === 'WAITING' && active && buildStatus === 'SUCCESS') {
    startStatus = 'RUNNING';
  }

  const healthRaw = fromEngine(health[0]?.status);
  let goLive = resolveGoLive(input, healthRaw, startStatus);
  if (goLive === 'WAITING' && active && startStatus === 'SUCCESS') {
    goLive = 'RUNNING';
  }

  // Full-success short-circuit only when deployment succeeded AND service healthy.
  const serviceHealthy =
    input.service?.status === ServiceStatus.RUNNING &&
    input.service.healthStatus === HealthStatus.HEALTHY;
  if (input.status === DeploymentStatus.SUCCESS && serviceHealthy) {
    analyze = 'SUCCESS';
    prepare = 'SUCCESS';
    buildStatus = 'SUCCESS';
    startStatus = 'SUCCESS';
    goLive = 'SUCCESS';
  }

  const ordered = enforceSequential([analyze, prepare, buildStatus, startStatus, goLive]);

  const engineGroups: Record<ProductKey, EngineStepSnapshot[]> = {
    ANALYZE: validate,
    PREPARE_ENV: [],
    BUILD_UPLOAD: buildUpload,
    START_SERVICE: start,
    GO_LIVE: health,
  };

  const names = input.isRollback ? ROLLBACK_PRODUCT_NAMES : PRODUCT_NAMES;
  const runningDetails = input.isRollback ? ROLLBACK_RUNNING_DETAILS : RUNNING_DETAILS;
  const currentActions = input.isRollback ? ROLLBACK_CURRENT_ACTIONS : CURRENT_ACTIONS;

  const steps: ExperienceStepView[] = PRODUCT_ORDER.map((key, index) => {
    const status = ordered[index]!;
    const group = engineGroups[key];
    const startedAt =
      key === 'PREPARE_ENV'
        ? status === 'SUCCESS' || status === 'RUNNING'
          ? earliestStarted(validate) || toIso(input.steps[0]?.startedAt)
          : null
        : earliestStarted(group);
    const finishedAt = status === 'SUCCESS' || status === 'FAILED' ? latestFinished(group) : null;
    const detail =
      status === 'RUNNING'
        ? runningDetails[key](unitLabel)
        : status === 'FAILED'
          ? failureReasonFor(key, group)
          : status === 'SUCCESS' && key === 'START_SERVICE'
            ? `${unitLabel}启动成功`
            : status === 'SUCCESS' && key === 'GO_LIVE' && input.isRollback
              ? '公网检查通过，版本已恢复'
              : null;
    return {
      key,
      name: names[key],
      status,
      detail,
      startedAt,
      finishedAt,
      failureReason: status === 'FAILED' ? failureReasonFor(key, group) : null,
    };
  });

  const current = steps.find((step) => step.status === 'RUNNING') ?? null;
  const lastEngineActivity = [...input.steps]
    .flatMap((step) => [toIso(step.finishedAt), toIso(step.startedAt)])
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);

  const waitingToStart =
    input.status === DeploymentStatus.QUEUED || input.status === DeploymentStatus.CREATED;

  const progress: ExperienceProgressView = {
    currentAction: waitingToStart
      ? input.isRollback
        ? '正在恢复版本…'
        : '正在等待上线任务开始…'
      : current
        ? currentActions[current.key as ProductKey](unitLabel)
        : null,
    currentStepKey: current?.key ?? null,
    currentStepStartedAt: current?.startedAt ?? null,
    lastActivityAt: toIso(input.lastActivityAt) || lastEngineActivity || null,
    unitLabel,
    unitType: input.deployableUnit?.type ?? null,
  };

  return { steps, progress };
}

export function shortFailureCause(steps: ExperienceStepView[], fallback: string | null): string {
  const failed = steps.find((step) => step.status === 'FAILED');
  if (failed?.failureReason) {
    return failed.failureReason;
  }
  if (fallback) {
    if (/health|健康/i.test(fallback)) {
      return '健康检查失败';
    }
    if (/build|构建/i.test(fallback)) {
      return '构建失败';
    }
    if (/upload|上传/i.test(fallback)) {
      return '上传失败';
    }
    if (/validate|分析|source/i.test(fallback)) {
      return '代码分析失败';
    }
    if (/start|启动|deploy/i.test(fallback)) {
      return '服务启动失败';
    }
  }
  return '上线失败';
}
