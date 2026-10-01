/**
 * Step 26.2 — Aliyun ECS managed server provisioning domain helpers.
 * ClientToken lifecycle mirrors Redis (UNKNOWN keep / TERMINAL may rotate).
 */
import { randomBytes } from 'node:crypto';
import {
  advanceRedisCreateGeneration,
  bumpRedisCreateGenerationCounters,
  classifyRedisCreateFailureKind,
  newRedisOperationId,
  peekCurrentRedisCreateGeneration,
  shouldRotateRedisCreateClientToken,
  type RedisCreateFailureKind,
  type RedisCreateGeneration,
} from './redis-provision.js';

export type ServerProvisionPhase =
  | 'QUEUED'
  | 'RECONCILING'
  | 'PREPARING_NETWORK'
  | 'PREPARING_SECURITY_GROUP'
  | 'CREATING_INSTANCE'
  | 'WAITING_INSTANCE'
  | 'ALLOCATING_PUBLIC_IP'
  | 'VERIFYING_INSTANCE'
  | 'BINDING'
  | 'DONE'
  | 'FAILED';

export type ServerProvisionProfile = 'DEV' | 'STANDARD' | 'PRODUCTION';

export type ServerCreateFailureKind = RedisCreateFailureKind;
export type ServerCreateGeneration = RedisCreateGeneration;

export type ResolvedServerPlan = {
  profile: ServerProvisionProfile;
  regionId: string;
  zoneId: string | null;
  instanceType: string;
  cpu: number;
  memoryGb: number;
  systemDiskGb: number;
  systemDiskCategory: string;
  imageId: string;
  imageName?: string | null;
  vpcId: string | null;
  vSwitchId: string | null;
  securityGroupId: string | null;
  publicIpRequired: true;
  chargeType: 'PostPaid';
  priceEstimate: {
    currency: string | null;
    originalPrice: string | null;
    tradePrice: string | null;
    hourlyPrice: string | null;
    monthlyEquivalent: string | null;
    priceUnit: string;
    providerRequestId?: string | null;
    checkedAt: string;
  } | null;
  selectionReason: string;
  availabilityFingerprint?: string | null;
};

export type RunInstancesRequestPreview = {
  regionId: string;
  zoneId: string | null;
  instanceType: string;
  imageId: string;
  systemDisk: { category: string; size: number };
  internetChargeType: string;
  internetMaxBandwidthOut: number;
  vpcId: string | null;
  vSwitchId: string | null;
  securityGroupId: string | null;
  chargeType: 'PostPaid';
  instanceName: string;
  hostName: string | null;
  loginMode: 'PASSWORD' | 'KEY_PAIR';
  keyPairName: string | null;
  clientToken: string;
  tags: Array<{ key: string; value: string }>;
};

export const SERVER_PROVISION_PHASE_LABELS: Record<ServerProvisionPhase, string> = {
  QUEUED: '排队中',
  RECONCILING: '核对已有资源',
  PREPARING_NETWORK: '准备网络',
  PREPARING_SECURITY_GROUP: '准备安全配置',
  CREATING_INSTANCE: '创建服务器',
  WAITING_INSTANCE: '等待服务器启动',
  ALLOCATING_PUBLIC_IP: '分配公网地址',
  VERIFYING_INSTANCE: '验证服务器',
  BINDING: '绑定应用',
  DONE: '完成',
  FAILED: '失败',
};

/** Product steps shown to normal users (collapsed). */
export const SERVER_PROVISION_PRODUCT_STEPS: Array<{
  phase: ServerProvisionPhase;
  label: string;
}> = [
  { phase: 'PREPARING_NETWORK', label: '准备网络' },
  { phase: 'PREPARING_SECURITY_GROUP', label: '准备安全配置' },
  { phase: 'CREATING_INSTANCE', label: '创建服务器' },
  { phase: 'WAITING_INSTANCE', label: '等待服务器启动' },
  { phase: 'BINDING', label: '绑定应用' },
];

