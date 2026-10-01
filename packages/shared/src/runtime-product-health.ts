/**
 * Beta M3 — product-facing runtime health (pure helpers, no I/O).
 * Maps internal ServiceInstance / gateway / public probe into user-safe status.
 */

export const PRODUCT_RUNTIME_STATUSES = [
  'HEALTHY',
  'STARTING',
  'DEGRADED',
  'UNHEALTHY',
  'STOPPED',
  'UNKNOWN',
  'DEPLOYING',
  'RESTORING',
  'STATUS_PENDING',
] as const;

export type ProductRuntimeStatus = (typeof PRODUCT_RUNTIME_STATUSES)[number];

export const PRODUCT_RUNTIME_STATUS_LABELS: Record<ProductRuntimeStatus, string> = {
  HEALTHY: '运行正常',
  STARTING: '启动中',
  DEGRADED: '部分异常',
  UNHEALTHY: '运行异常',
  STOPPED: '已停止',
  UNKNOWN: '状态未知',
  DEPLOYING: '正在上线',
  RESTORING: '正在恢复版本',
  STATUS_PENDING: '状态待确认',
};

export const RUNTIME_FAILURE_CATEGORIES = [
  'USER_CODE',
  'USER_CONFIG',
  'PLATFORM',
  'INFRASTRUCTURE',
  'TRANSIENT',
] as const;

export type RuntimeFailureCategory = (typeof RUNTIME_FAILURE_CATEGORIES)[number];

/** Default: treat health older than 12 minutes as stale. */
export const RUNTIME_HEALTH_STALE_MS = 12 * 60_000;

export type RuntimeHealthInput = {
  serviceStatus: string | null | undefined;
  runtimeHealth: string | null | undefined;
  healthMessage?: string | null;
  lastHealthCheckAt?: Date | string | null;
  gatewayStatus?: string | null;
  dnsStatus?: string | null;
  sslStatus?: string | null;
  publicHttpStatus?: number | null;
  publicOk?: boolean | null;
  lastPublicCheckAt?: Date | string | null;
  /** Active deployment in flight (CREATED/QUEUED/RUNNING). */
  activeDeployStatus?: string | null;
  /** True when in-flight deployment has sourceArtifactId (rollback). */
  activeDeployIsRollback?: boolean;
  now?: Date;
  staleMs?: number;
};

export type RuntimeHealthDecision = {
  overallStatus: ProductRuntimeStatus;
  overallLabel: string;
  runtimeStatus: ProductRuntimeStatus;
  publicStatus: 'OK' | 'FAIL' | 'UNKNOWN' | 'N/A';
  stale: boolean;
  anomalyLayer: 'RUNTIME' | 'PUBLIC' | 'GATEWAY' | 'NONE' | 'CONTROL_PLANE';
  failureCategory: RuntimeFailureCategory | null;
  recentError: string | null;
  recommendedAction: string | null;
  fixPromptAvailable: boolean;
};

