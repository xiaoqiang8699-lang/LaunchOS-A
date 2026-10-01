import { randomBytes } from 'node:crypto';

export type DatabaseProvisionPhase =
  | 'QUEUED'
  | 'CREATING_INSTANCE'
  | 'PREPARING_NETWORK'
  | 'CREATING_ACCOUNT'
  | 'TESTING_CONNECTION'
  | 'BINDING'
  | 'DONE'
  | 'FAILED';

export type DatabaseProvisionTier = 'DEV' | 'SMALL' | 'STANDARD';

export type CloudDatabaseErrorCode =
  | 'PERMISSION_DENIED'
  | 'QUOTA_EXCEEDED'
  | 'REGION_UNAVAILABLE'
  | 'SPEC_UNAVAILABLE'
  | 'NETWORK_CONFIG_ERROR'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_ERROR'
  | 'RDS_CONNECTION_ENDPOINT_MISSING'
  | 'CONNECTION_TEST_FAILED'
  | 'UNKNOWN';

const USER_MESSAGES: Record<CloudDatabaseErrorCode, string> = {
  PERMISSION_DENIED: '当前阿里云账号缺少数据库创建权限。',
  QUOTA_EXCEEDED: '当前阿里云账号配额不足，无法创建数据库。',
  REGION_UNAVAILABLE: '当前地区暂时无法创建。',
  SPEC_UNAVAILABLE: '当前规格不可用。',
  NETWORK_CONFIG_ERROR: '数据库网络配置失败。',
  PROVIDER_TIMEOUT: '云服务请求超时。',
  PROVIDER_ERROR: '云服务请求失败。',
  RDS_CONNECTION_ENDPOINT_MISSING: '数据库连接地址暂时未准备好，请稍后重试。',
  CONNECTION_TEST_FAILED: '数据库已创建，但目标服务器连接测试失败。',
  UNKNOWN: '数据库创建失败。',
};

export function cloudDatabaseErrorUserMessage(
  code: CloudDatabaseErrorCode,
  technicalMessage?: string | null,
): string {
  const technical = technicalMessage || '';
  if (/servicelinkedrole|service linked role/i.test(technical)) {
    return '阿里云 PostgreSQL 服务授权尚未完成。';
  }
  if (/invalidconcurrentoperate|concurrent operation/i.test(technical)) {
    return '云服务检测到并发操作冲突，请稍后重试。';
  }
  if (/connecttimeout|timed out|timeout/i.test(technical) && /rds\.aliyuncs\.com|aliyun/i.test(technical)) {
    return '连接阿里云数据库服务超时，请稍后重试。';
  }
  return USER_MESSAGES[code] ?? USER_MESSAGES.UNKNOWN;
}

export function classifyCloudDatabaseError(error: unknown): {
  code: CloudDatabaseErrorCode;
  technicalMessage: string;
} {
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'RDS_CONNECTION_ENDPOINT_MISSING'
  ) {
    return {
      code: 'RDS_CONNECTION_ENDPOINT_MISSING',
      technicalMessage: 'RDS_CONNECTION_ENDPOINT_MISSING',
    };
  }
  const message = readErrorText(error);
  const lower = message.toLowerCase();
  if (
    lower.includes('rds_connection_endpoint_missing') ||
    lower.includes('connection endpoint missing') ||
    lower.includes('rds connection endpoint missing')
  ) {
    return {
      code: 'RDS_CONNECTION_ENDPOINT_MISSING',
      technicalMessage: 'RDS_CONNECTION_ENDPOINT_MISSING',
    };
  }
  if (
    lower.includes('forbidden') ||
    lower.includes('unauthorized') ||
    lower.includes('notauthorized') ||
    lower.includes('no permission') ||
    lower.includes('nopermission') ||
    lower.includes('accessdenied') ||
    lower.includes('forbidden.ram') ||
    lower.includes('ram.permission') ||
    lower.includes('rampermissiondenied') ||
    lower.includes('permission denied') ||
    lower.includes('servicelinkedrole') ||
    lower.includes('service linked role')
  ) {
    return { code: 'PERMISSION_DENIED', technicalMessage: 'Permission denied' };
  }
  if (lower.includes('quota') || lower.includes('limitexceeded') || lower.includes('insufficientbalance')) {
    return { code: 'QUOTA_EXCEEDED', technicalMessage: 'Quota exceeded' };
  }
  if (lower.includes('invalidregion') || lower.includes('region not support') || lower.includes('unavailablezone')) {
    return { code: 'REGION_UNAVAILABLE', technicalMessage: 'Region unavailable' };
  }
  if (
    lower.includes('invaliddbinstanceclass') ||
    lower.includes('instance class') ||
    lower.includes('unsupported class')
  ) {
    return { code: 'SPEC_UNAVAILABLE', technicalMessage: 'Spec unavailable' };
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('connecttimeout')) {
    return { code: 'PROVIDER_TIMEOUT', technicalMessage: 'Provider timeout' };
  }
  if (/invalidconcurrentoperate|concurrent operation/i.test(lower)) {
    return { code: 'PROVIDER_ERROR', technicalMessage: 'Concurrent operation' };
  }
  if (
    lower.includes('invalidvpc') ||
    lower.includes('invalidvswitch') ||
    lower.includes('securityip') ||
    lower.includes('network config') ||
    lower.includes('network_config')
  ) {
    return { code: 'NETWORK_CONFIG_ERROR', technicalMessage: 'Network config error' };
  }
  return { code: 'PROVIDER_ERROR', technicalMessage: 'Provider error' };
}

function readErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null) {
    const record = error as { message?: string; data?: { Message?: string; Code?: string } };
    return [record.data?.Code, record.data?.Message, record.message].filter(Boolean).join(' ');
  }
  return String(error ?? '');
}

export function sanitizeDatabaseName(input: string, fallback = 'launchos_app'): string {
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  const base = cleaned.length > 0 ? cleaned : fallback;
  const prefixed = base.startsWith('launchos_') ? base : `launchos_${base}`;
  return prefixed.slice(0, 63);
}

export function generateManagedDbPassword(): string {
  const token = randomBytes(12).toString('base64url');
  // Aliyun RDS requires complexity: upper/lower/digit/special
  return `Lo!${token}A9`;
}

export function generateManagedDbUsername(projectSlug: string): string {
  const base = sanitizeDatabaseName(projectSlug, 'app').replace(/^launchos_/, '');
  const name = `lo_${base}`.replace(/[^a-z0-9_]/g, '_').slice(0, 16);
  return name.length >= 2 ? name : 'lo_app';
}

export const DATABASE_PROVISION_PHASE_LABELS: Record<DatabaseProvisionPhase, string> = {
  QUEUED: '正在等待数据库创建任务开始',
  CREATING_INSTANCE: '正在创建云数据库',
  PREPARING_NETWORK: '正在准备网络',
  CREATING_ACCOUNT: '正在创建账号',
  TESTING_CONNECTION: '正在验证连接',
  BINDING: '正在绑定应用',
  DONE: '完成',
  FAILED: '失败',
};

export const DATABASE_PROVISION_QUEUE_STALL_USER_MESSAGE =
  '数据库创建服务暂时不可用，任务将在服务恢复后继续。';