export const SERVER_PROVISION_QUEUE_STALL_USER_MESSAGE =
  '服务器创建任务排队过久，请确认后台 worker 正在运行后继续。';

/** Public ingress only. Container/app ports stay on loopback behind the gateway. */
export const ECS_PUBLIC_INGRESS_PORTS = [22, 80, 443] as const;

/** Must never appear on the public security group. */
export const ECS_DENIED_PUBLIC_PORT_RANGES = ['3000', '3001', '39000-39999'] as const;

/**
 * Step 26.2 v1 login. Key pair lifecycle is not wired yet; password is generated
 * at create time with crypto.randomBytes and stored only as AES-256-GCM ciphertext.
 */
export const ECS_LOGIN_MODE_V1 = 'PASSWORD' as const;

export type CloudEcsErrorCode =
  | 'PERMISSION_DENIED'
  | 'PRICE_PERMISSION_DENIED'
  | 'QUOTA_EXCEEDED'
  | 'SOLD_OUT'
  | 'ZONE_CAPACITY'
  | 'BILLING_INSUFFICIENT'
  | 'BILLING_NOT_ENOUGH_BALANCE'
  | 'RECONCILE_AMBIGUOUS'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_ERROR'
  | 'IMAGE_UNAVAILABLE'
  | 'NETWORK_CONFIG_ERROR'
  | 'PUBLIC_IP_MISSING'
  | 'REQUEST_INVALID'
  | 'UNKNOWN';

const ECS_USER_MESSAGES: Record<CloudEcsErrorCode, string> = {
  PERMISSION_DENIED: '当前阿里云账号缺少云服务器相关权限。',
  PRICE_PERMISSION_DENIED: 'ECS 询价权限未就绪，无法进入购买确认。',
  QUOTA_EXCEEDED: '当前阿里云账号云服务器配额不足。',
  SOLD_OUT: '当前规格在该可用区暂时售罄，请重新规划后再确认。',
  ZONE_CAPACITY: '当前可用区资源不足，请重新选择可用区或规格。',
  BILLING_INSUFFICIENT: '阿里云账户可用余额不足，请充值或补足余额后再重试创建服务器。',
  BILLING_NOT_ENOUGH_BALANCE:
    '阿里云账户可用余额不足，请充值或补足余额后再重试创建服务器。',
  RECONCILE_AMBIGUOUS: '检测到多台同名云服务器，已停止自动创建，请人工确认。',
  PROVIDER_TIMEOUT: '连接阿里云 ECS 服务超时，请稍后继续（不会盲目重复创建）。',
  PROVIDER_ERROR: '云服务器创建失败。',
  IMAGE_UNAVAILABLE: '所选系统镜像当前不可用。',
  NETWORK_CONFIG_ERROR: '服务器网络配置失败。',
  PUBLIC_IP_MISSING: '服务器已创建但尚未获得公网地址。',
  REQUEST_INVALID: '云服务器请求参数不完整，请检查后继续。',
  UNKNOWN: '服务器创建失败。',
};

