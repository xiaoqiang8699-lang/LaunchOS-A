/**
 * Step 27 — Managed Application Deployment domain helpers.
 * Deploy artifacts onto READY LaunchOS-managed ECS at 127.0.0.1:39000–39999.
 */
import {
  DYNAMIC_PORT_RANGE_END,
  DYNAMIC_PORT_RANGE_START,
  RUNTIME_BIND_ADDRESS,
} from './server-initialization.js';

export const MANAGED_DEPLOY_PHASE_LABELS = {
  PENDING: '等待部署',
  PREPARING: '准备部署',
  ALLOCATING_PORT: '分配运行端口',
  UPLOADING_ARTIFACT: '上传应用',
  PREPARING_RUNTIME: '准备运行环境',
  STARTING_SERVICE: '启动应用',
  HEALTH_CHECK: '检查应用',
  RUNNING: '运行中',
  FAILED: '部署失败',
  ROLLING_BACK: '正在回滚',
  ROLLED_BACK: '已回滚',
} as const;

export type ManagedDeployPhase = keyof typeof MANAGED_DEPLOY_PHASE_LABELS;

export type ManagedDeployBlockerCode =
  | 'SERVER_NOT_READY'
  | 'SERVER_NOT_FOUND'
  | 'SERVER_FORBIDDEN'
  | 'RUNTIME_NOT_READY'
  | 'BIND_ADDRESS_INVALID'
  | 'ARTIFACT_NOT_READY'
  | 'ARTIFACT_NOT_RUNNABLE'
  | 'DEPENDENCY_NOT_READY'
  | 'RUNTIME_CONFIG_MISSING'
  | 'PORT_ALLOCATION_FAILED'
  | 'DEPLOYMENT_IN_PROGRESS'
  | 'OLD_SERVER_FORBIDDEN'
  | 'MANAGED_SERVER_NOT_BOUND'
  | 'MANAGED_RUNTIME_PORT_OUT_OF_RANGE'
  | 'DEPLOYABLE_IMAGE_NOT_READY'
  | 'IMAGE_ARCHITECTURE_MISMATCH'
  | 'BASE_IMAGE_PULL_FAILED'
  | 'CONTAINER_REGISTRY_UNREACHABLE';

/** Step 27.2 — future registry providers (ACR / Harbor / GHCR / Docker Hub). */
export type ImageRegistryProviderKind =
  | 'ARTIFACT_STORE'
  | 'ALIYUN_ACR'
  | 'HARBOR'
  | 'GHCR'
  | 'DOCKER_HUB';

export type ImageRegistryProvider = {
  kind: ImageRegistryProviderKind;
  /** Alpha: ARTIFACT_STORE (MinIO → podman load) is the only required path. */
  supportsPull: boolean;
  supportsPush: boolean;
};

export const ALPHA_IMAGE_REGISTRY: ImageRegistryProvider = {
  kind: 'ARTIFACT_STORE',
  supportsPull: false,
  supportsPush: false,
};

export const RUNTIME_PULL_POLICY = 'never' as const;
export const MANAGED_IMAGE_ARCHITECTURE = 'amd64' as const;
export const MANAGED_SERVER_ARCHITECTURE = 'x86_64' as const;

export type DockerImageArtifactMetadata = {
  kind: 'DOCKER_IMAGE_ARCHIVE';
  imageName: string;
  imageTag: string;
  architecture: string;
  os?: string;
  containerPort: number;
  entrypoint?: string[];
  cmd?: string[];
  sourceArtifactId?: string;
  checksumSha256?: string;
  builtOn?: 'launchos-builder';
};

export const DEPLOYMENT_TARGET_TYPES = ['LOCAL', 'MANAGED_SERVER'] as const;
export type DeploymentTargetType = (typeof DEPLOYMENT_TARGET_TYPES)[number];

/** Failed container diagnostic retention (hours) before policy allows cleanup. */
export const FAILED_CONTAINER_DIAGNOSTIC_RETENTION_HOURS = 24;

export const FAILED_CONTAINER_CLEANUP_POLICY = {
  retainFailedContainerForDiagnosis: true,
  retentionHours: FAILED_CONTAINER_DIAGNOSTIC_RETENTION_HOURS,
  autoRemoveAfterRetention: true,
  preservePreviousHealthyRevision: true,
} as const;

