/**
 * Step 25.5 Dependency Engine v1 — product domain types & pure helpers.
 * Truth sources remain RuntimeConfigRequirement + Connection + CloudResource.
 */

export type DependencyType =
  | 'POSTGRESQL'
  | 'REDIS'
  | 'OBJECT_STORAGE'
  | 'MESSAGE_QUEUE'
  | 'CUSTOM';

/** User-facing dependency lifecycle status. */
export type DependencyStatus =
  | 'NOT_REQUIRED'
  | 'MISSING'
  | 'CONFIGURING'
  | 'CONNECTED'
  | 'NEEDS_REDEPLOY'
  | 'DEGRADED'
  | 'UNAVAILABLE'
  | 'ERROR';

export type ProjectDependencyAggregateStatus =
  | 'READY'
  | 'ACTION_REQUIRED'
  | 'CONFIGURING'
  | 'DEGRADED';

export type DependencyHealthStatus = 'HEALTHY' | 'UNHEALTHY' | 'UNKNOWN';

export type DependencyErrorCode =
  | 'DEPENDENCY_MISSING'
  | 'DEPENDENCY_UNREACHABLE'
  | 'DEPENDENCY_AUTH_FAILED'
  | 'DEPENDENCY_LOCKED'
  | 'DEPENDENCY_PROVIDER_ERROR'
  | 'DEPENDENCY_NEEDS_REDEPLOY';

/** Unified product phases across PostgreSQL / Redis provision UIs. */
export type ProductDependencyPhase =
  | 'PREPARING_RESOURCE'
  | 'PREPARING_NETWORK'
  | 'PREPARING_ACCESS'
  | 'TESTING'
  | 'BINDING'
  | 'DONE'
  | 'FAILED';

export type DependencyRequirementKeyMap = {
  type: DependencyType;
  keys: string[];
  label: string;
  supported: boolean;
};

export const DEPENDENCY_REQUIREMENT_MAP: DependencyRequirementKeyMap[] = [
  {
    type: 'POSTGRESQL',
    keys: ['DATABASE_URL'],
    label: '数据库',
    supported: true,
  },
  {
    type: 'REDIS',
    keys: ['REDIS_URL'],
    label: 'Redis',
    supported: true,
  },
  {
    type: 'OBJECT_STORAGE',
    keys: ['S3_ENDPOINT', 'S3_BUCKET', 'OSS_ENDPOINT', 'OSS_BUCKET'],
    label: '对象存储',
    supported: false,
  },
  {
    type: 'MESSAGE_QUEUE',
    keys: ['AMQP_URL', 'RABBITMQ_URL', 'KAFKA_BROKERS'],
    label: '消息队列',
    supported: false,
  },
];

export const DEPENDENCY_TYPE_LABELS: Record<DependencyType, string> = {
  POSTGRESQL: '数据库',
  REDIS: 'Redis',
  OBJECT_STORAGE: '对象存储',
  MESSAGE_QUEUE: '消息队列',
  CUSTOM: '其他依赖',
};

export const DEPENDENCY_STATUS_LABELS: Record<DependencyStatus, string> = {
  NOT_REQUIRED: '不需要',
  MISSING: '未连接',
  CONFIGURING: '正在配置',
  CONNECTED: '已连接',
  NEEDS_REDEPLOY: '需要重新上线',
  DEGRADED: '不稳定',
  UNAVAILABLE: '不可用',
  ERROR: '配置失败',
};

export const PROJECT_DEPENDENCY_STATUS_LABELS: Record<
  ProjectDependencyAggregateStatus,
  string
> = {
  READY: '全部正常',
  ACTION_REQUIRED: '需要处理',
  CONFIGURING: '正在配置',
  DEGRADED: '部分异常',
};

export const PRODUCT_DEPENDENCY_PHASE_LABELS: Record<ProductDependencyPhase, string> = {
  PREPARING_RESOURCE: '准备资源',
  PREPARING_NETWORK: '准备网络',
  PREPARING_ACCESS: '准备访问',
  TESTING: '测试连接',
  BINDING: '绑定应用',
  DONE: '完成',
  FAILED: '失败',
};

export function mapRequirementKeyToDependencyType(key: string): DependencyType | null {
  const upper = key.trim().toUpperCase();
  for (const entry of DEPENDENCY_REQUIREMENT_MAP) {
    if (entry.keys.includes(upper)) return entry.type;
  }
  return null;
}

export function requirementKeysForDependencyType(type: DependencyType): string[] {
  return DEPENDENCY_REQUIREMENT_MAP.find((e) => e.type === type)?.keys ?? [];
}

export function isSupportedDependencyType(type: DependencyType): boolean {
  return DEPENDENCY_REQUIREMENT_MAP.find((e) => e.type === type)?.supported === true;
}

/**
 * Detect dependency types declared by a unit from requirement keys.
 * Unsupported future types are omitted unless present in keys (still reported as required placeholders).
 */
export function detectDependenciesFromRequirementKeys(
  keys: string[],
): Array<{
  type: DependencyType;
  required: boolean;
  sourceRequirementKeys: string[];
  supported: boolean;
}> {
  const upperKeys = keys.map((k) => k.trim().toUpperCase()).filter(Boolean);
  const results: Array<{
    type: DependencyType;
    required: boolean;
    sourceRequirementKeys: string[];
    supported: boolean;
  }> = [];

  for (const entry of DEPENDENCY_REQUIREMENT_MAP) {
    const matched = entry.keys.filter((k) => upperKeys.includes(k));
    if (matched.length === 0) continue;
    if (!entry.supported && matched.length === 0) continue;
    results.push({
      type: entry.type,
      required: true,
      sourceRequirementKeys: matched,
      supported: entry.supported,
    });
  }
  return results;
}