export function cloudEcsErrorUserMessage(
  code: CloudEcsErrorCode,
  failedOperation?: string | null,
  missingParameterName?: string | null,
): string {
  const op = String(failedOperation || '').trim();
  const missing = String(missingParameterName || '').trim();
  if (/AuthorizeSecurityGroup/i.test(op) && /RegionId/i.test(missing)) {
    return 'LaunchOS 准备安全配置时缺少地域参数，已修复后请继续。';
  }
  if (code === 'REQUEST_INVALID' && missing) {
    return `云服务器请求缺少必要参数（${missing}），请检查后继续。`;
  }
  if (/AuthorizeSecurityGroup/i.test(op) && code === 'REQUEST_INVALID') {
    return 'LaunchOS 暂时无法配置服务器安全规则，请检查安全组参数。';
  }
  if (code === 'PERMISSION_DENIED' || code === 'PRICE_PERMISSION_DENIED') {
    if (/CreateSecurityGroup/i.test(op)) {
      return 'LaunchOS 暂时无法准备服务器安全配置，请补充阿里云安全组创建权限（ecs:CreateSecurityGroup）。';
    }
    if (/AuthorizeSecurityGroup/i.test(op)) {
      return 'LaunchOS 暂时无法配置服务器安全规则，请补充阿里云安全组授权权限（ecs:AuthorizeSecurityGroup）。';
    }
    if (/DescribeSecurityGroups/i.test(op)) {
      return 'LaunchOS 暂时无法读取安全组，请补充阿里云安全组查询权限（ecs:DescribeSecurityGroups）。';
    }
    if (/DescribeImages/i.test(op)) {
      return 'LaunchOS 暂时无法读取云服务器镜像，请补充阿里云 ECS 镜像读取权限。';
    }
    if (/RunInstances/i.test(op)) {
      return 'LaunchOS 暂时无法创建云服务器，请补充阿里云 ECS 创建权限（ecs:RunInstances）。';
    }
    if (/DescribeVpcs|CreateVpc/i.test(op)) {
      return 'LaunchOS 暂时无法准备网络（VPC），请补充阿里云 VPC 权限。';
    }
    if (/DescribeVSwitches|CreateVSwitch/i.test(op)) {
      return 'LaunchOS 暂时无法准备交换机，请补充阿里云 VSwitch 权限。';
    }
    if (/AllocatePublicIpAddress/i.test(op)) {
      return 'LaunchOS 暂时无法分配公网地址，请补充 ecs:AllocatePublicIpAddress 权限。';
    }
    if (/DescribePrice/i.test(op) || code === 'PRICE_PERMISSION_DENIED') {
      return ECS_USER_MESSAGES.PRICE_PERMISSION_DENIED;
    }
  }
  return ECS_USER_MESSAGES[code] ?? ECS_USER_MESSAGES.UNKNOWN;
}

/** Infer OpenAPI operation from last persisted phase when the throw site did not tag it. */
export function inferEcsFailedOperationFromPhase(
  phase: string | null | undefined,
): string | null {
  switch (String(phase || '').toUpperCase()) {
    case 'RECONCILING':
      return 'DescribeInstances';
    case 'PREPARING_NETWORK':
      return 'DescribeVpcs/DescribeVSwitches';
    case 'PREPARING_SECURITY_GROUP':
      return 'AuthorizeSecurityGroup';
    case 'CREATING_INSTANCE':
      return 'RunInstances';
    case 'ALLOCATING_PUBLIC_IP':
      return 'AllocatePublicIpAddress';
    case 'WAITING_INSTANCE':
    case 'VERIFYING_INSTANCE':
      return 'DescribeInstances';
    default:
      return null;
  }
}

export function classifyCloudEcsError(error: unknown): CloudEcsErrorCode {
  const text = String(
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error && 'message' in error
        ? (error as { message?: string }).message
        : error,
  ).toLowerCase();
  const code =
    typeof error === 'object' && error && 'code' in error
      ? String((error as { code?: unknown }).code || '').toLowerCase()
      : '';
  const combined = `${code} ${text}`;
  if (/forbidden\.ram|notauthorized|no permission|无权/.test(combined)) {
    return 'PERMISSION_DENIED';
  }
  if (/missingparameter|missing parameter|mandatory.*not supplied|run_instances_request_invalid/.test(combined)) {
    return 'REQUEST_INVALID';
  }
  if (/describeprice|price.*permission|询价/.test(combined) && /forbidden|denied/.test(combined)) {
    return 'PRICE_PERMISSION_DENIED';
  }
  // InvalidAccountStatus.NotEnoughBalance / PAY.INSUFFICIENT_BALANCE
  if (
    /invalidaccountstatus\.notenoughbalance|notenoughbalance|not_enough_balance|pay\.insufficient|insufficient_balance|余额不足/.test(
      combined,
    )
  ) {
    return 'BILLING_NOT_ENOUGH_BALANCE';
  }
  if (/quotaexceed|quota\./.test(combined)) return 'QUOTA_EXCEEDED';
  if (/soldout|operationdenied\.nosrock|no stock|operationdenied\.nostock/.test(combined)) {
    return 'SOLD_OUT';
  }
  if (/zone\.notenough|notenoughresource|resource.*not.*enough/.test(combined)) {
    return 'ZONE_CAPACITY';
  }
  if (/connecttimeout|readtimeout|etimedout|econnreset|timed out/.test(combined)) {
    return 'PROVIDER_TIMEOUT';
  }
  if (/image|invalidimage/.test(combined)) return 'IMAGE_UNAVAILABLE';
  if (/reconcile.*ambiguous|多台同名/.test(combined)) return 'RECONCILE_AMBIGUOUS';
  return 'UNKNOWN';
}