export type ManagedDeployBlocker = {
  code: ManagedDeployBlockerCode;
  message: string;
};

export type ManagedServerDeployFacts = {
  id: string;
  host: string;
  status: string | null | undefined;
  dockerStatus?: string | null;
  provider?: string | null;
  metadata?: unknown;
};

export const FORBIDDEN_MANAGED_DEPLOY_HOSTS = ['8.138.113.134'] as const;

/** Step 27 Phase 2 E2E whitelist (API unit → managed ECS). */
export const STEP27_MANAGED_DEPLOY_WHITELIST = {
  projectId: 'cmu3j24mv0001ri7wcsoa30hj',
  unitId: 'cmu3j272x0005ri7wlxlbajeu',
  serverInstanceId: 'cmub78pz001sdripco5pexhdz',
  publicIp: '116.62.198.184',
  artifactId: 'cmu56y2zy002briz0u5ttr229',
  containerPort: 3000,
} as const;

/** Step 28 Multi-Unit whitelist (Web unit → same managed ECS as Step 27 API). */
export const STEP28_MULTI_UNIT_DEPLOY_WHITELIST = {
  projectId: 'cmu3j24mv0001ri7wcsoa30hj',
  apiUnitId: 'cmu3j272x0005ri7wlxlbajeu',
  webUnitId: 'cmu3j27340007ri7wcno1xrai',
  serverInstanceId: 'cmub78pz001sdripco5pexhdz',
  publicIp: '116.62.198.184',
  apiServiceInstanceId: 'cmuc66642002hritk6h3cbwhe',
  apiRuntimePort: 39000,
  /** Prefer latest READY Web BUILD_OUTPUT; override via CLI if needed. */
  webSourceArtifactId: 'cmu3scwr3016fri3c35ryb3y2',
  /** Phase 1 prepared DOCKER_IMAGE archive (MinIO). */
  webDeployableArtifactId: 'cmuc6x7hd0001ri10yvj0rr6o',
  /** Vite static serve listens on 80 inside the archive image. */
  webContainerPort: 80,
} as const;

export function managedDeploymentLockKey(projectId: string, unitId: string): string {
  return `deployment:${projectId}:${unitId}`;
}

export function asManagedServerMeta(
  metadata: unknown,
): Record<string, unknown> {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    return metadata as Record<string, unknown>;
  }
  return {};
}

export function resolveManagedRuntimeType(meta: Record<string, unknown>): string | null {
  const raw = meta.runtimeType;
  return typeof raw === 'string' && raw.trim() ? raw.trim().toLowerCase() : null;
}

export function resolveManagedBindAddress(meta: Record<string, unknown>): string {
  const raw = meta.bindAddress;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return RUNTIME_BIND_ADDRESS;
}

export function isManagedRuntimeUsable(input: {
  status?: string | null;
  dockerStatus?: string | null;
  runtimeType?: string | null;
  dockerCompatibility?: unknown;
}): boolean {
  if (String(input.status || '').toUpperCase() !== 'READY') return false;
  const rt = String(input.runtimeType || '').toLowerCase();
  if (rt === 'podman' || rt === 'docker') return true;
  if (input.dockerCompatibility === true) return true;
  const dockerStatus = String(input.dockerStatus || '').toUpperCase();
  return dockerStatus === 'READY';
}

/**
 * Validate a ServerInstance is eligible for managed deploy (Step 27).
 */
