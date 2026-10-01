/**
 * Step 28 — Deployment reliability & safe release (pure helpers).
 * Candidate runtime → verify → switch traffic → keep old briefly → rollback.
 */
import { redactSecrets } from './secret-redaction.js';

export const DEPLOYMENT_EXECUTION_STAGES = [
  'QUEUED',
  'PREPARING',
  'FETCHING_SOURCE',
  'BUILDING',
  'PACKAGING',
  'UPLOADING',
  'STARTING_RUNTIME',
  'VERIFYING_RUNTIME',
  'PREPARING_PUBLIC_ENTRY',
  'SWITCHING_TRAFFIC',
  'VERIFYING_PUBLIC',
  'SUCCESS',
  'FAILED',
] as const;

export type DeploymentExecutionStage = (typeof DEPLOYMENT_EXECUTION_STAGES)[number];

export const DEPLOYMENT_STAGE_USER_LABELS: Record<DeploymentExecutionStage, string> = {
  QUEUED: '等待上线',
  PREPARING: '准备代码',
  FETCHING_SOURCE: '准备代码',
  BUILDING: '构建应用',
  PACKAGING: '构建应用',
  UPLOADING: '构建应用',
  STARTING_RUNTIME: '启动应用',
  VERIFYING_RUNTIME: '检查应用',
  PREPARING_PUBLIC_ENTRY: '切换新版本',
  SWITCHING_TRAFFIC: '切换新版本',
  VERIFYING_PUBLIC: '切换新版本',
  SUCCESS: '上线完成',
  FAILED: '上线失败',
};

export const DEPLOYMENT_FAILURE_CODES = [
  'SOURCE_FETCH_FAILED',
  'BUILD_FAILED',
  'ARTIFACT_UPLOAD_FAILED',
  'SSH_CONNECTION_FAILED',
  'RUNTIME_START_FAILED',
  'PORT_BIND_FAILED',
  'CONTAINER_EXITED',
  'RUNTIME_HEALTHCHECK_FAILED',
  'PUBLIC_ENTRY_FAILED',
  'DNS_FAILED',
  'TLS_FAILED',
  'PUBLIC_HEALTHCHECK_FAILED',
  'DEPLOYMENT_TIMEOUT',
  'WORKER_INTERRUPTED',
  'DEPLOYMENT_ALREADY_RUNNING',
  'UNKNOWN_DEPLOYMENT_FAILURE',
] as const;

export type DeploymentFailureCode = (typeof DEPLOYMENT_FAILURE_CODES)[number];

export const DEPLOYMENT_FAILURE_USER_MESSAGES: Record<DeploymentFailureCode, string> = {
  SOURCE_FETCH_FAILED: '获取代码失败，请检查仓库地址与分支。',
  BUILD_FAILED: '构建失败。当前线上版本未改动。',
  ARTIFACT_UPLOAD_FAILED: '上传应用包失败，请稍后重试。',
  SSH_CONNECTION_FAILED: '无法连接托管服务器，请稍后重试。当前线上版本未改动。',
  RUNTIME_START_FAILED: '新版本启动失败，已保留当前线上版本。',
  PORT_BIND_FAILED: '运行端口分配失败，已保留当前线上版本。',
  CONTAINER_EXITED: '新版本启动后立即退出，已保留当前线上版本。',
  RUNTIME_HEALTHCHECK_FAILED: '新版本未通过健康检查，已保留当前线上版本。',
  PUBLIC_ENTRY_FAILED: '公网入口配置失败，已保留当前线上版本。',
  DNS_FAILED: '域名解析未就绪，已保留当前线上版本。',
  TLS_FAILED: 'HTTPS 证书未就绪，已保留当前线上版本。',
  PUBLIC_HEALTHCHECK_FAILED: '公网访问验证失败，已尝试回切旧版本。',
  DEPLOYMENT_TIMEOUT: '上线超时，已停止本次发布。当前线上版本未改动。',
  WORKER_INTERRUPTED: '上线服务中断，请重新尝试。当前线上版本未改动。',
  DEPLOYMENT_ALREADY_RUNNING: '该环境正在上线，请等待当前任务完成。',
  UNKNOWN_DEPLOYMENT_FAILURE: '上线失败，已保留当前线上版本。',
};

export const ACTIVE_DEPLOYMENT_STATUSES = ['CREATED', 'QUEUED', 'RUNNING'] as const;

export const OLD_RUNTIME_GRACE_MS = 10 * 60_000;

