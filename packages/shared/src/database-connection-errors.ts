export type DatabaseErrorCode =
  | 'HOST_UNREACHABLE'
  | 'TIMEOUT'
  | 'AUTH_FAILED'
  | 'DATABASE_NOT_FOUND'
  | 'SSL_ERROR'
  | 'DNS_ERROR'
  | 'UNKNOWN';

export type DatabaseTestLocation = 'CONTROL_PLANE' | 'TARGET_SERVER';

const USER_MESSAGES: Record<DatabaseErrorCode, string> = {
  HOST_UNREACHABLE: '无法连接数据库',
  TIMEOUT: '数据库服务器没有响应',
  AUTH_FAILED: '数据库用户名或密码不正确。',
  DATABASE_NOT_FOUND: '找不到这个数据库',
  SSL_ERROR: 'SSL 配置不匹配',
  DNS_ERROR: '无法解析数据库地址',
  UNKNOWN: '无法连接数据库',
};

export function databaseErrorUserMessage(code: DatabaseErrorCode): string {
  return USER_MESSAGES[code] ?? USER_MESSAGES.UNKNOWN;
}

/**
 * Classify postgres/node connection errors without embedding secrets.
 */
export function classifyDatabaseError(error: unknown): {
  code: DatabaseErrorCode;
  technicalMessage: string;
} {
  const err = error as {
    code?: string;
    message?: string;
    errno?: string | number;
    syscall?: string;
  };
  const message = String(err?.message ?? error ?? 'unknown');
  const lower = message.toLowerCase();
  const code = String(err?.code ?? '');

  if (code === 'ENOTFOUND' || lower.includes('getaddrinfo') || lower.includes('enotfound')) {
    return { code: 'DNS_ERROR', technicalMessage: 'DNS lookup failed' };
  }
  if (
    code === 'ETIMEDOUT' ||
    code === 'TIMEOUT' ||
    lower.includes('timeout') ||
    lower.includes('timed out')
  ) {
    return { code: 'TIMEOUT', technicalMessage: 'Connection timed out' };
  }
  if (
    code === 'ECONNREFUSED' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    lower.includes('econnrefused') ||
    lower.includes('unreachable')
  ) {
    return { code: 'HOST_UNREACHABLE', technicalMessage: 'Host unreachable' };
  }
  if (
    code === '28P01' ||
    code === '28000' ||
    lower.includes('password authentication failed') ||
    lower.includes('authentication failed') ||
    lower.includes('role') && lower.includes('does not exist')
  ) {
    return { code: 'AUTH_FAILED', technicalMessage: 'Authentication failed' };
  }
  if (
    code === '3D000' ||
    lower.includes('database') && lower.includes('does not exist')
  ) {
    return { code: 'DATABASE_NOT_FOUND', technicalMessage: 'Database not found' };
  }
  if (
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    lower.includes('ssl') ||
    lower.includes('certificate')
  ) {
    return { code: 'SSL_ERROR', technicalMessage: 'SSL error' };
  }
  return { code: 'UNKNOWN', technicalMessage: 'Connection failed' };
}

export function redactDatabaseSecrets(
  text: string,
  secrets: Array<string | null | undefined>,
): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 3) continue;
    out = out.split(secret).join('[REDACTED]');
  }
  out = out.replace(/postgresql:\/\/[^\s"']+/gi, 'postgresql://[REDACTED]');
  return out;
}
