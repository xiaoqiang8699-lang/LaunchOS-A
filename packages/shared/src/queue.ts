export const DEPLOYMENT_QUEUE = 'deploymentQueue';
export const SYSTEM_CERT_QUEUE = 'systemCertQueue';
export const DATABASE_PROVISION_QUEUE = 'databaseProvisionQueue';
export const REDIS_PROVISION_QUEUE = 'redisProvisionQueue';
export const SERVER_PROVISION_QUEUE = 'serverProvisionQueue';
export const SERVER_INITIALIZATION_QUEUE = 'serverInitializationQueue';
export const DEPLOYMENT_WORKER_SERVICE = 'deployment-worker';

export const DEFAULT_DEPLOYMENT_MAX_RETRY = 3;
export const DEFAULT_CERT_RENEW_BEFORE_DAYS = 30;

/** Worker heartbeat interval (10–15s). */
export const WORKER_HEARTBEAT_INTERVAL_MS = 12_000;
/** API considers worker offline if lastSeenAt older than this. */
export const WORKER_ONLINE_THRESHOLD_MS = 45_000;
/** QUEUED without pickup → stall / requeue. */
export const QUEUE_STALL_MS = 120_000;
/** RUNNING without lastActivityAt progress and no active job → stall. */
export const RUNNING_STALL_MS = 10 * 60_000;

export type DeploymentJobData = {
  deploymentId: string;
};

export type SystemCertJobData = {
  kind: 'check' | 'renew';
  rootDomain?: string;
  force?: boolean;
  dryRun?: boolean;
};

export type DatabaseProvisionJobData = {
  cloudResourceId: string;
  operationId: string;
};

export type RedisResolvedSkuJobFields = {
  tier: string;
  instanceClass: string;
  engineVersion: string;
  storageType: string;
  capacityMb?: number;
  zoneId?: string;
  architecture?: string;
  availabilityFingerprint?: string;
};

export type RedisProvisionJobData = {
  cloudResourceId: string;
  operationId: string;
  /** Echo of CloudResource resolved SKU — Worker must still prefer metadata, never re-map from tier alone. */
  resolvedSku?: RedisResolvedSkuJobFields;
};

export type ServerProvisionJobData = {
  cloudResourceId: string;
  operationId: string;
};

export type ServerInitializationJobData = {
  serverInstanceId: string;
  projectId: string;
  workspaceId: string;
  operationId: string;
};

/** Stable job id — one init chain per ServerInstance. */
export function serverInitializationJobId(serverInstanceId: string): string {
  return `server-initialize-${serverInstanceId}`;
}

export function systemTlsRenewJobId(rootDomain: string): string {
  return `system-tls-renew-${rootDomain.trim().toLowerCase()}`;
}

export function deploymentJobId(deploymentId: string): string {
  return `deployment-${deploymentId}`;
}

export function databaseProvisionJobId(cloudResourceId: string): string {
  return `db-provision-${cloudResourceId}`;
}

export function redisProvisionJobId(cloudResourceId: string): string {
  return `redis-provision-${cloudResourceId}`;
}

/**
 * Stable, generation-scoped job id.
 * Same generation → idempotent retry (remove/retry same id).
 * New generation → new job id (old failed job cannot block).
 */
export function serverProvisionJobId(
  cloudResourceId: string,
  createGeneration: number = 1,
): string {
  const gen = Math.max(1, Math.floor(Number(createGeneration) || 1));
  return `server-provision-${cloudResourceId}-g${gen}`;
}

/** Legacy job id used before generation-scoped ids (Step 26.2 early). */
export function serverProvisionLegacyJobId(cloudResourceId: string): string {
  return `server-provision-${cloudResourceId}`;
}

export function readCertRenewBeforeDays(): number {
  const raw = Number(process.env.LAUNCHOS_CERT_RENEW_BEFORE_DAYS);
  if (Number.isInteger(raw) && raw > 0) {
    return raw;
  }
  return DEFAULT_CERT_RENEW_BEFORE_DAYS;
}

export type RedisConnectionOptions = {
  host: string;
  port: number;
  username?: string;
  password?: string;
};

export function getRedisUrl(): string {
  const url = process.env.REDIS_URL?.trim();
  return url && url.length > 0 ? url : 'redis://127.0.0.1:6379';
}

/** Safe Redis endpoint label for logs (no password). */
export function getRedisEndpointLabel(): string {
  try {
    const parsed = new URL(getRedisUrl());
    return `${parsed.hostname || '127.0.0.1'}:${parsed.port || '6379'}`;
  } catch {
    return '127.0.0.1:6379';
  }
}

export function getRedisConnection(): RedisConnectionOptions {
  const parsed = new URL(getRedisUrl());
  const username = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);

  return {
    host: parsed.hostname || '127.0.0.1',
    port: Number(parsed.port || 6379),
    username: username.length > 0 ? username : undefined,
    password: password.length > 0 ? password : undefined,
  };
}

const RETRYABLE_PATTERNS: RegExp[] = [
  /\bECONNRESET\b/i,
  /\bETIMEDOUT\b/i,
  /\bECONNREFUSED\b/i,
  /\bENOTFOUND\b/i,
  /\bsocket hang up\b/i,
  /\bnetwork\b/i,
  /\bredis\b/i,
  /\bconnection (lost|closed|terminated|reset)\b/i,
  /\bssh\b/i,
  /\bbroken pipe\b/i,
  /\btemporar(y|ily)\b/i,
  /\btry again\b/i,
  /\bworker (exited|stopped|offline)\b/i,
];

const NON_RETRYABLE_PATTERNS: RegExp[] = [
  /\bbuild (failed|error)\b/i,
  /\bnpm ERR!\b/i,
  /\bunsupported\b/i,
  /\bconfig(uration)? error\b/i,
  /\bsyntax error\b/i,
  /\btypeerror\b/i,
  /\bmodule not found\b/i,
  /\bcannot find module\b/i,
  /\binvalid transition\b/i,
  /\b暂不支持\b/,
  /\b构建失败\b/,
  /\b配置错误\b/,
];

/**
 * Infrastructure / transient failures may retry.
 * Build/config/product errors must not burn attempts.
 */
export function isRetryableDeploymentError(message: string): boolean {
  const text = message?.trim() || '';
  if (!text) {
    return true;
  }
  if (NON_RETRYABLE_PATTERNS.some((re) => re.test(text))) {
    return false;
  }
  if (RETRYABLE_PATTERNS.some((re) => re.test(text))) {
    return true;
  }
  // Default: do not retry unknown application failures.
  return false;
}
