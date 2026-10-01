/**
 * Step 26.3 — Server Initialization domain (no app deploy).
 */
export type ServerInitializationPhase =
  | 'PENDING_INITIALIZATION'
  | 'CONNECTING'
  | 'DETECTING_SYSTEM'
  | 'PREPARING_DIRECTORIES'
  | 'INSTALLING_RUNTIME'
  | 'CONFIGURING_FIREWALL'
  | 'CONFIGURING_RUNTIME'
  | 'VERIFYING_RUNTIME'
  | 'READY'
  | 'FAILED';

export type ServerInitializationReadiness =
  | 'READY_FOR_INITIALIZATION'
  | 'INITIALIZING'
  | 'READY'
  | 'INITIALIZATION_FAILED';

export type ServerInitializationErrorCode =
  | 'SSH_TIMEOUT'
  | 'SSH_AUTH_FAILED'
  | 'SSH_CONNECTION_REFUSED'
  | 'SSH_HOST_UNREACHABLE'
  | 'SSH_COMMAND_FAILED'
  | 'SSH_RECONNECT_FAILED'
  | 'UNSUPPORTED_OS'
  | 'UNSUPPORTED_PACKAGE_MANAGER'
  | 'PACKAGE_MANAGER_PROBE_FAILED'
  | 'PACKAGE_INSTALL_FAILED'
  | 'RUNTIME_VERIFY_FAILED'
  | 'FIREWALL_CONFIGURATION_FAILED'
  | 'SERVER_INITIALIZATION_INCOMPLETE'
  | 'ALREADY_READY'
  | 'ALREADY_IN_PROGRESS'
  | 'CREDENTIAL_MISSING'
  | 'TARGET_MISMATCH'
  | 'UNKNOWN';

export const SERVER_INIT_PHASE_LABELS: Record<ServerInitializationPhase, string> = {
  PENDING_INITIALIZATION: '等待初始化',
  CONNECTING: '连接服务器',
  DETECTING_SYSTEM: '检查服务器环境',
  PREPARING_DIRECTORIES: '准备运行目录',
  INSTALLING_RUNTIME: '安装运行环境',
  CONFIGURING_FIREWALL: '配置安全规则',
  CONFIGURING_RUNTIME: '准备运行服务',
  VERIFYING_RUNTIME: '检查运行环境',
  READY: '服务器已就绪',
  FAILED: '初始化失败',
};

export const SERVER_INIT_READINESS_LABELS: Record<ServerInitializationReadiness, string> = {
  READY_FOR_INITIALIZATION: '服务器已创建，等待初始化',
  INITIALIZING: '正在初始化服务器',
  READY: '服务器已就绪',
  INITIALIZATION_FAILED: '服务器初始化失败',
};

export const SERVER_INIT_PROGRESS: Record<ServerInitializationPhase, number> = {
  PENDING_INITIALIZATION: 0,
  CONNECTING: 10,
  DETECTING_SYSTEM: 20,
  PREPARING_DIRECTORIES: 35,
  INSTALLING_RUNTIME: 55,
  CONFIGURING_FIREWALL: 70,
  CONFIGURING_RUNTIME: 80,
  VERIFYING_RUNTIME: 95,
  READY: 100,
  FAILED: 0,
};

export const LAUNCHOS_ROOT = '/opt/launchos';
export const LAUNCHOS_DIRS = [
  '/opt/launchos/apps',
  '/opt/launchos/runtime',
  '/opt/launchos/logs',
  '/opt/launchos/artifacts',
  '/opt/launchos/tmp',
  '/opt/launchos/config',
] as const;

export const DYNAMIC_PORT_RANGE_START = 39000;
export const DYNAMIC_PORT_RANGE_END = 39999;
export const RUNTIME_BIND_ADDRESS = '127.0.0.1';
export const PUBLIC_ALLOWED_PORTS = [22, 80, 443] as const;

export const SERVER_INIT_USER_MESSAGES: Record<ServerInitializationErrorCode, string> = {
  SSH_TIMEOUT: '连接服务器超时，请稍后重试初始化。',
  SSH_AUTH_FAILED: '服务器登录凭据无效，请检查后重新初始化。',
  SSH_CONNECTION_REFUSED: '无法连接服务器，请确认服务器已启动且端口开放。',
  SSH_HOST_UNREACHABLE: '暂时无法访问服务器，请稍后重试。',
  SSH_COMMAND_FAILED: '服务器初始化命令执行失败。',
  SSH_RECONNECT_FAILED: '安全规则更新后无法重新连接服务器，请检查后重试。',
  UNSUPPORTED_OS: '当前服务器系统暂不支持自动初始化。',
  UNSUPPORTED_PACKAGE_MANAGER: '当前服务器缺少可用的软件包管理器。',
  PACKAGE_MANAGER_PROBE_FAILED: '服务器软件包管理器检查失败，请稍后重试。',
  PACKAGE_INSTALL_FAILED: '服务器运行环境安装失败。',
  RUNTIME_VERIFY_FAILED: '服务器运行环境检查失败。',
  FIREWALL_CONFIGURATION_FAILED: '服务器安全规则配置失败。',
  SERVER_INITIALIZATION_INCOMPLETE: '服务器初始化未完成，请重新初始化。',
  ALREADY_READY: '服务器已就绪，无需重复初始化。',
  ALREADY_IN_PROGRESS: '服务器正在初始化中。',
  CREDENTIAL_MISSING: '服务器登录凭据未就绪。',
  TARGET_MISMATCH: '初始化目标服务器不匹配。',
  UNKNOWN: '服务器初始化失败。',
};