export function evaluateManagedServerForDeploy(
  server: ManagedServerDeployFacts | null | undefined,
  options?: { allowedServerInstanceId?: string | null; forbidHosts?: string[] },
): { ok: boolean; blockers: ManagedDeployBlocker[]; facts: Record<string, unknown> } {
  const blockers: ManagedDeployBlocker[] = [];
  if (!server?.id) {
    blockers.push({ code: 'SERVER_NOT_FOUND', message: '未找到可用的托管服务器' });
    return { ok: false, blockers, facts: {} };
  }

  const forbid = options?.forbidHosts ?? [...FORBIDDEN_MANAGED_DEPLOY_HOSTS];
  if (forbid.includes(server.host)) {
    blockers.push({
      code: 'OLD_SERVER_FORBIDDEN',
      message: '禁止部署到受保护的旧服务器',
    });
  }

  if (
    options?.allowedServerInstanceId &&
    server.id !== options.allowedServerInstanceId
  ) {
    blockers.push({
      code: 'SERVER_FORBIDDEN',
      message: '本轮仅允许部署到指定托管服务器',
    });
  }

  const meta = asManagedServerMeta(server.metadata);
  const runtimeType = resolveManagedRuntimeType(meta);
  const bindAddress = resolveManagedBindAddress(meta);
  const dockerCompatibility = meta.dockerCompatibility === true;

  if (String(server.status || '').toUpperCase() !== 'READY') {
    blockers.push({
      code: 'SERVER_NOT_READY',
      message: `服务器尚未就绪（当前：${server.status || 'UNKNOWN'}）`,
    });
  }

  if (
    !isManagedRuntimeUsable({
      status: server.status,
      dockerStatus: server.dockerStatus,
      runtimeType,
      dockerCompatibility,
    })
  ) {
    blockers.push({
      code: 'RUNTIME_NOT_READY',
      message: '服务器运行环境尚未就绪（需要 Podman / Docker 兼容）',
    });
  }

  if (bindAddress !== '127.0.0.1' && bindAddress !== RUNTIME_BIND_ADDRESS) {
    blockers.push({
      code: 'BIND_ADDRESS_INVALID',
      message: `运行端口必须绑定 ${RUNTIME_BIND_ADDRESS}`,
    });
  }

  return {
    ok: blockers.length === 0,
    blockers,
    facts: {
      serverInstanceId: server.id,
      host: server.host,
      serverReadiness: server.status,
      runtimeType: runtimeType || (dockerCompatibility ? 'docker-compatible' : null),
      dockerCompatibility,
      bindAddress,
      dynamicPortRangeStart: DYNAMIC_PORT_RANGE_START,
      dynamicPortRangeEnd: DYNAMIC_PORT_RANGE_END,
    },
  };
}

export function planNextRuntimePort(reservedPorts: number[]): number | null {
  const blocked = new Set(
    reservedPorts.filter((p) => Number.isFinite(p) && p > 0),
  );
  // Never allocate classic app ports as host ports.
  blocked.add(3000);
  blocked.add(3001);
  blocked.add(80);
  blocked.add(443);
  for (let p = DYNAMIC_PORT_RANGE_START; p <= DYNAMIC_PORT_RANGE_END; p += 1) {
    if (!blocked.has(p)) return p;
  }
  return null;
}

export function assertRuntimePublishSpec(input: {
  publishHost?: string | null;
  hostPort: number;
  containerPort: number;
}): void {
  const host = (input.publishHost || RUNTIME_BIND_ADDRESS).trim();
  if (host === '0.0.0.0' || host === '*' || host === '') {
    throw Object.assign(new Error('RUNTIME_PUBLIC_BIND_FORBIDDEN'), {
      code: 'RUNTIME_PUBLIC_BIND_FORBIDDEN',
    });
  }
  if (host !== '127.0.0.1' && host !== RUNTIME_BIND_ADDRESS) {
    throw Object.assign(new Error('RUNTIME_PUBLIC_BIND_FORBIDDEN'), {
      code: 'RUNTIME_PUBLIC_BIND_FORBIDDEN',
    });
  }
  if (input.hostPort < DYNAMIC_PORT_RANGE_START || input.hostPort > DYNAMIC_PORT_RANGE_END) {
    throw new Error('HOST_PORT_OUT_OF_RANGE');
  }
  if (input.hostPort === 3000 || input.hostPort === 3001) {
    throw new Error('HOST_PORT_FORBIDDEN');
  }
}

/**
 * Classify remote start/health/registry failures for Step 27 diagnosis (not UNKNOWN).
 */
