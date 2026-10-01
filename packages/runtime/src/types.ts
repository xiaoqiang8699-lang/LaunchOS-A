export type RuntimeMode = 'mock' | 'docker';

export type RuntimeStatus = {
  containerId: string;
  running: boolean;
  status: string;
  port: number | null;
  imageTag?: string;
  exitCode?: number | null;
};

export type CreateRuntimeOptions = {
  mode?: RuntimeMode;
  artifactTar?: string;
  containerPort?: number;
  contextPath?: string;
  framework?: string;
  packageManager?: string | null;
  startCommand?: string | null;
  imageTag?: string;
  /** Runtime env injected into container (local). Never logged. */
  env?: Record<string, string>;
  /** Build-time env for docker build (public only). */
  buildEnv?: Record<string, string>;
};

export type CreateRuntimeResult = {
  containerId: string;
  mode: RuntimeMode;
  imageTag?: string;
  imageId?: string;
};

export type HttpProbeResult = {
  url: string;
  status: number;
  body: string;
  duration: number;
};

export type RuntimeProviderKind = 'local' | 'remote';

export type RuntimeProvider = {
  readonly kind: RuntimeProviderKind;
  createRuntime(options: CreateRuntimeOptions): Promise<CreateRuntimeResult>;
  startRuntime(containerId: string): Promise<RuntimeStatus>;
  stopRuntime(containerId: string): Promise<RuntimeStatus>;
  restartRuntime(containerId: string): Promise<RuntimeStatus>;
  getStatus(containerId: string): Promise<RuntimeStatus>;
  destroyRuntime(containerId: string): Promise<void>;
  getLogs(containerId: string, tail?: number): Promise<string>;
  checkHttp(url: string, timeoutMs?: number): Promise<HttpProbeResult>;
};

export type RemoteDockerProbe = {
  connected: boolean;
  osVersion: string;
  dockerVersion: string | null;
  dockerStatus: 'READY' | 'MISSING' | 'ERROR';
  stage: 'ssh' | 'runtime' | 'ready';
  canDeploy: boolean;
  summary: string;
  checks: string[];
  technicalDetail?: string;
};

export type RemoteUploadPhase = 'preparing' | 'uploading' | 'extracting' | 'completed';

export type RemoteUploadProgress = {
  phase: RemoteUploadPhase;
  message: string;
};

export type RemoteDockerExecResult = {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type RemoteRuntimeConnection = {
  host: string;
  port?: number;
  username: string;
  password: string;
  readyTimeoutMs?: number;
};

export type RemoteBuildImageOptions = {
  contextPath: string;
  imageTag: string;
  dockerfile?: string;
  /** Public / build-time env only. Never pass secrets here. */
  buildArgs?: Record<string, string>;
};

export type RemoteRunContainerOptions = {
  imageTag: string;
  name: string;
  /** Container internal listen port (e.g. 3000). Never used as hostPort. */
  internalPort: number;
  /** Pre-allocated unique host port. Required for safe concurrent deploys. */
  hostPort?: number;
  /** Host ports already reserved (DB + known) — skipped when auto-picking. */
  reservedHostPorts?: number[];
  /** Bind host address. Prefer loopback for same-host gateway. */
  publishHost?: '127.0.0.1' | '0.0.0.0';
  /** Non-secret ownership labels for reconcile/cleanup. */
  labels?: Record<string, string>;
  /** Runtime env (may include secrets). Transferred via temporary --env-file. */
  env?: Record<string, string>;
  /**
   * Step 27.2 — never pull from public registries on managed ECS.
   * Default 'never' for managed image-archive deploys.
   */
  pullPolicy?: 'never' | 'missing' | 'always';
};

export type RemoteLoadImageOptions = {
  remoteArchivePath: string;
  /** Expected image reference after load (for verification). */
  expectedImageTag?: string;
};

export type RemoteLoadImageResult = {
  loadedImageRef: string;
  imageId?: string;
};

export type RemoteUploadImageArchiveOptions = {
  localArchivePath: string;
  remoteDir: string;
  onProgress?: (progress: RemoteUploadProgress) => void | Promise<void>;
};

export type RemoteRunContainerResult = {
  containerId: string;
  imageTag: string;
  imageId?: string;
  externalPort: number;
  internalPort: number;
};