/**
 * Terminal provider rejections must never auto-retry RunInstances (BullMQ / executor).
 * Forbidden.RAM / NotEnoughBalance / Quota* / InvalidParameter* / SoldOut*
 */
export function isServerProvisionTerminalNoAutoRetry(input: {
  errorCode?: string | null;
  providerErrorCode?: string | null;
  technicalMessage?: string | null;
  failureKind?: ServerCreateFailureKind | null;
  httpStatus?: number | null;
}): boolean {
  if (input.failureKind === 'TERMINAL_REJECTION') return true;
  const kind = classifyServerCreateFailureKind({
    errorCode: input.errorCode,
    providerErrorCode: input.providerErrorCode,
    technicalMessage: input.technicalMessage,
    httpStatus: input.httpStatus,
  });
  if (kind === 'TERMINAL_REJECTION') return true;
  const text = [input.errorCode, input.providerErrorCode, input.technicalMessage]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return /forbidden\.ram|notenoughbalance|insufficient_balance|quotaexceed|quota\.|soldout|invalidparameter|invalid\.|billing_not_enough|billing_insufficient|permission_denied/.test(
    text,
  );
}

export function newServerOperationId(): string {
  return newRedisOperationId();
}

export function classifyServerCreateFailureKind(input: {
  errorCode?: string | null;
  providerErrorCode?: string | null;
  technicalMessage?: string | null;
  httpStatus?: number | null;
}): ServerCreateFailureKind {
  return classifyRedisCreateFailureKind(input);
}

export function shouldRotateServerCreateClientToken(input: {
  providerResourceId?: string | null;
  createInstanceCompleted?: boolean;
  reconcileMatchCount: number;
  failureKind: ServerCreateFailureKind | null;
  userRequestedRetry: boolean;
  /** RunInstances attempt count — pre-create failures must not rotate generation. */
  runInstancesAttemptCount?: number;
}): { rotate: boolean; reason: string } {
  if (
    Number(input.runInstancesAttemptCount || 0) <= 0 &&
    !input.createInstanceCompleted &&
    !input.providerResourceId?.trim()
  ) {
    return { rotate: false, reason: 'pre_create_keep_generation' };
  }
  return shouldRotateRedisCreateClientToken(input);
}

const CURRENT_ERROR_KEYS = [
  'lastErrorCode',
  'lastErrorUserMessage',
  'lastErrorMessage',
  'providerErrorCode',
  'lastRequestId',
  'httpStatus',
  'failedAt',
  'failedPhase',
  'failedOperation',
  'createFailureKind',
  'missingRamActions',
  'missingParameterName',
] as const;

/**
 * Move current failure fields into errorHistory and clear them for a fresh attempt.
 * Does not touch createGeneration / operationId / counters.
 */