/** Map CloudResource / provision phase strings to unified product phases. */
export function mapProvisionPhaseToProductPhase(
  phase: string | null | undefined,
): ProductDependencyPhase | null {
  if (!phase) return null;
  const p = phase.toUpperCase();
  if (p === 'DONE') return 'DONE';
  if (p === 'FAILED') return 'FAILED';
  if (
    p === 'QUEUED' ||
    p === 'CREATING_INSTANCE' ||
    p === 'WAITING_INSTANCE' ||
    p === 'CREATING'
  ) {
    return 'PREPARING_RESOURCE';
  }
  if (p === 'PREPARING_NETWORK') return 'PREPARING_NETWORK';
  if (
    p === 'PREPARING_AUTH' ||
    p === 'PREPARING_ACCOUNT' ||
    p === 'CREATING_ACCOUNT'
  ) {
    return 'PREPARING_ACCESS';
  }
  if (p === 'TESTING_CONNECTION' || p === 'TESTING') return 'TESTING';
  if (p === 'BINDING') return 'BINDING';
  return 'PREPARING_RESOURCE';
}

export function resolveDependencyStatus(input: {
  required: boolean;
  hasBinding: boolean;
  connectionStatus?: string | null;
  cloudResourceStatus?: string | null;
  cloudResourcePhase?: string | null;
  needsRedeploy?: boolean;
  lastTestStatus?: string | null;
  healthStatus?: DependencyHealthStatus | null;
}): DependencyStatus {
  if (!input.required) return 'NOT_REQUIRED';

  const phase = (input.cloudResourcePhase || '').toUpperCase();
  const crStatus = (input.cloudResourceStatus || '').toUpperCase();
  if (
    crStatus === 'CREATING' ||
    (phase &&
      phase !== 'DONE' &&
      phase !== 'FAILED' &&
      ['QUEUED', 'CREATING_INSTANCE', 'WAITING_INSTANCE', 'PREPARING_NETWORK', 'PREPARING_AUTH', 'PREPARING_ACCOUNT', 'TESTING_CONNECTION', 'BINDING', 'CREATING'].includes(
        phase,
      ))
  ) {
    return 'CONFIGURING';
  }
  if (phase === 'FAILED' || crStatus === 'FAILED') {
    return 'ERROR';
  }

  if (!input.hasBinding) return 'MISSING';

  const conn = (input.connectionStatus || '').toUpperCase();
  if (conn === 'UNAVAILABLE' || crStatus === 'DELETED' || crStatus === 'DELETING') {
    return 'UNAVAILABLE';
  }
  if (conn === 'FAILED' || input.lastTestStatus === 'FAILED') {
    return 'DEGRADED';
  }
  if (input.healthStatus === 'UNHEALTHY') {
    return 'DEGRADED';
  }
  if (input.needsRedeploy) {
    return 'NEEDS_REDEPLOY';
  }
  if (conn === 'CONNECTED' || conn === 'UNTESTED' || input.hasBinding) {
    return 'CONNECTED';
  }
  return 'CONNECTED';
}

export function aggregateProjectDependencyStatus(
  unitDependencies: Array<{ required: boolean; status: DependencyStatus }>,
): {
  status: ProjectDependencyAggregateStatus;
  required: number;
  connected: number;
  missing: number;
  configuring: number;
  degraded: number;
} {
  const requiredItems = unitDependencies.filter((d) => d.required);
  const required = requiredItems.length;
  let connected = 0;
  let missing = 0;
  let configuring = 0;
  let degraded = 0;

  for (const item of requiredItems) {
    if (item.status === 'CONNECTED' || item.status === 'NEEDS_REDEPLOY') connected++;
    if (item.status === 'MISSING') missing++;
    if (item.status === 'CONFIGURING') configuring++;
    if (
      item.status === 'DEGRADED' ||
      item.status === 'UNAVAILABLE' ||
      item.status === 'ERROR'
    ) {
      degraded++;
    }
  }

  let status: ProjectDependencyAggregateStatus = 'READY';
  if (configuring > 0) status = 'CONFIGURING';
  else if (missing > 0 || requiredItems.some((d) => d.status === 'ERROR')) {
    status = 'ACTION_REQUIRED';
  } else if (degraded > 0) status = 'DEGRADED';
  else status = 'READY';

  return { status, required, connected, missing, configuring, degraded };
}

export function dependencyErrorUserMessage(code: DependencyErrorCode): string {
  switch (code) {
    case 'DEPENDENCY_MISSING':
      return '依赖尚未连接';
    case 'DEPENDENCY_UNREACHABLE':
      return '依赖服务目前无法连接，请检查服务状态。';
    case 'DEPENDENCY_AUTH_FAILED':
      return '依赖服务认证失败，请检查访问凭证。';
    case 'DEPENDENCY_LOCKED':
      return '云资源当前不可用（可能已锁定或欠费），请先在云控制台处理。';
    case 'DEPENDENCY_PROVIDER_ERROR':
      return '云服务请求失败，请稍后重试。';
    case 'DEPENDENCY_NEEDS_REDEPLOY':
      return '依赖已更新，需要重新上线后生效。';
    default:
      return '依赖检查未通过。';
  }
}

export type DependencyDeployBlocker = {
  dependencyType: DependencyType;
  code: DependencyErrorCode | string;
  userMessage: string;
};

export function buildDeployValidationResult(blockers: DependencyDeployBlocker[]): {
  ready: boolean;
  blockers: DependencyDeployBlocker[];
} {
  return { ready: blockers.length === 0, blockers };
}
