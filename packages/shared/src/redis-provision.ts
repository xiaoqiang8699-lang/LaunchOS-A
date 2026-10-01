import { randomBytes } from 'node:crypto';

export type RedisProvisionPhase =
  | 'QUEUED'
  | 'CREATING_INSTANCE'
  | 'WAITING_INSTANCE'
  | 'PREPARING_NETWORK'
  | 'PREPARING_AUTH'
  | 'TESTING_CONNECTION'
  | 'BINDING'
  | 'DONE'
  | 'FAILED';

export type RedisProvisionTier = 'DEV' | 'SMALL' | 'STANDARD';

/** Fully resolved purchasable Redis SKU — persisted on CloudResource and reused by Worker. */
export type RedisResolvedSku = {
  tier: RedisProvisionTier;
  instanceClass: string;
  engineVersion: string;
  storageType: string;
  capacityMb?: number;
  zoneId?: string;
  architecture?: string;
  selectionReason?: string;
  fallbackReason?: string;
  availabilityFingerprint?: string;
};

export type CloudRedisErrorCode =
  | 'PERMISSION_DENIED'
  | 'QUOTA_EXCEEDED'
  | 'REGION_UNAVAILABLE'
  | 'SPEC_UNAVAILABLE'
  | 'NETWORK_CONFIG_ERROR'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_LOCKED'
  | 'REDIS_CONNECTION_ENDPOINT_MISSING'
  | 'REDIS_RECONCILE_AMBIGUOUS'
  | 'REDIS_SKU_NOT_AVAILABLE'
  | 'REDIS_BILLING_INSUFFICIENT_BALANCE'
  | 'REDIS_BILLING_ACCOUNT_INVALID'
  | 'REDIS_BILLING_UNSETTLED_BILL'
  | 'REDIS_BILLING_ORDER_FAILED'
  | 'CONNECTION_TEST_FAILED'
  | 'UNKNOWN';

const USER_MESSAGES: Record<CloudRedisErrorCode, string> = {
  PERMISSION_DENIED: '当前阿里云账号缺少 Redis 创建权限。',
  QUOTA_EXCEEDED: '当前阿里云账号配额不足，无法创建 Redis。',
  REGION_UNAVAILABLE: '当前地区暂时无法创建 Redis。',
  SPEC_UNAVAILABLE: '当前 Redis 规格不可用。',
  NETWORK_CONFIG_ERROR: 'Redis 网络配置失败。',
  PROVIDER_TIMEOUT: '云服务请求超时。',
  PROVIDER_ERROR: '云服务请求失败。',
  PROVIDER_LOCKED: '阿里云账号或 Redis 实例当前不可用，请先在阿里云处理后继续。',
  REDIS_CONNECTION_ENDPOINT_MISSING: 'Redis 连接地址暂时未准备好，请稍后重试。',
  REDIS_RECONCILE_AMBIGUOUS: '检测到多台同名 Redis，已停止自动绑定，请人工确认。',
  REDIS_SKU_NOT_AVAILABLE:
    '当前选择的 Redis 规格暂时不可用，LaunchOS 正在重新选择可用规格。',
  REDIS_BILLING_INSUFFICIENT_BALANCE:
    '阿里云账户余额不足，暂时无法创建 Redis，请先充值后继续。',
  REDIS_BILLING_ACCOUNT_INVALID:
    '阿里云账户状态异常，暂时无法创建 Redis，请先在阿里云完成账户处理后继续。',
  REDIS_BILLING_UNSETTLED_BILL:
    '阿里云账户存在未结清账单，暂时无法创建 Redis，请先处理账单后继续。',
  REDIS_BILLING_ORDER_FAILED:
    '阿里云下单失败，暂时无法创建 Redis，请检查账户与支付状态后继续。',
  CONNECTION_TEST_FAILED: 'Redis 已创建，但目标服务器连接测试失败。',
  UNKNOWN: 'Redis 创建失败。',
};