export function archiveServerProvisionCurrentFailure(
  meta: Record<string, unknown>,
): Record<string, unknown> {
  const hasCurrent =
    meta.lastErrorCode != null ||
    meta.failedOperation != null ||
    meta.providerErrorCode != null ||
    meta.failedAt != null;
  const history = Array.isArray(meta.errorHistory)
    ? [...(meta.errorHistory as unknown[])]
    : [];
  if (hasCurrent) {
    const entry: Record<string, unknown> = {
      archivedAt: new Date().toISOString(),
      superseded: true,
    };
    for (const key of CURRENT_ERROR_KEYS) {
      if (meta[key] !== undefined) entry[key] = meta[key];
    }
    history.push(entry);
  }
  const next: Record<string, unknown> = {
    ...meta,
    errorHistory: history.slice(-20),
    currentErrorCleared: true,
    lastFailure: hasCurrent
      ? {
          failedOperation: meta.failedOperation ?? null,
          providerErrorCode: meta.providerErrorCode ?? null,
          providerRequestId: meta.lastRequestId ?? null,
          failedAt: meta.failedAt ?? null,
        }
      : meta.lastFailure ?? null,
  };
  for (const key of CURRENT_ERROR_KEYS) {
    next[key] = null;
  }
  return next;
}

export function peekCurrentServerCreateGeneration(
  generations?: ServerCreateGeneration[] | null,
): ServerCreateGeneration | null {
  return peekCurrentRedisCreateGeneration(generations);
}

export function bumpServerCreateGenerationCounters(
  generations: ServerCreateGeneration[] | null | undefined,
  patch: { attemptDelta?: number; successDelta?: number },
): ServerCreateGeneration[] {
  return bumpRedisCreateGenerationCounters(generations, patch);
}

export function advanceServerCreateGeneration(
  input: Parameters<typeof advanceRedisCreateGeneration>[0],
): ReturnType<typeof advanceRedisCreateGeneration> {
  return advanceRedisCreateGeneration(input);
}

export function sanitizeEcsInstanceName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return cleaned.startsWith('launchos-') ? cleaned : `launchos-${cleaned || 'server'}`;
}

export function generateManagedEcsPassword(): string {
  // Aliyun ECS: 8–30 chars, at least 3 of upper/lower/digit/special. Never a fixed secret.
  const token = randomBytes(12).toString('base64url').replace(/[-_]/g, 'x');
  return `Launchos!${token}A9`.slice(0, 30);
}

export function managedEcsPasswordMeetsPolicy(password: string): boolean {
  if (password.length < 8 || password.length > 30) return false;
  const classes = [
    /[A-Z]/.test(password),
    /[a-z]/.test(password),
    /[0-9]/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ].filter(Boolean).length;
  return classes >= 3;
}

export function normalizeLaunchosTagValue(value: string): string {
  return value.replace(/[^\w.:/=+\-@]/g, '-').slice(0, 128);
}

export function buildLaunchosEcsTags(input: {
  cloudResourceId: string;
  projectId: string;
  workspaceId: string;
}): Array<{ key: string; value: string }> {
  return [
    { key: 'launchos:managed', value: 'true' },
    {
      key: 'launchos:cloudResourceId',
      value: normalizeLaunchosTagValue(input.cloudResourceId),
    },
    { key: 'launchos:projectId', value: normalizeLaunchosTagValue(input.projectId) },
    {
      key: 'launchos:workspaceId',
      value: normalizeLaunchosTagValue(input.workspaceId),
    },
  ];
}

export function buildRunInstancesRequestPreview(input: {
  plan: ResolvedServerPlan;
  instanceName: string;
  clientToken: string;
  securityGroupId: string | null;
  loginMode?: 'PASSWORD' | 'KEY_PAIR';
  keyPairName?: string | null;
  tags: Array<{ key: string; value: string }>;
}): RunInstancesRequestPreview {
  return {
    regionId: input.plan.regionId,
    zoneId: input.plan.zoneId,
    instanceType: input.plan.instanceType,
    imageId: input.plan.imageId,
    systemDisk: {
      category: input.plan.systemDiskCategory,
      size: input.plan.systemDiskGb,
    },
    internetChargeType: 'PayByTraffic',
    internetMaxBandwidthOut: 5,
    vpcId: input.plan.vpcId,
    vSwitchId: input.plan.vSwitchId,
    securityGroupId: input.securityGroupId || input.plan.securityGroupId,
    chargeType: 'PostPaid',
    instanceName: input.instanceName,
    hostName: null,
    loginMode: input.loginMode || 'PASSWORD',
    keyPairName: input.keyPairName || null,
    clientToken: input.clientToken.slice(0, 64),
    tags: input.tags,
  };
}