export const DEPLOYMENT_STAGE_TIMEOUT_MS = {
  FETCHING_SOURCE: 5 * 60_000,
  BUILDING: 15 * 60_000,
  PACKAGING: 15 * 60_000,
  UPLOADING: 10 * 60_000,
  STARTING_RUNTIME: 5 * 60_000,
  VERIFYING_RUNTIME: 3 * 60_000,
  PREPARING_PUBLIC_ENTRY: 3 * 60_000,
  SWITCHING_TRAFFIC: 2 * 60_000,
  VERIFYING_PUBLIC: 2 * 60_000,
  OVERALL: 45 * 60_000,
} as const;

export type DeploymentStageRecord = {
  stage: DeploymentExecutionStage;
  status: 'RUNNING' | 'SUCCESS' | 'FAILED' | 'SKIPPED';
  startedAt: string;
  finishedAt?: string | null;
  durationMs?: number | null;
  errorCode?: DeploymentFailureCode | string | null;
};

export function environmentDeploymentLockKey(projectId: string, environmentId: string): string {
  return `deployment-env:${projectId}:${environmentId}`;
}

export function deploymentStageIdempotencyKey(input: {
  deploymentId: string;
  stage: string;
  attempt: number | string;
}): string {
  return `deploy-stage:${input.deploymentId}:${input.stage}:${input.attempt}`;
}

export function deploymentRequestIdempotencyKey(input: {
  projectId: string;
  environmentId: string;
  clientKey: string;
}): string {
  return `deploy-req:${input.projectId}:${input.environmentId}:${input.clientKey.trim()}`;
}

export function isActiveDeploymentStatus(status: string | null | undefined): boolean {
  return (ACTIVE_DEPLOYMENT_STATUSES as readonly string[]).includes(String(status || '').toUpperCase());
}

export function beginStageRecord(
  stage: DeploymentExecutionStage,
  now = new Date(),
): DeploymentStageRecord {
  return {
    stage,
    status: 'RUNNING',
    startedAt: now.toISOString(),
    finishedAt: null,
    durationMs: null,
    errorCode: null,
  };
}

export function finishStageRecord(
  record: DeploymentStageRecord,
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED',
  options?: { errorCode?: string | null; now?: Date },
): DeploymentStageRecord {
  const now = options?.now ?? new Date();
  const started = Date.parse(record.startedAt);
  return {
    ...record,
    status,
    finishedAt: now.toISOString(),
    durationMs: Number.isFinite(started) ? Math.max(0, now.getTime() - started) : null,
    errorCode: options?.errorCode ?? record.errorCode ?? null,
  };
}

export function appendStageHistory(
  history: unknown,
  next: DeploymentStageRecord,
  limit = 40,
): DeploymentStageRecord[] {
  const prev = Array.isArray(history)
    ? history.filter((item): item is DeploymentStageRecord => {
        return Boolean(item && typeof item === 'object' && 'stage' in item);
      })
    : [];
  return [...prev, next].slice(-limit);
}

export function classifyDeploymentFailure(message: string): {
  code: DeploymentFailureCode;
  userMessage: string;
} {
  const text = String(message || '');
  const pick = (code: DeploymentFailureCode) => ({
    code,
    userMessage: DEPLOYMENT_FAILURE_USER_MESSAGES[code],
  });

  if (/DEPLOYMENT_ALREADY_RUNNING|正在上线/i.test(text)) return pick('DEPLOYMENT_ALREADY_RUNNING');
  if (/WORKER_INTERRUPTED|worker interrupted|上线服务中断/i.test(text)) return pick('WORKER_INTERRUPTED');
  // Prefer concrete build/install root causes over timeout/start wrappers.
  if (
    /DEPENDENCY_INSTALL_FAILED|BUILD_IMAGE_FAILED|BUILD_FAILED|npm ERR!|npm error|yarn error|pnpm ERR|prisma generate|Could not find Prisma Schema|ERESOLVE|ETARGET|building at STEP \"RUN npm|building at STEP \"RUN pnpm|building at STEP \"RUN yarn|docker build.*npm install|postinstall/i.test(
      text,
    )
  ) {
    return pick('BUILD_FAILED');
  }
  if (/HEALTH_CHECK_FAILED|RUNTIME_HEALTHCHECK|健康检查|没有响应|health check/i.test(text)) {
    return pick('RUNTIME_HEALTHCHECK_FAILED');
  }
  if (/DEPLOYMENT_TIMEOUT|上线超时|step timed out|stall/i.test(text)) return pick('DEPLOYMENT_TIMEOUT');
  if (/SSH_CONNECTION_FAILED|SSH |ECONNREFUSED.*:22|All configured authentication|Timed out while waiting for handshake|Cannot connect/i.test(text)) {
    return pick('SSH_CONNECTION_FAILED');
  }
  if (/SOURCE_FETCH_FAILED|git clone|fetch failed|Repository not found/i.test(text)) {
    return pick('SOURCE_FETCH_FAILED');
  }
  if (/ARTIFACT_UPLOAD_FAILED|upload failed|MinIO|S3|NoSuchBucket/i.test(text)) {
    return pick('ARTIFACT_UPLOAD_FAILED');
  }
  if (/PORT_BIND_FAILED|port.*in use|address already in use|EADDRINUSE|端口/i.test(text)) {
    return pick('PORT_BIND_FAILED');
  }
  if (/PUBLIC_HEALTHCHECK_FAILED|公网访问验证失败|PUBLIC_VERIFY_FAILED/i.test(text)) {
    return pick('PUBLIC_HEALTHCHECK_FAILED');
  }
  if (/PUBLIC_ENTRY_FAILED|GATEWAY_|nginx -t|route regression/i.test(text)) return pick('PUBLIC_ENTRY_FAILED');
  if (/DNS_FAILED|dns/i.test(text)) return pick('DNS_FAILED');
  if (/TLS_FAILED|certificate|ssl/i.test(text)) return pick('TLS_FAILED');
  if (/exited|dead|CONTAINER_EXITED|not running/i.test(text)) return pick('CONTAINER_EXITED');
  if (/RUNTIME_START_FAILED|CONTAINER_START_FAILED|启动失败|Unable to find image|podman run|docker run/i.test(text)) {
    return pick('RUNTIME_START_FAILED');
  }
  return pick('UNKNOWN_DEPLOYMENT_FAILURE');
}