export function classifyManagedDeployRuntimeFailure(message: string): {
  code:
    | 'CONTAINER_START_FAILED'
    | 'CONTAINER_EXITED'
    | 'HEALTH_CHECK_FAILED'
    | 'RUNTIME_PUBLIC_BIND_FORBIDDEN'
    | 'BASE_IMAGE_PULL_FAILED'
    | 'CONTAINER_REGISTRY_UNREACHABLE'
    | 'DEPLOYABLE_IMAGE_NOT_LOADED'
    | 'IMAGE_ARCHITECTURE_MISMATCH'
    | 'DEPENDENCY_INSTALL_FAILED'
    | 'BUILD_IMAGE_FAILED';
  userMessage: string;
} {
  const text = String(message || '');
  if (
    /DEPENDENCY_INSTALL_FAILED|Could not find Prisma Schema|prisma generate|npm error|npm ERR!|pnpm ERR|yarn error|ERESOLVE|building at STEP \"RUN npm|building at STEP \"RUN pnpm|building at STEP \"RUN yarn|postinstall/i.test(
      text,
    )
  ) {
    return {
      code: 'DEPENDENCY_INSTALL_FAILED',
      userMessage: '依赖安装失败，已停止本次发布。当前线上版本未改动。',
    };
  }
  if (/BUILD_IMAGE_FAILED|docker build|podman build|building at STEP/i.test(text)) {
    return {
      code: 'BUILD_IMAGE_FAILED',
      userMessage: '应用镜像构建失败，已停止本次发布。当前线上版本未改动。',
    };
  }
  if (/RUNTIME_PUBLIC_BIND_FORBIDDEN|0\.0\.0\.0|公网暴露/i.test(text)) {
    return {
      code: 'RUNTIME_PUBLIC_BIND_FORBIDDEN',
      userMessage: '运行端口绑定不安全，已停止部署。',
    };
  }
  if (/IMAGE_ARCHITECTURE_MISMATCH|architecture mismatch/i.test(text)) {
    return {
      code: 'IMAGE_ARCHITECTURE_MISMATCH',
      userMessage: '镜像架构与服务器不兼容，已停止部署。',
    };
  }
  if (
    /CONTAINER_REGISTRY_UNREACHABLE|registry-1\.docker\.io|docker\.io\/library|toomanyrequests|TLS handshake|no such host|lookup registry|connection reset|i\/o timeout|dial tcp.*docker/i.test(
      text,
    )
  ) {
    return {
      code: 'CONTAINER_REGISTRY_UNREACHABLE',
      userMessage: '容器镜像仓库不可达，托管部署不应依赖公网 registry。',
    };
  }
  if (/BASE_IMAGE_PULL_FAILED|failed to pull|pull access denied|manifest unknown/i.test(text)) {
    return {
      code: 'BASE_IMAGE_PULL_FAILED',
      userMessage: '基础镜像拉取失败。镜像应在 LaunchOS Builder 构建，不应在托管 ECS 拉取。',
    };
  }
  if (/DEPLOYABLE_IMAGE_NOT_LOADED|Unable to find image|image not known|short-name/i.test(text)) {
    return {
      code: 'DEPLOYABLE_IMAGE_NOT_LOADED',
      userMessage: '可部署镜像未成功加载到服务器，已停止部署。',
    };
  }
  if (/exited|dead|not running|State\.Status/i.test(text)) {
    return {
      code: 'CONTAINER_EXITED',
      userMessage: '应用进程启动后立即退出，已保留当前线上版本。',
    };
  }
  if (/超时|timeout|ECONNREFUSED|没有响应|health/i.test(text)) {
    return {
      code: 'HEALTH_CHECK_FAILED',
      userMessage: '新版本启动后未能通过健康检查，已保留当前线上版本。',
    };
  }
  return {
    code: 'CONTAINER_START_FAILED',
    userMessage: '应用启动失败，已保留当前线上版本。',
  };
}

export function normalizeServerArchitecture(raw?: string | null): string {
  const v = String(raw || '').toLowerCase().trim();
  if (!v) return MANAGED_SERVER_ARCHITECTURE;
  if (v === 'amd64' || v === 'x86_64' || v === 'x64') return 'x86_64';
  if (v === 'arm64' || v === 'aarch64') return 'arm64';
  return v;
}

export function normalizeImageArchitecture(raw?: string | null): string {
  const v = String(raw || '').toLowerCase().trim();
  if (!v) return MANAGED_IMAGE_ARCHITECTURE;
  if (v === 'x86_64' || v === 'x64') return 'amd64';
  return v;
}

export function assertImageArchitectureCompatible(input: {
  imageArchitecture?: string | null;
  serverArchitecture?: string | null;
}): void {
  const image = normalizeImageArchitecture(input.imageArchitecture);
  const server = normalizeServerArchitecture(input.serverArchitecture);
  const compatible =
    (image === 'amd64' && (server === 'x86_64' || server === 'amd64')) ||
    (image === 'arm64' && (server === 'arm64' || server === 'aarch64')) ||
    image === server;
  if (!compatible) {
    throw Object.assign(
      new Error(
        `IMAGE_ARCHITECTURE_MISMATCH: image=${image} server=${server}`,
      ),
      { code: 'IMAGE_ARCHITECTURE_MISMATCH' },
    );
  }
}