/** Extract Aliyun MissingParameter name from message, e.g. RegionId. */
export function parseMissingParameterName(
  message: string | null | undefined,
): string | null {
  const text = String(message || '');
  const quoted =
    text.match(/parameter\s+"([A-Za-z0-9_.]+)"/i) ||
    text.match(/parameter\s+'([A-Za-z0-9_.]+)'/i) ||
    text.match(/缺少.*?参数[「"']?([A-Za-z0-9_.]+)[」"']?/i);
  return quoted?.[1] || null;
}

export type RunInstancesPreflightInput = {
  regionId?: string | null;
  zoneId?: string | null;
  instanceType?: string | null;
  imageId?: string | null;
  systemDiskCategory?: string | null;
  systemDiskSize?: number | null;
  vSwitchId?: string | null;
  securityGroupId?: string | null;
  instanceName?: string | null;
  chargeType?: string | null;
  internetChargeType?: string | null;
  internetMaxBandwidthOut?: number | null;
  clientToken?: string | null;
  loginMode?: 'PASSWORD' | 'KEY_PAIR';
  /** Presence only — never log the value. */
  passwordPresent?: boolean;
  passwordLength?: number;
  tags?: Array<{ key: string; value: string }>;
};

export type RunInstancesPreflightResult = {
  valid: boolean;
  code: 'OK' | 'RUN_INSTANCES_REQUEST_INVALID';
  missingFields: string[];
  passwordPresent: boolean;
  passwordLength: number;
  resolvedRunInstancesRequest: Record<string, unknown>;
};

/**
 * Local validator before any RunInstances SDK call.
 * On failure: do not call SDK; keep runInstancesAttemptCount unchanged.
 */
export function validateRunInstancesRequestPreflight(
  input: RunInstancesPreflightInput,
): RunInstancesPreflightResult {
  const missingFields: string[] = [];
  const require = (key: string, value: unknown) => {
    if (value == null || (typeof value === 'string' && !value.trim())) {
      missingFields.push(key);
    }
  };
  require('RegionId', input.regionId);
  require('InstanceType', input.instanceType);
  require('ImageId', input.imageId);
  require('SystemDisk.Category', input.systemDiskCategory);
  if (input.systemDiskSize == null || Number(input.systemDiskSize) < 40) {
    missingFields.push('SystemDisk.Size');
  }
  require('VSwitchId', input.vSwitchId);
  require('SecurityGroupId', input.securityGroupId);
  require('InstanceName', input.instanceName);
  require('InstanceChargeType', input.chargeType || 'PostPaid');
  require('InternetChargeType', input.internetChargeType || 'PayByTraffic');
  const internetMaxBandwidthOut =
    input.internetMaxBandwidthOut == null ? 5 : Number(input.internetMaxBandwidthOut);
  if (!Number.isFinite(internetMaxBandwidthOut) || internetMaxBandwidthOut < 0) {
    missingFields.push('InternetMaxBandwidthOut');
  }
  require('ClientToken', input.clientToken);
  const loginMode = input.loginMode || 'PASSWORD';
  const passwordPresent = Boolean(input.passwordPresent);
  const passwordLength = Number(input.passwordLength || 0);
  if (loginMode === 'PASSWORD') {
    if (!passwordPresent || passwordLength < 8) {
      missingFields.push('Password');
    }
  }

  const resolvedRunInstancesRequest = {
    RegionId: input.regionId || null,
    ZoneId: input.zoneId || null,
    InstanceType: input.instanceType || null,
    ImageId: input.imageId || null,
    InstanceChargeType: input.chargeType || 'PostPaid',
    InternetChargeType: input.internetChargeType || 'PayByTraffic',
    InternetMaxBandwidthOut: internetMaxBandwidthOut,
    SystemDisk: {
      Category: input.systemDiskCategory || null,
      Size: input.systemDiskSize ?? null,
    },
    VSwitchId: input.vSwitchId || null,
    SecurityGroupId: input.securityGroupId || null,
    InstanceName: input.instanceName || null,
    HostName: null,
    Amount: 1,
    ClientToken: input.clientToken ? String(input.clientToken).slice(0, 64) : null,
    PasswordPresent: passwordPresent,
    PasswordLength: passwordLength,
    // never include Password plaintext
    Tag: (input.tags || []).map((t) => ({ Key: t.key, Value: t.value })),
  };

  return {
    valid: missingFields.length === 0,
    code: missingFields.length === 0 ? 'OK' : 'RUN_INSTANCES_REQUEST_INVALID',
    missingFields,
    passwordPresent,
    passwordLength,
    resolvedRunInstancesRequest,
  };
}

/** Intermediate phases that must not remain after a successfully completed queue job. */
export const SERVER_PROVISION_IN_FLIGHT_PHASES = [
  'QUEUED',
  'RECONCILING',
  'PREPARING_NETWORK',
  'PREPARING_SECURITY_GROUP',
  'CREATING_INSTANCE',
  'WAITING_INSTANCE',
  'ALLOCATING_PUBLIC_IP',
  'VERIFYING_INSTANCE',
  'BINDING',
] as const;

/**
 * True when a Worker is about to return "success" but the CloudResource is still
 * stuck mid-provision without an instance id — BullMQ must not mark completed.
 */
export function isServerProvisionSilentlyIncomplete(input: {
  status?: string | null;
  phase?: string | null;
  providerResourceId?: string | null;
}): boolean {
  const status = String(input.status || '').toUpperCase();
  const phase = String(input.phase || '').toUpperCase();
  if (status !== 'CREATING') return false;
  if (input.providerResourceId?.trim()) return false;
  return (SERVER_PROVISION_IN_FLIGHT_PHASES as readonly string[]).includes(phase);
}

export type ServerProvisionStaleRecovery = {
  safeResume: boolean;
  action: 'enqueue_same_generation' | 'reconcile_first' | 'none';
  reason: string;
  createGeneration: number;
  /** Prefer remove completed/failed job then add same g{N} jobId. */
  recoveryJobStrategy: 'remove_completed_then_add_same_id' | 'retry_failed' | 'none';
};

/**
 * Assess how to resume a CREATING CloudResource whose BullMQ job already finished.
 * Does not enqueue — caller decides.
 */
export function assessServerProvisionStaleRecovery(input: {
  status?: string | null;
  phase?: string | null;
  providerResourceId?: string | null;
  runInstancesAttemptCount?: number;
  queueJobState?: string | null;
  createGeneration?: number;
}): ServerProvisionStaleRecovery {
  const gen = Math.max(1, Number(input.createGeneration || 1));
  const attempts = Number(input.runInstancesAttemptCount || 0);
  const jobState = input.queueJobState == null ? null : String(input.queueJobState);
  const jobTerminal =
    jobState === 'completed' || jobState === 'failed' || jobState === null;
  const stuckCreating =
    String(input.status || '').toUpperCase() === 'CREATING' &&
    !input.providerResourceId?.trim();

  if (!stuckCreating || !jobTerminal) {
    return {
      safeResume: false,
      action: 'none',
      reason: 'not_stale_or_job_inflight',
      createGeneration: gen,
      recoveryJobStrategy: 'none',
    };
  }

  if (attempts <= 0) {
    return {
      safeResume: true,
      action: 'enqueue_same_generation',
      reason:
        'no_runinstances_attempt_no_provider_id_job_terminal_safe_reenqueue_same_generation',
      createGeneration: gen,
      recoveryJobStrategy:
        jobState === 'failed' ? 'retry_failed' : 'remove_completed_then_add_same_id',
    };
  }

  return {
    safeResume: true,
    action: 'reconcile_first',
    reason: 'runinstances_attempted_must_reconcile_before_reenqueue',
    createGeneration: gen,
    recoveryJobStrategy:
      jobState === 'failed' ? 'retry_failed' : 'remove_completed_then_add_same_id',
  };
}

export type ServerProvisionCreatingDecision =
  | {
      kind: 'already_in_progress';
      safeResume: false;
      queueJobState: string;
    }
  | {
      kind: 'stale_reenqueue';
      safeResume: true;
      recovery: ServerProvisionStaleRecovery;
      queueJobState: string | null;
    }
  | {
      kind: 'reconcile_first';
      safeResume: true;
      recovery: ServerProvisionStaleRecovery;
      queueJobState: string | null;
    }
  | {
      kind: 'block_as_in_progress';
      safeResume: false;
      queueJobState: string | null;
      reason: string;
    };

/**
 * Decide what POST provision should do when CloudResource.status === CREATING.
 * Never treat CREATING alone as "in progress" without queue state.
 */
export function decideServerProvisionCreatingAction(input: {
  status?: string | null;
  phase?: string | null;
  providerResourceId?: string | null;
  runInstancesAttemptCount?: number;
  queueJobState?: string | null;
  createGeneration?: number;
}): ServerProvisionCreatingDecision {
  const jobState = input.queueJobState == null ? null : String(input.queueJobState);
  if (jobState === 'waiting' || jobState === 'active' || jobState === 'delayed') {
    return {
      kind: 'already_in_progress',
      safeResume: false,
      queueJobState: jobState,
    };
  }

  const recovery = assessServerProvisionStaleRecovery(input);
  if (recovery.action === 'enqueue_same_generation' && recovery.safeResume) {
    return {
      kind: 'stale_reenqueue',
      safeResume: true,
      recovery,
      queueJobState: jobState,
    };
  }
  if (recovery.action === 'reconcile_first' && recovery.safeResume) {
    return {
      kind: 'reconcile_first',
      safeResume: true,
      recovery,
      queueJobState: jobState,
    };
  }

  return {
    kind: 'block_as_in_progress',
    safeResume: false,
    queueJobState: jobState,
    reason: recovery.reason || 'creating_without_clear_stale_signal',
  };
}

export function mapServerPhaseToProductLabel(phase: string | null | undefined): string {
  const p = (phase || '').toUpperCase() as ServerProvisionPhase;
  if (p in SERVER_PROVISION_PHASE_LABELS) {
    return SERVER_PROVISION_PHASE_LABELS[p as ServerProvisionPhase];
  }
  return phase || '处理中';
}

/** Stable fingerprint for billing re-confirmation when trade/hourly price changes. */
export function serverPriceFingerprint(
  price: {
    currency?: string | null;
    tradePrice?: string | null;
    hourlyPrice?: string | null;
    instanceType?: string | null;
  } | null | undefined,
): string | null {
  if (!price) return null;
  const amount = price.tradePrice || price.hourlyPrice;
  if (!amount) return null;
  return `${price.currency || 'CNY'}|${amount}|${price.instanceType || ''}`;
}

export function pricesRequireReconfirmation(
  confirmedFingerprint: string | null | undefined,
  nextPrice: {
    currency?: string | null;
    tradePrice?: string | null;
    hourlyPrice?: string | null;
    instanceType?: string | null;
  } | null | undefined,
): boolean {
  const next = serverPriceFingerprint(nextPrice);
  if (!confirmedFingerprint || !next) return false;
  return confirmedFingerprint !== next;
}