export function isTransientDeploymentFailure(code: string | null | undefined): boolean {
  const value = String(code || '').toUpperCase();
  return (
    value === 'SSH_CONNECTION_FAILED' ||
    value === 'ARTIFACT_UPLOAD_FAILED' ||
    value === 'PUBLIC_HEALTHCHECK_FAILED' ||
    value === 'WORKER_INTERRUPTED' ||
    value === 'DEPLOYMENT_TIMEOUT'
  );
}

export function shouldAutoRetryDeploymentFailure(code: string | null | undefined): boolean {
  const value = String(code || '').toUpperCase();
  if (
    value === 'BUILD_FAILED' ||
    value === 'SOURCE_FETCH_FAILED' ||
    value === 'CONTAINER_EXITED' ||
    value === 'RUNTIME_START_FAILED' ||
    value === 'RUNTIME_HEALTHCHECK_FAILED' ||
    value === 'PORT_BIND_FAILED' ||
    value === 'DEPLOYMENT_ALREADY_RUNNING'
  ) {
    return false;
  }
  return isTransientDeploymentFailure(value);
}

export function sanitizeDeploymentFailureDetail(detail: string): string {
  return redactSecrets(String(detail || '')).slice(0, 800);
}

export function formatReadableReleaseLabel(input: {
  createdAt: Date | string;
  sequence?: number | null;
}): string {
  const date = new Date(input.createdAt);
  if (!Number.isFinite(date.getTime())) {
    return input.sequence != null ? `Release #${input.sequence}` : 'Release';
  }
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  if (input.sequence != null) {
    return `v${y}.${m}.${d}-${hh}${mm} (#${input.sequence})`;
  }
  return `v${y}.${m}.${d}-${hh}${mm}`;
}

export function planReleasePointers(input: {
  activeDeploymentId: string | null | undefined;
  previousDeploymentId: string | null | undefined;
  nextSuccessfulDeploymentId: string;
}): { activeDeploymentId: string; previousDeploymentId: string | null } {
  const next = input.nextSuccessfulDeploymentId;
  if (!input.activeDeploymentId || input.activeDeploymentId === next) {
    return {
      activeDeploymentId: next,
      previousDeploymentId: input.previousDeploymentId ?? null,
    };
  }
  return {
    activeDeploymentId: next,
    previousDeploymentId: input.activeDeploymentId,
  };
}

export function planRollbackTarget(input: {
  activeDeploymentId: string | null | undefined;
  previousDeploymentId: string | null | undefined;
}): { ok: true; toDeploymentId: string } | { ok: false; code: string; message: string } {
  if (!input.previousDeploymentId) {
    return { ok: false, code: 'ROLLBACK_TARGET_MISSING', message: '没有可回滚的上一成功版本。' };
  }
  if (input.previousDeploymentId === input.activeDeploymentId) {
    return { ok: false, code: 'ROLLBACK_TARGET_INVALID', message: '回滚目标与当前版本相同。' };
  }
  return { ok: true, toDeploymentId: input.previousDeploymentId };
}