/**
 * Scan build context / Dockerfile text for accidental secret baking.
 * Returns plaintext hit counts (must be 0 before shipping image archive).
 */
export function scanImageBuildForSecrets(text: string): {
  imageBuildSecretPlaintextHits: number;
  hits: string[];
} {
  const hits: string[] = [];
  const blob = String(text || '');
  if (/DATABASE_URL\s*=\s*postgres/i.test(blob) || /postgres(ql)?:\/\/[^:\s]+:[^@\s]+@/i.test(blob)) {
    hits.push('DATABASE_URL');
  }
  if (/REDIS_URL\s*=\s*redis:\/\//i.test(blob) || /redis:\/\/[^:\s]+:[^@\s]+@/i.test(blob)) {
    hits.push('REDIS_URL');
  }
  if (/JWT_SECRET\s*=\s*\S+/i.test(blob)) hits.push('JWT_SECRET');
  if (/LTAI[A-Za-z0-9]{12,}/.test(blob)) hits.push('ALIYUN_AK');
  if (/SSH_PASSWORD|PRIVATE_KEY|BEGIN (RSA |OPENSSH )?PRIVATE KEY/i.test(blob)) {
    hits.push('SSH_CREDENTIAL');
  }
  return { imageBuildSecretPlaintextHits: hits.length, hits };
}

export function asDockerImageMetadata(raw: unknown): DockerImageArtifactMetadata | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (m.kind !== 'DOCKER_IMAGE_ARCHIVE') return null;
  if (typeof m.imageTag !== 'string' || typeof m.imageName !== 'string') return null;
  return {
    kind: 'DOCKER_IMAGE_ARCHIVE',
    imageName: m.imageName,
    imageTag: m.imageTag,
    architecture: String(m.architecture || MANAGED_IMAGE_ARCHITECTURE),
    os: typeof m.os === 'string' ? m.os : 'linux',
    containerPort: Number(m.containerPort) || 3000,
    entrypoint: Array.isArray(m.entrypoint) ? (m.entrypoint as string[]) : undefined,
    cmd: Array.isArray(m.cmd) ? (m.cmd as string[]) : undefined,
    sourceArtifactId: typeof m.sourceArtifactId === 'string' ? m.sourceArtifactId : undefined,
    checksumSha256: typeof m.checksumSha256 === 'string' ? m.checksumSha256 : undefined,
    builtOn: 'launchos-builder',
  };
}

export function shouldSkipPublicGatewayForManagedDeploy(input: {
  provider?: string | null;
  metadata?: Record<string, unknown> | null;
  scope?: string | null;
}): boolean {
  // Platform nodes must get a public gateway. Workspace Aliyun servers stay on the old path.
  if (String(input.scope || '').toUpperCase() === 'PLATFORM_MANAGED') return false;
  const provider = String(input.provider || '').toUpperCase();
  if (provider === 'ALIYUN') return true;
  const meta = asManagedServerMeta(input.metadata);
  return meta.firewallStatus === 'PROVIDER_SECURITY_GROUP_ONLY';
}

export type PlatformManagedNodeCandidate = {
  id: string;
  scope?: string | null;
  status?: string | null;
  dockerStatus?: string | null;
  updatedAt?: Date | string | null;
  metadata?: unknown;
};

/** Oldest READY platform node that passed colocated-gateway preflight. */
export function pickPlatformManagedNode(
  nodes: PlatformManagedNodeCandidate[],
): PlatformManagedNodeCandidate | null {
  const ready = nodes.filter((node) => {
    if (String(node.scope || '').toUpperCase() !== 'PLATFORM_MANAGED') return false;
    const meta = asManagedServerMeta(node.metadata);
    if (meta.localGatewayReady !== true || meta.schedulable === false) return false;
    return isManagedRuntimeUsable({
      status: node.status,
      dockerStatus: node.dockerStatus,
      runtimeType: resolveManagedRuntimeType(meta),
      dockerCompatibility: meta.dockerCompatibility === true,
    });
  });
  ready.sort((left, right) => {
    const leftMs = left.updatedAt ? Date.parse(String(left.updatedAt)) : 0;
    const rightMs = right.updatedAt ? Date.parse(String(right.updatedAt)) : 0;
    return leftMs - rightMs;
  });
  return ready[0] ?? null;
}

