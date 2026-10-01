export type RedisErrorCode =
  | 'HOST_UNREACHABLE'
  | 'TIMEOUT'
  | 'AUTH_FAILED'
  | 'TLS_ERROR'
  | 'DNS_ERROR'
  | 'INVALID_DATABASE'
  | 'CONNECTION_RESET'
  | 'UNKNOWN';

const USER_MESSAGES: Record<RedisErrorCode, string> = {
  HOST_UNREACHABLE: 'Redis 服务无法连接',
  TIMEOUT: 'Redis 服务器没有响应',
  AUTH_FAILED: 'Redis 用户名或密码不正确。',
  TLS_ERROR: 'Redis TLS 配置不匹配',
  DNS_ERROR: 'Redis 地址无法解析',
  INVALID_DATABASE: 'Redis 数据库编号无效',
  CONNECTION_RESET: 'Redis 连接被重置',
  UNKNOWN: 'Redis 服务无法连接',
};

export function redisErrorUserMessage(code: RedisErrorCode): string {
  return USER_MESSAGES[code] ?? USER_MESSAGES.UNKNOWN;
}

export function classifyRedisError(error: unknown): {
  code: RedisErrorCode;
  technicalMessage: string;
} {
  const err = error as { code?: string; message?: string; name?: string };
  const message = String(err?.message ?? error ?? 'unknown');
  const lower = message.toLowerCase();
  const code = String(err?.code ?? '');

  if (code === 'ENOTFOUND' || lower.includes('getaddrinfo') || lower.includes('enotfound')) {
    return { code: 'DNS_ERROR', technicalMessage: 'DNS lookup failed' };
  }
  if (code === 'ETIMEDOUT' || code === 'TIMEOUT' || lower.includes('timeout') || lower.includes('timed out')) {
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
  if (code === 'ECONNRESET' || lower.includes('connection reset') || lower.includes('econnreset')) {
    return { code: 'CONNECTION_RESET', technicalMessage: 'Connection reset' };
  }
  if (
    lower.includes('wrongpass') ||
    lower.includes('noauth') ||
    lower.includes('invalid password') ||
    lower.includes('authentication required') ||
    (lower.includes('auth') && lower.includes('fail')) ||
    lower.includes('invalid username-password')
  ) {
    return { code: 'AUTH_FAILED', technicalMessage: 'Authentication failed' };
  }
  if (lower.includes('max retries per request')) {
    return { code: 'HOST_UNREACHABLE', technicalMessage: 'Host unreachable' };
  }
  if (lower.includes('ssl') || lower.includes('tls') || lower.includes('certificate')) {
    return { code: 'TLS_ERROR', technicalMessage: 'TLS error' };
  }
  if (lower.includes('invalid db index') || lower.includes('db index is out of range')) {
    return { code: 'INVALID_DATABASE', technicalMessage: 'Invalid database index' };
  }
  return { code: 'UNKNOWN', technicalMessage: 'Connection failed' };
}