export function decideTrafficSwitch(input: {
  candidateHealthy: boolean;
  publicEntryReady: boolean;
  tlsOrDnsReady: boolean;
}): { canSwitch: boolean; reason?: string } {
  if (!input.candidateHealthy) return { canSwitch: false, reason: 'candidate unhealthy' };
  if (!input.publicEntryReady) return { canSwitch: false, reason: 'public entry not ready' };
  if (!input.tlsOrDnsReady) return { canSwitch: false, reason: 'tls/dns not ready' };
  return { canSwitch: true };
}

export function decidePostSwitchRollback(input: {
  publicHealthy: boolean;
  previousTarget: { host: string; port: number } | null;
}): { action: 'keep' | 'rollback_route' | 'fail_no_previous' } {
  if (input.publicHealthy) return { action: 'keep' };
  if (input.previousTarget) return { action: 'rollback_route' };
  return { action: 'fail_no_previous' };
}

export function shouldCleanupOldRuntime(input: {
  switchedAt: Date | string;
  now?: Date;
  graceMs?: number;
}): boolean {
  const switched = new Date(input.switchedAt).getTime();
  if (!Number.isFinite(switched)) return false;
  const now = (input.now ?? new Date()).getTime();
  return now - switched >= (input.graceMs ?? OLD_RUNTIME_GRACE_MS);
}

export function mapEngineStepToExecutionStage(stepKey: string): DeploymentExecutionStage {
  const key = String(stepKey || '').toUpperCase();
  if (key.includes('CLONE') || key.includes('FETCH') || key.includes('SOURCE')) return 'FETCHING_SOURCE';
  if (key.includes('BUILD') || key.includes('ANALYZE')) return 'BUILDING';
  if (key.includes('PACK') || key.includes('IMAGE')) return 'PACKAGING';
  if (key.includes('UPLOAD') || key.includes('TRANSFER')) return 'UPLOADING';
  if (key.includes('START') || key.includes('RUN') || key.includes('CONTAINER')) return 'STARTING_RUNTIME';
  if (key.includes('HEALTH') || key.includes('VERIFY_RUNTIME')) return 'VERIFYING_RUNTIME';
  if (key.includes('GATEWAY') || key.includes('DOMAIN') || key.includes('ENTRY')) {
    return 'PREPARING_PUBLIC_ENTRY';
  }
  if (key.includes('SWITCH') || key.includes('CUTOVER')) return 'SWITCHING_TRAFFIC';
  if (key.includes('PUBLIC')) return 'VERIFYING_PUBLIC';
  return 'PREPARING';
}

export type GatewayRouteDesired = {
  hostname: string;
  targetHost: string;
  targetPort: number;
};

export function detectGatewayRouteDrift(input: {
  desired: GatewayRouteDesired;
  actual: GatewayRouteDesired | null;
}): { drifted: boolean; reason?: string } {
  if (!input.actual) return { drifted: true, reason: 'actual route missing' };
  if (input.desired.hostname !== input.actual.hostname) {
    return { drifted: true, reason: 'hostname mismatch' };
  }
  if (input.desired.targetHost !== input.actual.targetHost) {
    return { drifted: true, reason: 'target host mismatch' };
  }
  if (input.desired.targetPort !== input.actual.targetPort) {
    return { drifted: true, reason: 'target port mismatch' };
  }
  return { drifted: false };
}

export function reconcileStaleRunningDecision(input: {
  status: string;
  lastActivityAt: Date | string | null | undefined;
  hasActiveJob: boolean;
  leaseExpired: boolean;
  observed: 'running_healthy' | 'running_unhealthy' | 'missing' | 'unknown';
}): { action: 'continue' | 'requeue' | 'fail'; code?: DeploymentFailureCode } {
  if (!isActiveDeploymentStatus(input.status) && String(input.status).toUpperCase() !== 'RUNNING') {
    return { action: 'continue' };
  }
  if (input.hasActiveJob && !input.leaseExpired) return { action: 'continue' };
  if (input.observed === 'running_healthy' && input.hasActiveJob) return { action: 'continue' };
  if (!input.hasActiveJob && input.observed === 'missing') {
    return { action: 'fail', code: 'WORKER_INTERRUPTED' };
  }
  if (input.leaseExpired && input.observed === 'unknown') {
    return { action: 'requeue' };
  }
  if (input.leaseExpired && input.observed === 'running_unhealthy') {
    return { action: 'fail', code: 'RUNTIME_HEALTHCHECK_FAILED' };
  }
  if (!input.hasActiveJob) return { action: 'requeue' };
  return { action: 'continue' };
}