export function managedAccessEntryPendingMessage(): string {
  return '应用已运行，正在等待访问入口配置';
}

export function summarizeManagedDeployGate(input: {
  serverOk: boolean;
  artifactReady: boolean;
  dependencyReady: boolean;
  runtimeSecretsReady: boolean;
  queueReady: boolean;
  lockReady: boolean;
  plannedRuntimePort: number | null;
  blockers: ManagedDeployBlocker[];
  /** Step 27.2 — managed requires a READY DOCKER_IMAGE archive when provided. */
  deployableImageReady?: boolean;
}): { canDeploy: boolean; blockers: ManagedDeployBlocker[] } {
  const blockers = [...input.blockers];
  if (!input.artifactReady) {
    blockers.push({ code: 'ARTIFACT_NOT_READY', message: '应用制品尚未就绪' });
  }
  if (input.deployableImageReady === false) {
    blockers.push({
      code: 'DEPLOYABLE_IMAGE_NOT_READY',
      message: '可部署容器镜像制品尚未就绪',
    });
  }
  if (!input.dependencyReady) {
    blockers.push({ code: 'DEPENDENCY_NOT_READY', message: '应用依赖尚未就绪' });
  }
  if (!input.runtimeSecretsReady) {
    blockers.push({ code: 'RUNTIME_CONFIG_MISSING', message: '运行配置或密钥尚未就绪' });
  }
  if (input.plannedRuntimePort == null) {
    blockers.push({ code: 'PORT_ALLOCATION_FAILED', message: '动态端口池已耗尽' });
  }
  const canDeploy =
    input.serverOk &&
    input.artifactReady &&
    input.deployableImageReady !== false &&
    input.dependencyReady &&
    input.runtimeSecretsReady &&
    input.queueReady &&
    input.lockReady &&
    input.plannedRuntimePort != null &&
    blockers.length === 0;
  return { canDeploy, blockers };
}

/**
 * Managed mode must never silently fall back to local Docker.
 */
export function assertManagedServerBound(input: {
  targetType?: string | null;
  serverInstanceId?: string | null;
}): void {
  const target = String(input.targetType || '').toUpperCase();
  if (target !== 'MANAGED_SERVER') return;
  if (!input.serverInstanceId?.trim()) {
    throw Object.assign(new Error('MANAGED_SERVER_NOT_BOUND'), {
      code: 'MANAGED_SERVER_NOT_BOUND',
    });
  }
}

export function assertManagedRuntimePort(port: number): void {
  if (
    !Number.isInteger(port) ||
    port < DYNAMIC_PORT_RANGE_START ||
    port > DYNAMIC_PORT_RANGE_END
  ) {
    throw Object.assign(new Error('MANAGED_RUNTIME_PORT_OUT_OF_RANGE'), {
      code: 'MANAGED_RUNTIME_PORT_OUT_OF_RANGE',
    });
  }
}

export function resolveDeploymentTargetType(input: {
  explicit?: string | null;
  hostingMode?: string | null;
  serverInstanceId?: string | null;
}): DeploymentTargetType {
  const explicit = String(input.explicit || '').toUpperCase();
  if (explicit === 'MANAGED_SERVER' || explicit === 'LOCAL') {
    return explicit;
  }
  // launchos / my-server with a bound server → managed remote path
  if (input.serverInstanceId?.trim()) return 'MANAGED_SERVER';
  if (input.hostingMode === 'launchos' || input.hostingMode === 'my-server') {
    return 'MANAGED_SERVER';
  }
  return 'LOCAL';
}

export type StartCommandResolution = {
  availableScripts: string[];
  unitStartCommand: string | null;
  analyzerStartCommand: string | null;
  artifactStartCommand: string | null;
  resolvedStartCommand: string | null;
  artifactRunnable: boolean;
  reasonCode:
    | 'OK'
    | 'USER_PROJECT_START_COMMAND_MISSING'
    | 'LAUNCHOS_ARTIFACT_PACKAGING_INCOMPLETE'
    | 'ARTIFACT_NOT_RUNNABLE';
};