export function serverInitializationUserMessage(
  code: ServerInitializationErrorCode,
): string {
  return SERVER_INIT_USER_MESSAGES[code] || SERVER_INIT_USER_MESSAGES.UNKNOWN;
}

export function classifyServerInitializationError(error: unknown): ServerInitializationErrorCode {
  const text = String(
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error && 'message' in error
        ? (error as { message?: string }).message
        : error,
  ).toLowerCase();
  const code =
    typeof error === 'object' && error && 'code' in error
      ? String((error as { code?: unknown }).code || '').toUpperCase()
      : '';
  if (code && code in SERVER_INIT_USER_MESSAGES) {
    return code as ServerInitializationErrorCode;
  }
  if (/auth|permission denied|invalid password|authentication/.test(text)) {
    return 'SSH_AUTH_FAILED';
  }
  if (/econnrefused|connection refused/.test(text)) return 'SSH_CONNECTION_REFUSED';
  if (/enotfound|ehostunreach|network unreachable|no route/.test(text)) {
    return 'SSH_HOST_UNREACHABLE';
  }
  if (/etimedout|timeout|timed out/.test(text)) return 'SSH_TIMEOUT';
  if (/unsupported_os|unknown linux/.test(text)) return 'UNSUPPORTED_OS';
  if (/package_manager_probe|probe failed/.test(text)) return 'PACKAGE_MANAGER_PROBE_FAILED';
  if (/package.?manager|dnf|yum|apt-get|microdnf/.test(text) && /unsupported|missing|no .*on host/.test(text)) {
    return 'UNSUPPORTED_PACKAGE_MANAGER';
  }
  if (/podman|runtime/.test(text) && /install|dnf|yum|apt/.test(text)) {
    return 'PACKAGE_INSTALL_FAILED';
  }
  if (/firewall|iptables|nft/.test(text)) return 'FIREWALL_CONFIGURATION_FAILED';
  if (/reconnect/.test(text)) return 'SSH_RECONNECT_FAILED';
  if (/incomplete/.test(text)) return 'SERVER_INITIALIZATION_INCOMPLETE';
  if (/command failed|exit code|nonzero/.test(text)) return 'SSH_COMMAND_FAILED';
  return 'UNKNOWN';
}

/** Resolve SSH username from facts — never blind-guess ubuntu/ec2-user. */
export function resolveServerSshUsername(input: {
  serverUsername?: string | null;
  imageName?: string | null;
  osName?: string | null;
  provider?: string | null;
}): string {
  const existing = String(input.serverUsername || '').trim();
  if (existing && !/^(ubuntu|ec2-user)$/i.test(existing)) {
    return existing;
  }
  if (existing && /^(ubuntu|ec2-user)$/i.test(existing)) {
    // Reject blind guesses stored by mistake when image is Alibaba Cloud Linux.
  }
  const blob = `${input.imageName || ''} ${input.osName || ''}`.toLowerCase();
  if (
    input.provider === 'ALIYUN' ||
    /alibaba cloud linux|alinux|alibase|alibaba_cloud_linux/.test(blob)
  ) {
    return 'root';
  }
  if (existing) return existing;
  return 'root';
}

export function canStartServerInitialization(
  readiness: string | null | undefined,
): readiness is 'READY_FOR_INITIALIZATION' | 'INITIALIZATION_FAILED' {
  return readiness === 'READY_FOR_INITIALIZATION' || readiness === 'INITIALIZATION_FAILED';
}

export function isServerInitializationInFlight(
  readiness: string | null | undefined,
  phase?: string | null,
): boolean {
  if (readiness === 'INITIALIZING') return true;
  const p = String(phase || '');
  return [
    'CONNECTING',
    'DETECTING_SYSTEM',
    'PREPARING_DIRECTORIES',
    'INSTALLING_RUNTIME',
    'CONFIGURING_FIREWALL',
    'CONFIGURING_RUNTIME',
    'VERIFYING_RUNTIME',
    'PENDING_INITIALIZATION',
  ].includes(p);
}

export function serverInitializationLockKey(serverInstanceId: string): string {
  return `server-initialize:${serverInstanceId}`;
}