function asTime(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function isRuntimeHealthStale(
  lastCheckAt: Date | string | null | undefined,
  now = new Date(),
  staleMs = RUNTIME_HEALTH_STALE_MS,
): boolean {
  const t = asTime(lastCheckAt);
  if (t == null) return true;
  return now.getTime() - t >= staleMs;
}

export function relativeCheckLabelZh(
  iso: Date | string | null | undefined,
  now = new Date(),
): string {
  const t = asTime(iso);
  if (t == null) return '尚未检查';
  const delta = Math.max(0, Math.floor((now.getTime() - t) / 1000));
  if (delta < 45) return '刚刚';
  if (delta < 3600) return `${Math.floor(delta / 60)} 分钟前`;
  if (delta < 86400) return `${Math.floor(delta / 3600)} 小时前`;
  return `${Math.floor(delta / 86400)} 天前`;
}

export function decideProductRuntimeHealth(input: RuntimeHealthInput): RuntimeHealthDecision {
  const now = input.now ?? new Date();
  const staleMs = input.staleMs ?? RUNTIME_HEALTH_STALE_MS;
  const service = String(input.serviceStatus || '').toUpperCase();
  const health = String(input.runtimeHealth || '').toUpperCase();
  const deploy = String(input.activeDeployStatus || '').toUpperCase();
  const gateway = String(input.gatewayStatus || '').toUpperCase();
  const dns = String(input.dnsStatus || '').toUpperCase();

  if (deploy === 'CREATED' || deploy === 'QUEUED' || deploy === 'RUNNING') {
    const restoring = Boolean(input.activeDeployIsRollback);
    return {
      overallStatus: restoring ? 'RESTORING' : 'DEPLOYING',
      overallLabel: restoring
        ? PRODUCT_RUNTIME_STATUS_LABELS.RESTORING
        : PRODUCT_RUNTIME_STATUS_LABELS.DEPLOYING,
      runtimeStatus: service === 'RUNNING' && health === 'HEALTHY' ? 'HEALTHY' : 'STARTING',
      publicStatus:
        input.publicOk === true ? 'OK' : input.publicOk === false ? 'FAIL' : 'UNKNOWN',
      stale: false,
      anomalyLayer: 'NONE',
      failureCategory: null,
      recentError: null,
      recommendedAction: restoring
        ? '当前线上版本继续运行，正在安全恢复历史版本。'
        : service === 'RUNNING' && health === 'HEALTHY'
          ? '当前线上版本正常，新版本正在上线。'
          : '正在上线，请稍候。',
      fixPromptAvailable: false,
    };
  }

  if (service === 'STOPPED') {
    return {
      overallStatus: 'STOPPED',
      overallLabel: PRODUCT_RUNTIME_STATUS_LABELS.STOPPED,
      runtimeStatus: 'STOPPED',
      publicStatus: 'N/A',
      stale: false,
      anomalyLayer: 'NONE',
      failureCategory: null,
      recentError: null,
      recommendedAction: '应用已停止。需要访问时请重新启动。',
      fixPromptAvailable: false,
    };
  }

  const healthStale = isRuntimeHealthStale(
    (() => {
      const healthT = asTime(input.lastHealthCheckAt);
      const publicT =
        input.publicOk === true ? asTime(input.lastPublicCheckAt) : null;
      if (healthT == null) return input.lastPublicCheckAt;
      if (publicT == null) return input.lastHealthCheckAt;
      return publicT > healthT ? input.lastPublicCheckAt : input.lastHealthCheckAt;
    })(),
    now,
    staleMs,
  );
  const publicKnown = input.publicOk != null;
  const publicFail = input.publicOk === false;
  const publicOk = input.publicOk === true;
  const gatewayOk = !gateway || gateway === 'ACTIVE';
  const dnsOk = !dns || dns === 'ACTIVE';
  const runtimeHealthy = service === 'RUNNING' && health === 'HEALTHY';
  const runtimeUnhealthy =
    service === 'FAILED' || health === 'UNHEALTHY' || service === 'UNKNOWN';

  if (healthStale && !publicKnown) {
    return {
      overallStatus: 'STATUS_PENDING',
      overallLabel: PRODUCT_RUNTIME_STATUS_LABELS.STATUS_PENDING,
      runtimeStatus: runtimeHealthy ? 'HEALTHY' : 'UNKNOWN',
      publicStatus: 'UNKNOWN',
      stale: true,
      anomalyLayer: 'NONE',
      failureCategory: null,
      recentError: null,
      recommendedAction: '最近一次检查时间较久，正在确认运行状态。',
      fixPromptAvailable: false,
    };
  }

  if (runtimeUnhealthy && service !== 'RUNNING') {
    const message = summarizeRuntimeError(input.healthMessage);
    return {
      overallStatus: 'UNHEALTHY',
      overallLabel: PRODUCT_RUNTIME_STATUS_LABELS.UNHEALTHY,
      runtimeStatus: 'UNHEALTHY',
      publicStatus: publicFail ? 'FAIL' : publicOk ? 'OK' : 'UNKNOWN',
      stale: healthStale,
      anomalyLayer: 'RUNTIME',
      failureCategory: 'USER_CODE',
      recentError: message,
      recommendedAction: '查看启动日志并检查启动命令，必要时重新上线。',
      fixPromptAvailable: true,
    };
  }

  if (runtimeHealthy && publicFail) {
    const http = input.publicHttpStatus;
    return {
      overallStatus: 'UNHEALTHY',
      overallLabel: PRODUCT_RUNTIME_STATUS_LABELS.UNHEALTHY,
      runtimeStatus: 'HEALTHY',
      publicStatus: 'FAIL',
      stale: false,
      anomalyLayer: 'PUBLIC',
      failureCategory: 'PLATFORM',
      recentError: http
        ? `访问地址返回 ${http}`
        : '公网访问检查未通过',
      recommendedAction: 'LaunchOS 正在保留当前可访问状态，请稍后重试。无需修改代码。',
      fixPromptAvailable: false,
    };
  }

  if (runtimeHealthy && (!gatewayOk || !dnsOk)) {
    return {
      overallStatus: 'DEGRADED',
      overallLabel: PRODUCT_RUNTIME_STATUS_LABELS.DEGRADED,
      runtimeStatus: 'HEALTHY',
      publicStatus: publicOk ? 'OK' : 'UNKNOWN',
      stale: healthStale,
      anomalyLayer: 'GATEWAY',
      failureCategory: 'PLATFORM',
      recentError: !dnsOk ? '域名解析未就绪' : '访问入口未就绪',
      recommendedAction: '平台正在配置访问入口，请稍后刷新。无需修改代码。',
      fixPromptAvailable: false,
    };
  }

  if (service === 'RUNNING' && health === 'UNKNOWN') {
    return {
      overallStatus: 'STARTING',
      overallLabel: PRODUCT_RUNTIME_STATUS_LABELS.STARTING,
      runtimeStatus: 'STARTING',
      publicStatus: publicOk ? 'OK' : 'UNKNOWN',
      stale: false,
      anomalyLayer: 'NONE',
      failureCategory: null,
      recentError: null,
      recommendedAction: '应用正在启动，请稍候。',
      fixPromptAvailable: false,
    };
  }

  if (runtimeHealthy && publicOk && gatewayOk && dnsOk) {
    if (healthStale) {
      // Runtime check stale but public still known-good → pending confirm
      return {
        overallStatus: 'STATUS_PENDING',
        overallLabel: PRODUCT_RUNTIME_STATUS_LABELS.STATUS_PENDING,
        runtimeStatus: 'HEALTHY',
        publicStatus: 'OK',
        stale: true,
        anomalyLayer: 'NONE',
        failureCategory: null,
        recentError: null,
        recommendedAction: '内部检查时间较久，公网访问仍正常。正在刷新状态。',
        fixPromptAvailable: false,
      };
    }
    return {
      overallStatus: 'HEALTHY',
      overallLabel: PRODUCT_RUNTIME_STATUS_LABELS.HEALTHY,
      runtimeStatus: 'HEALTHY',
      publicStatus: 'OK',
      stale: false,
      anomalyLayer: 'NONE',
      failureCategory: null,
      recentError: null,
      recommendedAction: null,
      fixPromptAvailable: false,
    };
  }

  if (runtimeHealthy && !publicKnown && gatewayOk && dnsOk) {
    return {
      overallStatus: 'STATUS_PENDING',
      overallLabel: PRODUCT_RUNTIME_STATUS_LABELS.STATUS_PENDING,
      runtimeStatus: 'HEALTHY',
      publicStatus: 'UNKNOWN',
      stale: healthStale,
      anomalyLayer: 'NONE',
      failureCategory: null,
      recentError: null,
      recommendedAction: '正在确认公网访问状态。',
      fixPromptAvailable: false,
    };
  }

  if (service === 'RUNNING' && health === 'UNHEALTHY') {
    const message = summarizeRuntimeError(input.healthMessage);
    return {
      overallStatus: 'UNHEALTHY',
      overallLabel: PRODUCT_RUNTIME_STATUS_LABELS.UNHEALTHY,
      runtimeStatus: 'UNHEALTHY',
      publicStatus: publicFail ? 'FAIL' : publicOk ? 'OK' : 'UNKNOWN',
      stale: healthStale,
      anomalyLayer: 'RUNTIME',
      failureCategory: /config|DATABASE|REDIS|环境变量|配置/i.test(message)
        ? 'USER_CONFIG'
        : 'USER_CODE',
      recentError: message,
      recommendedAction: /config|DATABASE|REDIS|环境变量|配置/i.test(message)
        ? '请检查并补全运行配置后重新上线。'
        : '查看启动日志，确认应用是否正常监听端口。',
      fixPromptAvailable: true,
    };
  }

  return {
    overallStatus: 'UNKNOWN',
    overallLabel: PRODUCT_RUNTIME_STATUS_LABELS.UNKNOWN,
    runtimeStatus: 'UNKNOWN',
    publicStatus: 'UNKNOWN',
    stale: healthStale,
    anomalyLayer: 'NONE',
    failureCategory: null,
    recentError: null,
    recommendedAction: '暂时无法确认运行状态，请稍后刷新。',
    fixPromptAvailable: false,
  };
}

function summarizeRuntimeError(message: string | null | undefined): string {
  const text = String(message || '').trim();
  if (!text) return '应用运行检查未通过。';
  if (/exit|exited|立即退出/i.test(text)) return '应用启动后立即退出。';
  if (/port|端口|EADDRINUSE|未检测到/i.test(text)) return '应用启动失败：未检测到预期端口。';
  if (/502|Bad Gateway/i.test(text)) return '访问地址返回 502。';
  if (/timeout|超时/i.test(text)) return '健康检查超时。';
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

export function buildRuntimeFixPrompt(input: {
  projectName: string;
  version: string | null;
  recentError: string | null;
  stage: string;
}): string {
  return [
    `请帮我排查 LaunchOS 应用「${input.projectName}」的运行问题。`,
    input.version ? `当前版本：${input.version}` : null,
    `失败阶段：${input.stage}`,
    `错误摘要：${input.recentError || '未知'}`,
    '请检查启动命令、监听端口、环境变量是否完整，并给出最小修复方案。',
    '不要索要或输出任何密钥、token、数据库密码。',
  ]
    .filter(Boolean)
    .join('\n');
}