/**
 * Never blindly fall back to `npm start` when package.json has no start script.
 */
export function resolveRunnableStartCommand(input: {
  unitStartCommand?: string | null;
  analyzerStartCommand?: string | null;
  artifactStartCommand?: string | null;
  packageScripts?: Record<string, string> | null;
  hasPackageJson?: boolean;
  hasEntrypointFile?: boolean;
}): StartCommandResolution {
  const scripts = Object.keys(input.packageScripts || {});
  const unit = input.unitStartCommand?.trim() || null;
  const analyzer = input.analyzerStartCommand?.trim() || null;
  const artifact = input.artifactStartCommand?.trim() || null;

  const candidates = [unit, analyzer, artifact].filter(Boolean) as string[];
  for (const cmd of candidates) {
    if (isStartCommandSatisfiable(cmd, scripts)) {
      return {
        availableScripts: scripts,
        unitStartCommand: unit,
        analyzerStartCommand: analyzer,
        artifactStartCommand: artifact,
        resolvedStartCommand: cmd,
        artifactRunnable: true,
        reasonCode: 'OK',
      };
    }
  }

  // Prefer explicit package scripts over blind npm start
  if (scripts.includes('start')) {
    return {
      availableScripts: scripts,
      unitStartCommand: unit,
      analyzerStartCommand: analyzer,
      artifactStartCommand: artifact,
      resolvedStartCommand: 'npm start',
      artifactRunnable: true,
      reasonCode: 'OK',
    };
  }
  if (scripts.includes('start:prod')) {
    return {
      availableScripts: scripts,
      unitStartCommand: unit,
      analyzerStartCommand: analyzer,
      artifactStartCommand: artifact,
      resolvedStartCommand: 'npm run start:prod',
      artifactRunnable: true,
      reasonCode: 'OK',
    };
  }

  if (input.hasEntrypointFile && !input.hasPackageJson) {
    return {
      availableScripts: scripts,
      unitStartCommand: unit,
      analyzerStartCommand: analyzer,
      artifactStartCommand: artifact,
      resolvedStartCommand: null,
      artifactRunnable: false,
      reasonCode: 'LAUNCHOS_ARTIFACT_PACKAGING_INCOMPLETE',
    };
  }

  return {
    availableScripts: scripts,
    unitStartCommand: unit,
    analyzerStartCommand: analyzer,
    artifactStartCommand: artifact,
    resolvedStartCommand: null,
    artifactRunnable: false,
    reasonCode: scripts.length
      ? 'USER_PROJECT_START_COMMAND_MISSING'
      : 'ARTIFACT_NOT_RUNNABLE',
  };
}

function isStartCommandSatisfiable(cmd: string, scripts: string[]): boolean {
  const normalized = cmd.trim();
  if (!normalized) return false;
  // node/direct binary entrypoints are OK without package scripts
  if (/^(node|tsx|ts-node)\b/.test(normalized)) return true;
  if (normalized === 'npm start' || normalized === 'yarn start' || normalized === 'pnpm start') {
    return scripts.includes('start');
  }
  const runMatch = /^npm run\s+(\S+)/.exec(normalized);
  if (runMatch) return scripts.includes(runMatch[1]!);
  return true;
}

/**
 * When deployment fails and the new ServiceInstance's container exited / health failed,
 * it must not remain RUNNING.
 */
export function resolveUnitHealthCheck(input: {
  unitType?: string | null;
  explicitHealthPath?: string | null;
}): { healthPath: string; healthPathSource: 'EXPLICIT' | 'FRAMEWORK_DEFAULT' | 'ROOT_FALLBACK' } {
  const explicit = input.explicitHealthPath?.trim();
  if (explicit) {
    return {
      healthPath: explicit.startsWith('/') ? explicit : `/${explicit}`,
      healthPathSource: 'EXPLICIT',
    };
  }
  const type = String(input.unitType || '').toUpperCase();
  if (type === 'API') {
    return { healthPath: '/health', healthPathSource: 'FRAMEWORK_DEFAULT' };
  }
  // Static / SSR web units rarely expose /health — use root without mutating user code.
  return { healthPath: '/', healthPathSource: 'ROOT_FALLBACK' };
}

/**
 * Keys that must never be injected into WEB / static frontend containers.
 * Backend data-plane credentials stay API-only.
 */