export function buildServerInitializationPlan(input: {
  publicIp: string;
  privateIp?: string | null;
  providerResourceId?: string | null;
  username: string;
  passwordPresent: boolean;
  /** Fact-based runtime plan; when omitted, returns detection-first placeholder (no dnf||yum-only). */
  runtimePlan?: string[];
}): {
  osDetectionPlan: string[];
  directoryPlan: string[];
  runtimePlan: string[];
  firewallPlan: string[];
  runtimeConfigPlan: string[];
  dynamicPortRangeStart: number;
  dynamicPortRangeEnd: number;
  bindAddress: string;
  target: { publicIp: string; privateIp: string | null; providerResourceId: string | null };
  ssh: { username: string; port: number; passwordPresent: boolean };
} {
  return {
    osDetectionPlan: [
      'uname -a',
      'cat /etc/os-release',
      'uname -m',
      'id',
      'whoami',
      'df -h',
      'free -m',
    ],
    directoryPlan: [...LAUNCHOS_DIRS].map((d) => `mkdir -p ${d}`),
    runtimePlan: input.runtimePlan ?? [
      'detect podman',
      'detect docker',
      'detect package managers (dnf/yum/microdnf/apt-get independently)',
      'reuse podman if present; otherwise select package manager by OS family',
      'verify podman',
      'verify docker compatibility',
    ],
    firewallPlan: [
      'detect firewalld/nft/iptables',
      'prefer Alibaba Security Group 22/80/443',
      'do not open 3000/3001/39000-39999 publicly',
      'SSH safety check before/after any host firewall change',
    ],
    runtimeConfigPlan: [
      'filesystem writable under /opt/launchos',
      'podman usable',
      'persist dynamicPortRange 39000-39999 bind 127.0.0.1',
      'no user app systemd units',
    ],
    dynamicPortRangeStart: DYNAMIC_PORT_RANGE_START,
    dynamicPortRangeEnd: DYNAMIC_PORT_RANGE_END,
    bindAddress: RUNTIME_BIND_ADDRESS,
    target: {
      publicIp: input.publicIp,
      privateIp: input.privateIp || null,
      providerResourceId: input.providerResourceId || null,
    },
    ssh: {
      username: input.username,
      port: 22,
      passwordPresent: input.passwordPresent,
    },
  };
}

export function phaseAfter(lastSuccessful: string | null | undefined): ServerInitializationPhase {
  const order: ServerInitializationPhase[] = [
    'CONNECTING',
    'DETECTING_SYSTEM',
    'PREPARING_DIRECTORIES',
    'INSTALLING_RUNTIME',
    'CONFIGURING_FIREWALL',
    'CONFIGURING_RUNTIME',
    'VERIFYING_RUNTIME',
    'READY',
  ];
  if (!lastSuccessful) return 'CONNECTING';
  const idx = order.indexOf(lastSuccessful as ServerInitializationPhase);
  if (idx < 0 || idx >= order.length - 1) return 'CONNECTING';
  return order[idx + 1]!;
}

export type ServerInitializationMeta = {
  initializationId?: string;
  phase?: ServerInitializationPhase;
  status?: 'PENDING' | 'RUNNING' | 'READY' | 'FAILED';
  progress?: number;
  startedAt?: string | null;
  completedAt?: string | null;
  failedAt?: string | null;
  lastSuccessfulPhase?: ServerInitializationPhase | null;
  osFamily?: string | null;
  osName?: string | null;
  osVersion?: string | null;
  architecture?: string | null;
  kernelVersion?: string | null;
  cpuArchitecture?: string | null;
  diskTotal?: string | null;
  memoryTotal?: string | null;
  initializationCheckedAt?: string | null;
  runtimeType?: string | null;
  runtimeVersion?: string | null;
  dockerCompatibility?: boolean | null;
  firewallStatus?: string | null;
  launchosRoot?: string;
  dynamicPortRangeStart?: number;
  dynamicPortRangeEnd?: number;
  bindAddress?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  failedPhase?: string | null;
  failedOperation?: string | null;
  passwordPresent?: boolean;
  passwordLength?: number;
  cloudResourceId?: string | null;
  providerResourceId?: string | null;
  privateIp?: string | null;
  region?: string | null;
  imageName?: string | null;
};

export function asServerInitMeta(value: unknown): ServerInitializationMeta {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as ServerInitializationMeta;
  }
  return {};
}

/** Invariant: job must not complete while readiness is still INITIALIZING. */
export function assertServerInitializationComplete(input: {
  serverReadiness: string | null | undefined;
  phase?: string | null;
  status?: string | null;
}): void {
  const ready = input.serverReadiness === 'READY';
  const failed =
    input.serverReadiness === 'INITIALIZATION_FAILED' ||
    input.phase === 'FAILED' ||
    input.status === 'FAILED';
  if (ready || failed) return;
  throw Object.assign(new Error('SERVER_INITIALIZATION_INCOMPLETE'), {
    code: 'SERVER_INITIALIZATION_INCOMPLETE',
  });
}