export function cloudRedisErrorUserMessage(
  code: CloudRedisErrorCode,
  technicalMessage?: string | null,
): string {
  const technical = technicalMessage || '';
  if (/servicelinkedrole|service linked role/i.test(technical)) {
    return '阿里云 Redis 服务授权尚未完成。首次使用可能需要完成云服务授权。';
  }
  if (/incorrectdbinstancelockmode|lock mode|arrears|suspended|expired/i.test(technical)) {
    return USER_MESSAGES.PROVIDER_LOCKED;
  }
  if (/invalidconcurrentoperate|concurrent operation/i.test(technical)) {
    return '云服务检测到并发操作冲突，请稍后重试。';
  }
  // Prefer billing / business codes over timeout copy when both appear in text.
  const billing = classifyBillingFromText(technical);
  if (billing) return USER_MESSAGES[billing];
  // Only show timeout copy for classified PROVIDER_TIMEOUT (or clear transport tokens).
  // Never use a loose /timeout/ match that can collide with unrelated messages.
  if (code === 'PROVIDER_TIMEOUT') {
    return '连接阿里云 Redis 服务超时，请稍后重试。';
  }
  return USER_MESSAGES[code] ?? USER_MESSAGES.UNKNOWN;
}

function redactSensitiveQuery(text: string): string {
  return text
    .replace(/([?&](?:Password|password|PassWord)=)[^&"'\s]*/g, '$1***')
    .replace(/([?&](?:AccessKeySecret|SecretKey|secretKey)=)[^&"'\s]*/g, '$1***');
}

function readErrorText(error: unknown): string {
  if (error instanceof Error) return redactSensitiveQuery(error.message);
  if (typeof error === 'object' && error !== null) {
    const record = error as { message?: string; data?: { Message?: string; Code?: string } };
    return redactSensitiveQuery(
      [record.data?.Code, record.data?.Message, record.message].filter(Boolean).join(' '),
    );
  }
  return redactSensitiveQuery(String(error ?? ''));
}

/** Walk error / cause / SDK data for structured Aliyun fields. Prefer SDK over message scrape. */
export function extractAliyunSdkErrorFields(error: unknown): {
  code: string | null;
  message: string | null;
  requestId: string | null;
  statusCode: number | null;
} {
  let cur: unknown = error;
  const seen = new Set<unknown>();
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const rec = cur as Record<string, unknown>;
    const data =
      rec.data && typeof rec.data === 'object'
        ? (rec.data as Record<string, unknown>)
        : null;
    const codeCandidates = [
      rec.code,
      rec.Code,
      data?.Code,
      data?.code,
      rec.name,
    ];
    const code =
      codeCandidates.find(
        (c): c is string =>
          typeof c === 'string' &&
          c.trim().length > 0 &&
          c !== 'Error' &&
          !c.startsWith('REDIS_') &&
          !c.startsWith('CONNECTION_') &&
          !c.startsWith('PROVIDER_') &&
          !c.startsWith('BOUND_') &&
          !c.startsWith('CREATE_') &&
          c !== 'PERMISSION_DENIED' &&
          c !== 'QUOTA_EXCEEDED' &&
          c !== 'SPEC_UNAVAILABLE' &&
          c !== 'NETWORK_CONFIG_ERROR' &&
          c !== 'UNKNOWN',
      ) || null;
    const messageCandidates = [rec.message, data?.Message, data?.message];
    const message =
      messageCandidates.find((m): m is string => typeof m === 'string' && m.trim().length > 0) ||
      null;
    const requestIdCandidates = [
      rec.requestId,
      rec.RequestId,
      data?.RequestId,
      data?.requestId,
    ];
    const requestId =
      requestIdCandidates.find((r): r is string => typeof r === 'string' && r.trim().length > 0) ||
      null;
    const statusCandidates = [rec.statusCode, rec.status, data?.statusCode, data?.HttpStatusCode];
    let statusCode: number | null = null;
    for (const s of statusCandidates) {
      if (typeof s === 'number' && Number.isFinite(s)) {
        statusCode = s;
        break;
      }
      if (typeof s === 'string' && /^\d{3}$/.test(s)) {
        statusCode = Number(s);
        break;
      }
    }
    // Accept ConnectTimeout / ReadTimeout style SDK codes even without requestId.
    if (code || requestId || statusCode != null) {
      return {
        code: code ? String(code).trim() : null,
        message: message ? redactSensitiveQuery(message) : null,
        requestId,
        statusCode,
      };
    }
    // Message-only Aliyun errors: "MissingParameter: code: 400, ... request id: XXX"
    if (message) {
      const scraped = scrapeAliyunErrorMessage(message);
      if (scraped.code || scraped.requestId || scraped.statusCode != null) {
        return {
          code: scraped.code,
          message: redactSensitiveQuery(message),
          requestId: scraped.requestId,
          statusCode: scraped.statusCode,
        };
      }
    }
    cur = rec.cause ?? null;
  }
  if (error instanceof Error && error.message) {
    const scraped = scrapeAliyunErrorMessage(error.message);
    if (scraped.code || scraped.requestId || scraped.statusCode != null) {
      return {
        code: scraped.code,
        message: redactSensitiveQuery(error.message),
        requestId: scraped.requestId,
        statusCode: scraped.statusCode,
      };
    }
  }
  return { code: null, message: null, requestId: null, statusCode: null };
}

function scrapeAliyunErrorMessage(message: string): {
  code: string | null;
  requestId: string | null;
  statusCode: number | null;
} {
  const text = String(message || '');
  const codeMatch =
    text.match(/^([A-Za-z][A-Za-z0-9_.]+)\s*:/) ||
    text.match(/\bcode:\s*([A-Za-z][A-Za-z0-9_.]+)\b/i);
  // Prefer leading business code (MissingParameter) over numeric HTTP in "code: 400"
  let code: string | null = null;
  const leading = text.match(/^([A-Za-z][A-Za-z0-9_.]+)\s*:/);
  if (leading?.[1] && !/^\d+$/.test(leading[1])) code = leading[1];
  else if (codeMatch?.[1] && !/^\d+$/.test(codeMatch[1])) code = codeMatch[1];
  const requestIdMatch = text.match(/request id:\s*([0-9A-Fa-f-]+)/i);
  const httpMatch = text.match(/\bcode:\s*(\d{3})\b/i) || text.match(/\bstatus(?:Code)?:\s*(\d{3})\b/i);
  return {
    code,
    requestId: requestIdMatch?.[1] || null,
    statusCode: httpMatch?.[1] ? Number(httpMatch[1]) : null,
  };
}

function parseProviderCodeFromMessage(text: string): string | null {
  // Never treat URL query parameter names as provider codes (EngineVersion=5.0).
  const withoutQuery = text.replace(/https?:\/\/[^\s]+/gi, (url) => {
    try {
      const u = new URL(url.replace(/failed\.?$/i, ''));
      return `${u.origin}${u.pathname}`;
    } catch {
      return url.replace(/\?[^.\s]*/g, '');
    }
  });

  // Prefer dotted Aliyun business codes: PAY.INSUFFICIENT_BALANCE, EngineVersion.NotSupportOnLocalDisk
  const dotted =
    withoutQuery.match(
      /\b((?:PAY|ORDER|Forbidden|Invalid|ServiceLinkedRole|EngineVersion|Quota|Redis)[A-Za-z0-9]*(?:\.[A-Za-z0-9_]+)+)\b/,
    ) || withoutQuery.match(/\b([A-Z][A-Za-z0-9]+(?:\.[A-Z][A-Za-z0-9_]+)+)\b/);
  if (dotted?.[1] && !/\.but$/i.test(dotted[1])) {
    return dotted[1];
  }

  // SDK transport codes (not query params): ConnectTimeout / ReadTimeout at message head
  const transport = withoutQuery.match(
    /\b(ConnectTimeout|ReadTimeout|ECONNRESET|ETIMEDOUT|SocketHangUp)\b/i,
  );
  if (transport?.[1]) {
    return transport[1];
  }

  return null;
}

/** Extract structured Aliyun KVStore error fields from SDK / wrapped messages. */
export function parseAliyunRedisProviderError(error: unknown): {
  providerErrorCode: string | null;
  providerErrorMessage: string;
  providerRequestId: string | null;
  httpStatus: number | null;
} {
  const sdk = extractAliyunSdkErrorFields(error);
  const text = sdk.message || readErrorText(error);
  const fromMessage = sdk.code ? null : parseProviderCodeFromMessage(text);
  const requestIdMatch = text.match(/request id:\s*([A-Za-z0-9-]+)/i);
  const httpMatch =
    text.match(/\bcode:\s*(\d{3})\b/i) || text.match(/\bstatus(?:Code)?:\s*(\d{3})\b/i);

  let providerErrorCode = sdk.code || fromMessage;
  // Never treat prose fragments like "order.but" as provider codes.
  if (providerErrorCode && /^[a-z]/.test(providerErrorCode) && !/^(econnreset|etimedout)$/i.test(providerErrorCode)) {
    providerErrorCode = null;
  }
  if (providerErrorCode && /\.but$/i.test(providerErrorCode)) {
    providerErrorCode = null;
  }
  // Reject bare query-param lookalikes when message still contains Param=value for that name.
  if (
    providerErrorCode &&
    !providerErrorCode.includes('.') &&
    !/^(ConnectTimeout|ReadTimeout|ECONNRESET|ETIMEDOUT|Forbidden|Unauthorized)$/i.test(
      providerErrorCode,
    ) &&
    new RegExp(`[?&]${providerErrorCode}=`, 'i').test(text)
  ) {
    providerErrorCode = parseProviderCodeFromMessage(text) || null;
    if (
      providerErrorCode &&
      !providerErrorCode.includes('.') &&
      new RegExp(`[?&]${providerErrorCode}=`, 'i').test(text)
    ) {
      // Still a query-param false positive — fall back to transport code if present.
      const transport = text.match(/\b(ConnectTimeout|ReadTimeout|ECONNRESET|ETIMEDOUT)\b/i);
      providerErrorCode = transport?.[1] || null;
    }
  }

  return {
    providerErrorCode,
    providerErrorMessage: redactSensitiveQuery(text).slice(0, 1500),
    providerRequestId: sdk.requestId || requestIdMatch?.[1] || null,
    httpStatus: sdk.statusCode ?? (httpMatch?.[1] ? Number(httpMatch[1]) : null),
  };
}

function classifyBillingFromText(message: string): CloudRedisErrorCode | null {
  const lower = message.toLowerCase();
  if (
    lower.includes('pay.insufficient_balance') ||
    lower.includes('insufficient_balance') ||
    lower.includes('insufficient balance') ||
    lower.includes('account balance is insufficient')
  ) {
    return 'REDIS_BILLING_INSUFFICIENT_BALANCE';
  }
  if (
    lower.includes('order.account_status_illegal') ||
    lower.includes('account_status_illegal') ||
    lower.includes('account status illegal')
  ) {
    return 'REDIS_BILLING_ACCOUNT_INVALID';
  }
  if (
    lower.includes('order.inst_has_unsettled_bills') ||
    lower.includes('unsettled_bills') ||
    lower.includes('unsettled bill')
  ) {
    return 'REDIS_BILLING_UNSETTLED_BILL';
  }
  if (
    lower.includes('pay.pay_order_failed') ||
    /pay\.[a-z0-9_]+/i.test(message) ||
    /order\.[a-z0-9_]+/i.test(message)
  ) {
    if (/insufficient/i.test(message)) return 'REDIS_BILLING_INSUFFICIENT_BALANCE';
    return 'REDIS_BILLING_ORDER_FAILED';
  }
  return null;
}

export function isRedisBillingUserActionError(code: CloudRedisErrorCode): boolean {
  return (
    code === 'REDIS_BILLING_INSUFFICIENT_BALANCE' ||
    code === 'REDIS_BILLING_ACCOUNT_INVALID' ||
    code === 'REDIS_BILLING_UNSETTLED_BILL' ||
    code === 'REDIS_BILLING_ORDER_FAILED'
  );
}

export function classifyCloudRedisError(error: unknown): {
  code: CloudRedisErrorCode;
  technicalMessage: string;
  retryableAfterUserAction?: boolean;
  providerErrorCode?: string | null;
  providerRequestId?: string | null;
  httpStatus?: number | null;
} {
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'CONNECTION_TEST_FAILED'
  ) {
    return {
      code: 'CONNECTION_TEST_FAILED',
      technicalMessage: 'CONNECTION_TEST_FAILED: Target Server Redis PING failed',
    };
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'REDIS_CONNECTION_ENDPOINT_MISSING'
  ) {
    return {
      code: 'REDIS_CONNECTION_ENDPOINT_MISSING',
      technicalMessage: 'REDIS_CONNECTION_ENDPOINT_MISSING',
    };
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'REDIS_RECONCILE_AMBIGUOUS'
  ) {
    return {
      code: 'REDIS_RECONCILE_AMBIGUOUS',
      technicalMessage: 'REDIS_RECONCILE_AMBIGUOUS',
    };
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'REDIS_SKU_NOT_AVAILABLE'
  ) {
    return {
      code: 'REDIS_SKU_NOT_AVAILABLE',
      technicalMessage: 'REDIS_SKU_NOT_AVAILABLE',
    };
  }
  const parsed = parseAliyunRedisProviderError(error);
  const message = parsed.providerErrorMessage;
  const lower = message.toLowerCase();
  const billing = classifyBillingFromText(message);
  if (billing) {
    return {
      code: billing,
      technicalMessage: message.slice(0, 1500),
      retryableAfterUserAction: true,
      providerErrorCode: parsed.providerErrorCode,
      providerRequestId: parsed.providerRequestId,
      httpStatus: parsed.httpStatus,
    };
  }
  if (
    lower.includes('lock mode') ||
    lower.includes('incorrectdbinstancelockmode') ||
    lower.includes('arrears') ||
    lower.includes('suspended') ||
    lower.includes('expired') ||
    lower.includes('instance is locked')
  ) {
    return {
      code: 'PROVIDER_LOCKED',
      technicalMessage: message.slice(0, 1500),
      providerErrorCode: parsed.providerErrorCode,
      providerRequestId: parsed.providerRequestId,
      httpStatus: parsed.httpStatus,
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
    lower.includes('permission denied') ||
    lower.includes('servicelinkedrole') ||
    lower.includes('service linked role')
  ) {
    return {
      code: 'PERMISSION_DENIED',
      technicalMessage: message.slice(0, 1500),
      providerErrorCode: parsed.providerErrorCode,
      providerRequestId: parsed.providerRequestId,
      httpStatus: parsed.httpStatus,
    };
  }
  if (lower.includes('quota') || lower.includes('limitexceeded')) {
    return {
      code: 'QUOTA_EXCEEDED',
      technicalMessage: message.slice(0, 1500),
      providerErrorCode: parsed.providerErrorCode,
      providerRequestId: parsed.providerRequestId,
      httpStatus: parsed.httpStatus,
    };
  }
  if (lower.includes('invalidregion') || lower.includes('region not support') || lower.includes('unavailablezone')) {
    return {
      code: 'REGION_UNAVAILABLE',
      technicalMessage: message.slice(0, 1500),
      providerErrorCode: parsed.providerErrorCode,
      providerRequestId: parsed.providerRequestId,
      httpStatus: parsed.httpStatus,
    };
  }
  if (
    lower.includes('redis_sku_not_available') ||
    lower.includes('engineversion.notsupportonlocaldisk') ||
    lower.includes('notsupportonlocaldisk') ||
    lower.includes('invalidinstanceclass') ||
    lower.includes('instance class') ||
    lower.includes('unsupported class')
  ) {
    if (
      lower.includes('redis_sku_not_available') ||
      lower.includes('notsupportonlocaldisk') ||
      lower.includes('engineversion.notsupport')
    ) {
      return {
        code: 'REDIS_SKU_NOT_AVAILABLE',
        technicalMessage: message.slice(0, 1500),
        providerErrorCode: parsed.providerErrorCode,
        providerRequestId: parsed.providerRequestId,
        httpStatus: parsed.httpStatus,
      };
    }
    return {
      code: 'SPEC_UNAVAILABLE',
      technicalMessage: message.slice(0, 1500),
      providerErrorCode: parsed.providerErrorCode,
      providerRequestId: parsed.providerRequestId,
      httpStatus: parsed.httpStatus,
    };
  }
  // Real transport timeouts only — never classify HTTP 4xx business codes as timeout.
  const isHttpClientError =
    parsed.httpStatus != null && parsed.httpStatus >= 400 && parsed.httpStatus < 500;
  const looksLikeBusinessCode =
    Boolean(parsed.providerErrorCode) &&
    /\.|^(Forbidden|Unauthorized|Invalid)/i.test(parsed.providerErrorCode || '') &&
    !/timeout|econnreset|etimedout/i.test(parsed.providerErrorCode || '');
  if (isHttpClientError && looksLikeBusinessCode) {
    return {
      code: 'PROVIDER_ERROR',
      technicalMessage: message.slice(0, 1500),
      providerErrorCode: parsed.providerErrorCode,
      providerRequestId: parsed.providerRequestId,
      httpStatus: parsed.httpStatus,
    };
  }
  if (
    /^(ConnectTimeout|ReadTimeout|ECONNRESET|ETIMEDOUT)$/i.test(parsed.providerErrorCode || '') ||
    ((lower.includes('connecttimeout') ||
      lower.includes('readtimeout') ||
      lower.includes('etimedout') ||
      lower.includes('econnreset') ||
      lower.includes('socket hang up') ||
      lower.includes('socket reset') ||
      /\btimed out\b/.test(lower) ||
      /\btimeout\b/.test(lower)) &&
      !looksLikeBusinessCode &&
      !isHttpClientError)
  ) {
    return {
      code: 'PROVIDER_TIMEOUT',
      technicalMessage: message.slice(0, 1500),
      providerErrorCode: parsed.providerErrorCode,
      providerRequestId: parsed.providerRequestId,
      httpStatus: parsed.httpStatus,
    };
  }
  if (
    lower.includes('invalidvpc') ||
    lower.includes('invalidvswitch') ||
    lower.includes('securityip') ||
    lower.includes('network config')
  ) {
    return {
      code: 'NETWORK_CONFIG_ERROR',
      technicalMessage: message.slice(0, 1500),
      providerErrorCode: parsed.providerErrorCode,
      providerRequestId: parsed.providerRequestId,
      httpStatus: parsed.httpStatus,
    };
  }
  if (lower.includes('ambiguous') || lower.includes('multiple redis')) {
    return {
      code: 'REDIS_RECONCILE_AMBIGUOUS',
      technicalMessage: message.slice(0, 1500),
      providerErrorCode: parsed.providerErrorCode,
      providerRequestId: parsed.providerRequestId,
      httpStatus: parsed.httpStatus,
    };
  }
  return {
    code: 'PROVIDER_ERROR',
    technicalMessage: message.slice(0, 1500) || 'Provider error',
    providerErrorCode: parsed.providerErrorCode,
    providerRequestId: parsed.providerRequestId,
    httpStatus: parsed.httpStatus,
  };
}

export function sanitizeRedisInstanceName(input: string, fallback = 'launchos-redis'): string {
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  const base = cleaned.length > 0 ? cleaned : fallback;
  const prefixed = base.startsWith('launchos-') ? base : `launchos-${base}`;
  return prefixed.slice(0, 64);
}

/** Aliyun Redis password: 8–32 chars with upper/lower/digit/special. */
export function generateManagedRedisPassword(): string {
  const token = randomBytes(10).toString('base64url');
  return `Lo!${token}A9`.slice(0, 30);
}

export const REDIS_PROVISION_PHASE_LABELS: Record<RedisProvisionPhase, string> = {
  QUEUED: '正在等待 Redis 创建任务开始',
  CREATING_INSTANCE: '正在创建云 Redis',
  WAITING_INSTANCE: '正在等待 Redis 就绪',
  PREPARING_NETWORK: '正在准备网络',
  PREPARING_AUTH: '正在准备访问凭证',
  TESTING_CONNECTION: '正在验证连接',
  BINDING: '正在绑定应用',
  DONE: '完成',
  FAILED: '失败',
};

/** Product copy when DescribePrice succeeds (amounts come from provider, not guessed). */
export function formatRedisPriceHint(input: {
  tradePrice?: string | null;
  hourlyPrice?: string | null;
  currency?: string | null;
  billingCycle?: string | null;
  capacityMb?: number | null;
}): string {
  const amount = input.hourlyPrice || input.tradePrice;
  const currency = input.currency || 'CNY';
  const capacity =
    typeof input.capacityMb === 'number' && input.capacityMb > 0
      ? `${Math.round(input.capacityMb / 1024)} GB`
      : '按所选规格';
  if (!amount) {
    return `${capacity} · 按量付费 · 价格待查询 · 阿里云实际扣费为准`;
  }
  const unit =
    input.billingCycle === 'Hour' || !input.billingCycle
      ? '小时'
      : input.billingCycle === 'Month'
        ? '月'
        : '计费周期';
  return `${capacity} · 按量付费 · 预计：${currency === 'CNY' ? '¥' : currency}${amount} / ${unit}（来自阿里云询价）· 阿里云实际扣费为准`;
}

export const REDIS_BILLING_EXTRA_VALIDATION_NOTICE =
  '阿里云可能对新建按量资源执行额外的账户余额校验。';

/** CreateInstance ClientToken lifecycle failure classification. */
export type RedisCreateFailureKind = 'UNKNOWN_RESULT' | 'TERMINAL_REJECTION';

export type RedisCreateGeneration = {
  generation: number;
  operationId: string;
  attemptCount: number;
  successCount: number;
  terminalErrorCode?: string | null;
  lastRequestId?: string | null;
  createdAt?: string;
  closedAt?: string | null;
};

export function newRedisOperationId(): string {
  return `op_${randomBytes(8).toString('hex')}`;
}

/**
 * UNKNOWN_RESULT: may have created a resource — keep ClientToken, reconcile first.
 * TERMINAL_REJECTION: provider clearly rejected with no instance — may rotate after user retry.
 */
export function classifyRedisCreateFailureKind(input: {
  errorCode?: string | null;
  providerErrorCode?: string | null;
  technicalMessage?: string | null;
  httpStatus?: number | null;
}): RedisCreateFailureKind {
  const text = [
    input.errorCode,
    input.providerErrorCode,
    input.technicalMessage,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const http = input.httpStatus;
  const providerCode = (input.providerErrorCode || '').trim();

  // HTTP 4xx + explicit provider business code → always terminal (never timeout).
  if (
    http != null &&
    http >= 400 &&
    http < 500 &&
    providerCode &&
    !/timeout|econnreset|etimedout|socket/i.test(providerCode)
  ) {
    return 'TERMINAL_REJECTION';
  }

  if (
    /connecttimeout|readtimeout|etimedout|econnreset|socket hang up|socket reset|network timeout|timed out|response lost|socket closed|provider_timeout/.test(
      text,
    ) ||
    input.errorCode === 'PROVIDER_TIMEOUT' ||
    /^(ConnectTimeout|ReadTimeout|ECONNRESET|ETIMEDOUT)$/i.test(providerCode)
  ) {
    // If message also has a dotted business code and no real transport token, prefer terminal.
    if (
      /\b(pay|order|forbidden|invalid|engineversion)\.[a-z0-9_.]+/i.test(text) &&
      !/connecttimeout|readtimeout|etimedout|econnreset|socket hang up/i.test(text) &&
      input.errorCode !== 'PROVIDER_TIMEOUT'
    ) {
      return 'TERMINAL_REJECTION';
    }
    return 'UNKNOWN_RESULT';
  }

  if (
    /pay\.insufficient_balance|insufficient_balance|notenoughbalance|invalidaccountstatus\.notenoughbalance|forbidden\.ram|engineversion\.notsupport|invalidparameter|invalid\.|quotaexceed|quota\.|order\.|spec_unavailable|redis_sku_not_available|permission_denied|quota_exceeded|soldout|billing_not_enough|billing_insufficient/.test(
      text,
    ) ||
    input.errorCode === 'REDIS_BILLING_INSUFFICIENT_BALANCE' ||
    input.errorCode === 'REDIS_BILLING_ACCOUNT_INVALID' ||
    input.errorCode === 'REDIS_BILLING_UNSETTLED_BILL' ||
    input.errorCode === 'REDIS_BILLING_ORDER_FAILED' ||
    input.errorCode === 'PERMISSION_DENIED' ||
    input.errorCode === 'QUOTA_EXCEEDED' ||
    input.errorCode === 'BILLING_NOT_ENOUGH_BALANCE' ||
    input.errorCode === 'BILLING_INSUFFICIENT' ||
    input.errorCode === 'REDIS_SKU_NOT_AVAILABLE' ||
    input.errorCode === 'SPEC_UNAVAILABLE' ||
    input.errorCode === 'REGION_UNAVAILABLE'
  ) {
    return 'TERMINAL_REJECTION';
  }

  // Explicit provider business codes (Pascal/UPPER with dots) without timeout → terminal.
  if (
    providerCode &&
    /^[A-Z][A-Za-z0-9_.]+$/.test(providerCode) &&
    providerCode.includes('.') &&
    !/timeout/i.test(providerCode)
  ) {
    return 'TERMINAL_REJECTION';
  }

  return 'UNKNOWN_RESULT';
}

export function shouldRotateRedisCreateClientToken(input: {
  providerResourceId?: string | null;
  createInstanceCompleted?: boolean;
  reconcileMatchCount: number;
  failureKind: RedisCreateFailureKind | null;
  userRequestedRetry: boolean;
}): { rotate: boolean; reason: string } {
  if (input.providerResourceId?.trim() || input.createInstanceCompleted) {
    return { rotate: false, reason: 'providerResourceId_or_create_completed' };
  }
  if (input.reconcileMatchCount === 1) {
    return { rotate: false, reason: 'reconcile_claim' };
  }
  if (input.reconcileMatchCount > 1) {
    return { rotate: false, reason: 'reconcile_ambiguous' };
  }
  if (!input.userRequestedRetry) {
    return { rotate: false, reason: 'not_user_retry' };
  }
  if (input.failureKind === 'UNKNOWN_RESULT' || input.failureKind === null) {
    return { rotate: false, reason: 'unknown_or_missing_failure_kind' };
  }
  if (input.failureKind === 'TERMINAL_REJECTION' && input.reconcileMatchCount === 0) {
    return { rotate: true, reason: 'terminal_rejection_reconcile_zero' };
  }
  return { rotate: false, reason: 'default_keep' };
}

export function peekCurrentRedisCreateGeneration(
  generations?: RedisCreateGeneration[] | null,
): RedisCreateGeneration | null {
  if (!Array.isArray(generations) || generations.length === 0) return null;
  return generations[generations.length - 1] || null;
}

export function bumpRedisCreateGenerationCounters(
  generations: RedisCreateGeneration[] | null | undefined,
  patch: { attemptDelta?: number; successDelta?: number },
): RedisCreateGeneration[] {
  const gens = Array.isArray(generations) ? generations.map((g) => ({ ...g })) : [];
  if (gens.length === 0) return gens;
  const last = gens[gens.length - 1]!;
  gens[gens.length - 1] = {
    ...last,
    attemptCount: Number(last.attemptCount || 0) + Number(patch.attemptDelta || 0),
    successCount: Number(last.successCount || 0) + Number(patch.successDelta || 0),
  };
  return gens;
}

/** Close current generation (if any) and append a new open generation with a fresh operationId. */
export function advanceRedisCreateGeneration(input: {
  generations?: RedisCreateGeneration[] | null;
  currentOperationId?: string | null;
  /** Attempts attributed to the generation being closed. */
  closedAttemptCount?: number;
  closedSuccessCount?: number;
  /** Fallback totals when seeding first-generation audit from legacy metadata. */
  totalAttemptCount?: number;
  totalSuccessCount?: number;
  terminalErrorCode?: string | null;
  lastRequestId?: string | null;
  now?: string;
}): {
  createGeneration: number;
  operationId: string;
  createGenerations: RedisCreateGeneration[];
  previousOperationId: string | null;
} {
  const now = input.now || new Date().toISOString();
  const prev = Array.isArray(input.generations)
    ? input.generations.map((g) => ({ ...g }))
    : [];
  const previousOperationId =
    prev.length > 0
      ? prev[prev.length - 1]!.operationId
      : input.currentOperationId?.trim() || null;

  if (prev.length === 0 && previousOperationId) {
    prev.push({
      generation: 1,
      operationId: previousOperationId,
      attemptCount: Number(
        input.closedAttemptCount ?? input.totalAttemptCount ?? 0,
      ),
      successCount: Number(
        input.closedSuccessCount ?? input.totalSuccessCount ?? 0,
      ),
      terminalErrorCode: input.terminalErrorCode || null,
      lastRequestId: input.lastRequestId || null,
      createdAt: undefined,
      closedAt: now,
    });
  } else if (prev.length > 0) {
    const last = prev[prev.length - 1]!;
    prev[prev.length - 1] = {
      ...last,
      attemptCount: Number(
        input.closedAttemptCount ?? last.attemptCount ?? 0,
      ),
      successCount: Number(
        input.closedSuccessCount ?? last.successCount ?? 0,
      ),
      terminalErrorCode: input.terminalErrorCode || last.terminalErrorCode || null,
      lastRequestId: input.lastRequestId || last.lastRequestId || null,
      closedAt: now,
    };
  }

  const nextGeneration = (prev[prev.length - 1]?.generation || 0) + 1;
  const operationId = newRedisOperationId();
  prev.push({
    generation: nextGeneration,
    operationId,
    attemptCount: 0,
    successCount: 0,
    createdAt: now,
    closedAt: null,
  });

  return {
    createGeneration: nextGeneration,
    operationId,
    createGenerations: prev,
    previousOperationId,
  };
}

export const REDIS_PROVISION_PRODUCT_STEPS: Array<{
  key: string;
  label: string;
  phases: RedisProvisionPhase[];
}> = [
  { key: 'create', label: '创建 Redis', phases: ['QUEUED', 'CREATING_INSTANCE', 'WAITING_INSTANCE'] },
  { key: 'network', label: '准备网络', phases: ['PREPARING_NETWORK'] },
  { key: 'auth', label: '准备访问凭证', phases: ['PREPARING_AUTH'] },
  { key: 'test', label: '测试连接', phases: ['TESTING_CONNECTION'] },
  { key: 'bind', label: '绑定应用', phases: ['BINDING', 'DONE'] },
];

export const REDIS_PROVISION_QUEUE_STALL_USER_MESSAGE =
  'Redis 创建服务暂时不可用，任务将在服务恢复后继续。';