export const WEB_FORBIDDEN_RUNTIME_SECRET_KEYS = [
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
] as const;

/**
 * Server-side Web runtime secrets that MUST reach the container
 * (e.g. NextAuth / Auth.js). These are never browser-exposed.
 * Do NOT confuse with NEXT_PUBLIC_* / VITE_* / PUBLIC_*.
 */
export const WEB_SERVER_SIDE_SECRET_ALLOWLIST = [
  'AUTH_SECRET',
  'NEXTAUTH_SECRET',
  'SESSION_SECRET',
] as const;

export function isWebServerSideSecretKey(key: string): boolean {
  return (WEB_SERVER_SIDE_SECRET_ALLOWLIST as readonly string[]).includes(
    String(key || '').trim().toUpperCase(),
  );
}

export function isBrowserPublicEnvKey(key: string): boolean {
  const upper = String(key || '').trim().toUpperCase();
  return (
    upper.startsWith('NEXT_PUBLIC_') ||
    upper.startsWith('VITE_') ||
    upper.startsWith('PUBLIC_')
  );
}

/**
 * Verify required keys are present in a container env map (keys only — never values).
 */
export function verifyRuntimeConfigPresence(input: {
  requiredKeys: string[];
  presentKeys: string[];
}): {
  requiredConfigCount: number;
  injectedConfigCount: number;
  missingAtRuntime: string[];
  ok: boolean;
} {
  const present = new Set(input.presentKeys.map((k) => String(k || '').trim()).filter(Boolean));
  const required = [...new Set(input.requiredKeys.map((k) => String(k || '').trim()).filter(Boolean))];
  const missingAtRuntime = required.filter((key) => !present.has(key));
  return {
    requiredConfigCount: required.length,
    injectedConfigCount: required.length - missingAtRuntime.length,
    missingAtRuntime,
    ok: missingAtRuntime.length === 0,
  };
}

export function filterRuntimeEnvForUnitType(
  unitType: string | null | undefined,
  env: Record<string, string>,
): {
  env: Record<string, string>;
  strippedKeys: string[];
  allowedRuntimeKeys: string[];
  blockedBackendSecretKeys: string[];
  webSecretIsolation: boolean;
} {
  const type = String(unitType || '').toUpperCase();
  if (type !== 'WEB' && type !== 'STATIC') {
    const keys = Object.keys(env).sort();
    return {
      env: { ...env },
      strippedKeys: [],
      allowedRuntimeKeys: keys,
      blockedBackendSecretKeys: [],
      webSecretIsolation: true,
    };
  }
  const strippedKeys: string[] = [];
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    // Never put secrets into browser-public env names.
    if (isBrowserPublicEnvKey(key) && /SECRET|PASSWORD|PRIVATE_KEY|TOKEN|DATABASE_URL|REDIS_URL/i.test(upper)) {
      strippedKeys.push(key);
      continue;
    }
    if (isWebServerSideSecretKey(key)) {
      next[key] = value;
      continue;
    }
    if (
      (WEB_FORBIDDEN_RUNTIME_SECRET_KEYS as readonly string[]).includes(key) ||
      /_(PASSWORD|PRIVATE_KEY)$/i.test(key) ||
      (/_SECRET$/i.test(key) && !isWebServerSideSecretKey(key)) ||
      key === 'DATABASE_URL' ||
      key === 'REDIS_URL'
    ) {
      strippedKeys.push(key);
      continue;
    }
    next[key] = value;
  }
  const allowedRuntimeKeys = Object.keys(next).sort();
  return {
    env: next,
    strippedKeys,
    allowedRuntimeKeys,
    blockedBackendSecretKeys: [...strippedKeys].sort(),
    webSecretIsolation: true,
  };
}

/**
 * When deployment fails and the new ServiceInstance's container exited / health failed,
 * it must not remain RUNNING.
 */
export function resolveFailedServiceInstanceStatus(input: {
  deploymentFailed: boolean;
  containerExited: boolean;
  healthFailed: boolean;
  currentStatus?: string | null;
}): 'FAILED' | 'STOPPED' | null {
  if (!input.deploymentFailed) return null;
  if (input.containerExited || input.healthFailed) return 'FAILED';
  if (String(input.currentStatus || '').toUpperCase() === 'RUNNING') return 'FAILED';
  return null;
}
