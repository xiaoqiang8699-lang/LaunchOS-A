export type PublicUser = {
  id: string;
  email: string;
  name: string;
  hasCompletedOnboarding: boolean;
  onboardingStatus: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';
  isInternal: boolean;
  platformRole: 'USER' | 'PLATFORM_ADMIN';
  isFirstTimeUser: boolean;
  createdAt: string;
  updatedAt: string;
};

export type PublicWorkspace = {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceSummary = PublicWorkspace & {
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
};

export type ProjectType = 'WEB' | 'WECHAT_MINIPROGRAM' | 'IOS' | 'ANDROID';

export type ApplicationPurpose = 'WEBSITE' | 'APP_WEBSITE' | 'API' | 'ADMIN' | 'OTHER';

export type SourceType = 'GITHUB' | 'GITLAB' | 'UPLOAD';

export type SourceRepository = {
  id: string;
  projectId: string;
  type: SourceType;
  url: string;
  branch: string;
  connectionId?: string | null;
  providerRepositoryId?: string | null;
  fullName?: string | null;
  isPrivate?: boolean;
  authStatus?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProjectSummary = {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  description: string | null;
  sourceType: string;
  sourceUrl: string | null;
  projectType: ProjectType;
  applicationPurpose?: ApplicationPurpose;
  status: string;
  framework: string | null;
  repositoryUrl: string | null;
  defaultBranch: string | null;
  isDemo?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ProjectEnvironment = {
  id: string;
  projectId: string;
  name: string;
  type: string;
  variables: Record<string, string>;
  createdAt: string;
};

export type DeploymentStatus =
  | 'CREATED'
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCESS'
  | 'FAILED'
  | 'CANCELLED';

export type DeploymentStepStatus = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'SKIPPED';

export type DeploymentEnvironment = {
  id: string;
  name: string;
  type: string;
};

export type DeploymentSummary = {
  id: string;
  projectId: string;
  environmentId: string;
  deployableUnitId?: string | null;
  status: DeploymentStatus;
  version: string | null;
  releaseLabel?: string | null;
  sourceRevision: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
  failureCode?: string | null;
  retryCount: number;
  maxRetry: number;
  createdAt: string;
  updatedAt: string;
  environment: DeploymentEnvironment;
  deployableUnit?: {
    id: string;
    name: string;
    type: string;
    framework?: string | null;
  } | null;
};

export type DeploymentStep = {
  id: string;
  stepKey: string;
  name: string;
  status: DeploymentStepStatus;
  order: number;
  attempt: number;
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
  command: string | null;
  exitCode: number | null;
  duration: number | null;
  createdAt: string;
  updatedAt: string;
};

export type DeploymentLog = {
  id: string;
  stepId: string | null;
  level: string;
  message: string;
  createdAt: string;
};

export type DiagnosisCategory =
  | 'BUILD_ERROR'
  | 'DEPENDENCY_ERROR'
  | 'CONFIG_ERROR'
  | 'RUNTIME_ERROR'
  | 'PORT_ERROR'
  | 'DATABASE_ERROR'
  | 'UNKNOWN';

export type DiagnosisSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type DeploymentDiagnosis = {
  id: string;
  deploymentId: string;
  category: DiagnosisCategory;
  severity: DiagnosisSeverity;
  title: string;
  description: string;
  solution: string;
  fixPrompt: string;
  createdAt: string;
  updatedAt: string;
};

export type RemoteDeploymentStatus =
  | 'PENDING'
  | 'CONNECTING'
  | 'DEPLOYING'
  | 'RUNNING'
  | 'FAILED';

export type RemoteDeployment = {
  id: string;
  deploymentId: string;
  cloudResourceId: string;
  status: RemoteDeploymentStatus;
  logs: string;
  startedAt: string | null;
  finishedAt: string | null;
  publicIp: string | null;
  publicUrl: string | null;
};

export type RemoteStatusResponse = {
  remoteDeployment: RemoteDeployment | null;
  publicUrl: string | null;
};

export type ArtifactType = 'BUILD_OUTPUT' | 'DOCKER_IMAGE' | 'PACKAGE';

export type ArtifactStatus = 'CREATED' | 'UPLOADING' | 'READY' | 'FAILED';

export type Artifact = {
  id: string;
  deploymentId: string;
  type: ArtifactType;
  storagePath: string;
  size: number;
  status: ArtifactStatus;
  createdAt: string;
};

export type ServiceStatus = 'CREATING' | 'RUNNING' | 'STOPPED' | 'FAILED';

export type ServiceInstance = {
  id: string;
  projectId: string;
  environmentId: string;
  artifactId: string;
  runtime: string;
  status: ServiceStatus;
  containerId: string | null;
  port: number | null;
  createdAt: string;
  updatedAt: string;
};

export type DeploymentRuntimeInfo = {
  mode: 'local' | 'remote';
  serverName: string | null;
  serverHost: string | null;
  containerStatus: string | null;
  containerId: string | null;
  externalPort: number | null;
  internalPort: number | null;
};

export type DeploymentDetail = DeploymentSummary & {
  serverInstanceId?: string | null;
  serverInstance?: {
    id: string;
    name: string;
    host: string;
    port: number;
    status: string;
    dockerStatus: string;
  } | null;
  runtime?: DeploymentRuntimeInfo;
  steps: DeploymentStep[];
  logs: DeploymentLog[];
};

export type ProjectDeploymentItem = {
  id: string;
  status: DeploymentStatus;
  version: string | null;
  environmentId: string;
  createdAt: string;
};

export type ProjectDetail = ProjectSummary & {
  environments: ProjectEnvironment[];
  deployments: ProjectDeploymentItem[];
  sources: SourceRepository[];
};

export type AppRunningStatus = 'READY' | 'DEPLOYING' | 'RUNNING' | 'WARNING' | 'STOPPED' | 'FAILED';
export type ApplicationStatus = AppRunningStatus;
export type HealthStatus = 'HEALTHY' | 'UNHEALTHY' | 'UNKNOWN';

export type HostingMode = 'launchos' | 'my-server';

export type PendingCodeUpdate = {
  id: string;
  commitSha: string;
  commitMessage: string;
  createdAt: string;
};

export type DeployableUnitCard = DeployableUnitPublic & {
  displayName?: string;
  typeLabel?: string;
  productStatus?:
    | 'PENDING_LAUNCH'
    | 'DEPLOYING'
    | 'RUNNING'
    | 'WARNING'
    | 'STOPPED'
    | 'FAILED'
    | 'UNSUPPORTED';
  productStatusLabel?: string;
  visitUrl?: string | null;
  visitUrlReady?: boolean;
  visitUrlPreparing?: boolean;
  currentVersion?: string | null;
  currentVersionId?: string | null;
  healthStatus?: HealthStatus;
  lastHealthCheckAt?: string | null;
  healthLabel?: string | null;
  codeUpdatePending?: boolean;
  pendingUpdate?: PendingCodeUpdate | null;
  sourceLabel?: string | null;
  sourceRepositoryId?: string | null;
  canManage?: boolean;
  latestDeploymentId?: string | null;
  latestDeploymentStatus?: string | null;
  serviceStatus?: string | null;
  runtimeConfig?: {
    total: number;
    completed: number;
    missingRequired: number;
    missingLabels: string[];
    pendingApply?: boolean;
    configRevision?: number;
  };
};

export type AppCompositionSummary = {
  total: number;
  launchable: number;
  mobile: number;
  unsupported: number;
};

export type AppSummary = {
  id: string;
  name: string;
  slug: string;
  applicationPurpose?: ApplicationPurpose;
  applicationStatus: ApplicationStatus;
  aggregateStatus?: string;
  aggregateLabel?: string;
  visitUrl: string | null;
  localVisitUrl?: string | null;
  visitUrlReady?: boolean;
  visitUrlPreparing?: boolean;
  visitEntries?: Array<{
    unitId: string;
    name: string;
    visitUrl: string | null;
    visitUrlReady?: boolean;
  }>;
  systemDomain?: string | null;
  dnsStatus?: string | null;
  gatewayDomainStatus?: string | null;
  hostingMode?: HostingMode;
  hostingLabel?: string;
  serverStatus: CloudResourceStatus | 'NONE';
  lastDeployedAt: string | null;
  latestDeploymentId: string | null;
  isDemo?: boolean;
  canManage?: boolean;
  healthStatus?: HealthStatus;
  lastHealthCheckAt?: string | null;
  responseTimeMs?: number | null;
  healthMessage?: string | null;
  pendingUpdate?: PendingCodeUpdate | null;
  composition?: AppCompositionSummary;
};

export type ApplicationVersionStatus = 'DEPLOYING' | 'ACTIVE' | 'FAILED' | 'ROLLED_BACK';

export type ApplicationVersion = {
  id: string;
  projectId: string;
  deploymentId: string;
  deployableUnitId?: string | null;
  version: string;
  commitSha: string;
  commitMessage: string;
  status: ApplicationVersionStatus;
  createdAt: string;
  isCurrent?: boolean;
  rollbackable?: boolean;
  restoredFrom?: string | null;
  unitName?: string | null;
  unitType?: string | null;
};

export type AppIssue = {
  id: string;
  title: string;
  severity: DiagnosisSeverity;
  discoveredAt: string;
  cause: string;
  suggestion: string;
  assistantPrompt: string;
  deployableUnitId?: string | null;
  unitName?: string | null;
  unitType?: string | null;
};

export type AppSettings = {
  autoDeployEnabled: boolean;
  branch: string;
  pendingUpdate: PendingCodeUpdate | null;
};

export type ServiceHealthCheck = {
  id: string;
  status: HealthStatus;
  responseTimeMs: number | null;
  statusCode: number | null;
  message: string | null;
  checkedAt: string;
};

export type AppHealth = {
  status: HealthStatus;
  lastCheckedAt: string | null;
  responseTimeMs: number | null;
  message: string;
  history: ServiceHealthCheck[];
  // Beta M3 extended fields (optional for backward compat)
  projectId?: string;
  environmentId?: string | null;
  deploymentId?: string | null;
  serviceInstanceId?: string | null;
  version?: string | null;
  restoredFrom?: string | null;
  visitUrl?: string | null;
  overallStatus?: ProductRuntimeStatus;
  overallLabel?: string;
  runtimeStatus?: ProductRuntimeStatus;
  runtimeHealth?: HealthStatus;
  publicStatus?: 'OK' | 'FAIL' | 'UNKNOWN' | 'N/A';
  httpStatus?: number | null;
  gatewayStatus?: string | null;
  dnsStatus?: string | null;
  lastHealthCheckAt?: string | null;
  lastHealthCheckLabel?: string | null;
  lastPublicCheckAt?: string | null;
  lastPublicCheckLabel?: string | null;
  lastHealthyAt?: string | null;
  publicLatencyMs?: number | null;
  stale?: boolean;
  startedAt?: string | null;
  uptimeLabel?: string | null;
  startupSummary?: {
    result: 'SUCCESS' | 'FAILED' | 'UNKNOWN';
    label: string;
    at: string | null;
    errorSummary: string | null;
  };
  recentError?: string | null;
  failureCategory?: 'USER_CODE' | 'USER_CONFIG' | 'PLATFORM' | 'INFRASTRUCTURE' | 'TRANSIENT' | null;
  recommendedAction?: string | null;
  fixPrompt?: string | null;
  anomalyLayer?: string | null;
};

export type ProductRuntimeStatus =
  | 'HEALTHY'
  | 'STARTING'
  | 'DEGRADED'
  | 'UNHEALTHY'
  | 'STOPPED'
  | 'UNKNOWN'
  | 'DEPLOYING'
  | 'RESTORING'
  | 'STATUS_PENDING';

export type RuntimeLogsResponse = {
  logs: string;
  lineCount: number;
  limit: number;
  truncated: boolean;
  serviceInstanceId: string;
  checkedAt: string;
};

export type ExperienceStepStatus = 'SUCCESS' | 'RUNNING' | 'FAILED' | 'WAITING';

export type ExperienceStep = {
  key: string;
  name: string;
  status: ExperienceStepStatus;
  detail?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  failureReason?: string | null;
};

export type DeploymentExperienceProgress = {
  currentAction: string | null;
  currentStepKey: string | null;
  currentStepStartedAt: string | null;
  lastActivityAt: string | null;
  unitLabel: string;
  unitType: string | null;
};

export type DeploymentSuccessInfo = {
  visitUrl: string | null;
  localVisitUrl?: string | null;
  visitUrlReady?: boolean;
  visitUrlPreparing?: boolean;
  accessEntryPending?: boolean;
  accessEntryMessage?: string | null;
  systemDomain?: string | null;
  dnsStatus?: string | null;
  gatewayDomainStatus?: string | null;
  runtimeUrl?: string | null;
  runtime: string;
  cloudProvider: string;
  serverIp: string | null;
  serverName?: string | null;
  serverHost?: string | null;
  accessPort?: number | null;
  deployMode?: 'local' | 'remote';
  hostingMode?: HostingMode;
  hostingLabel?: string;
  containerStatus?: string | null;
};

export type DeploymentUserError = {
  cause: string;
  suggestion: string;
  assistantPrompt: string;
};

export type DeploymentExperience = {
  deployment: {
    id: string;
    projectId: string;
    projectName: string;
    status: DeploymentStatus;
    version: string | null;
    releaseLabel?: string | null;
    errorMessage: string | null;
    failureCode?: string | null;
    currentStage?: string | null;
    currentStageLabel?: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    hostingMode?: HostingMode;
    hostingLabel?: string;
    uploadStatus?: RemoteUploadStatus;
    uploadError?: string | null;
    deployableUnitId?: string | null;
    unitLabel?: string | null;
    retryCount?: number | null;
    maxRetry?: number | null;
    isRollback?: boolean;
    restoredFrom?: string | null;
  };
  steps: ExperienceStep[];
  progress?: DeploymentExperienceProgress;
  success: DeploymentSuccessInfo;
  upload?: {
    status: RemoteUploadStatus;
    error: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    label: string;
  };
  userError: (DeploymentUserError & {
    failureCode?: string | null;
    failedStageLabel?: string | null;
  }) | null;
  queue?: {
    waitingToStart: boolean;
    queuedAt: string | null;
    workerHint: string | null;
    bullmqJobId?: string | null;
  };
};

export type RegisterResponse = {
  user: PublicUser;
  workspace: PublicWorkspace;
};

export type LoginResponse = {
  accessToken: string;
  user: PublicUser;
};

export type CloudResourceType = 'SERVER' | 'DATABASE' | 'STORAGE' | 'NETWORK';

export type CloudResourceStatus = 'CREATING' | 'RUNNING' | 'STOPPED' | 'FAILED';

export type CloudProviderSummary = {
  id: string;
  name: string;
  type: string;
};

export type ProviderAccount = {
  id: string;
  workspaceId: string;
  providerId: string;
  label: string | null;
  region: string | null;
  status: string;
  hasCredential: boolean;
  accessKeyMasked: string | null;
  secretMasked: string | null;
  createdAt: string;
  updatedAt: string;
  provider: CloudProviderSummary;
};

export type SystemDnsProviderConfig = {
  rootDomain: string;
  dnsProvider: string | null;
  dnsProviderAccountId: string | null;
  renewalMode: string;
  dnsProviderVerifiedAt: string | null;
  dnsProviderTxtTestAt: string | null;
  canEnableAutomatic: boolean;
  providerAccount: {
    id: string;
    label: string | null;
    status: string;
    providerType: string;
    accessKeyMasked: string | null;
    secretMasked: string;
  } | null;
};

export type CloudResource = {
  id: string;
  workspaceId: string;
  projectId: string | null;
  providerId: string;
  type: CloudResourceType;
  externalId: string;
  providerResourceId: string | null;
  publicIp: string | null;
  region: string | null;
  instanceType: string | null;
  status: CloudResourceStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  provider: CloudProviderSummary;
};

export type ServerInstance = {
  id: string;
  workspaceId: string;
  name: string;
  host: string;
  port: number;
  username: string;
  provider: string;
  status: string;
  dockerStatus: string;
  createdAt: string;
  updatedAt: string;
};

export type ServerConnectionTest = ServerInstance & {
  connected: boolean;
  osVersion: string;
  dockerVersion: string | null;
  diagnosis?: {
    stage: 'ssh' | 'runtime' | 'ready';
    canDeploy: boolean;
    summary: string;
    checks: string[];
    technicalDetail?: string | null;
  };
};

export type RemoteUploadStatus = 'IDLE' | 'PREPARING' | 'UPLOADING' | 'COMPLETED' | 'FAILED';

export type GitDetectResult = {
  url: string;
  owner: string | null;
  name: string;
  defaultBranch: string;
  reachable: boolean;
  autoDetected: boolean;
  message: string;
};

export type GitHubConnectionStatus = {
  configured: boolean;
  connected: boolean;
  needsReauth: boolean;
  login: string | null;
  accountType: string | null;
  repositoryCount: number | null;
  connectionId: string | null;
  status: string;
};

export type GitHubRepoOption = {
  id: string;
  fullName: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
  htmlUrl: string;
  updatedAt: string | null;
};

export type AnalysisResult = {
  runtime: string;
  buildCommand: string;
  startCommand: string;
  port: number;
  findings: string[];
  recommendedConfig: {
    runtime: string;
    buildCommand: string;
    startCommand: string;
    port: number;
  };
};

export type AiAnalysis = {
  id: string;
  projectId: string;
  result: AnalysisResult;
  model: string;
  createdAt: string;
};

export type DeploymentPlan = {
  id: string;
  projectId: string;
  runtime: string;
  buildCommand: string;
  startCommand: string;
  port: number;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type CloudPlan = {
  id: string;
  name: string;
  cpu: number;
  memory: string;
  storage: string;
  database: string;
  description: string;
  createdAt: string;
};

export type ResourceRecommendation = {
  id: string;
  projectId: string;
  planId: string;
  reason: string;
  createdAt: string;
  plan: CloudPlan;
};

export type ResourceRecommendationResponse = {
  recommendation: ResourceRecommendation;
  deploymentPlan: DeploymentPlan;
};

export type AiAnalyzeResponse = {
  analysis: AiAnalysis;
  plan: DeploymentPlan;
};

export type DeployableUnitType =
  | 'WEB'
  | 'API'
  | 'ADMIN'
  | 'IOS'
  | 'ANDROID'
  | 'MINI_PROGRAM'
  | 'MOBILE_CROSS_PLATFORM'
  | 'OTHER';

export type DeployableUnitStatus = 'DETECTED' | 'CONFIRMED' | 'IGNORED' | 'UNSUPPORTED';

export type DeployableUnitFramework =
  | 'NEXTJS'
  | 'VITE'
  | 'VUE'
  | 'NODE'
  | 'NESTJS'
  | 'IOS_NATIVE'
  | 'EXPO'
  | 'REACT_NATIVE'
  | 'WECHAT_MINIPROGRAM'
  | 'ANDROID'
  | 'UNSUPPORTED';

export type DeployableUnitPublic = {
  id: string;
  name: string;
  type: DeployableUnitType;
  rootPath: string;
  framework: DeployableUnitFramework | string | null;
  packageManager: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  outputPath: string | null;
  port: number | null;
  deployable: boolean;
  confidence: number;
  status: DeployableUnitStatus | string;
  label?: string;
  canLaunch?: boolean;
  unsupportedHint?: string | null;
  reason?: string;
};

export type CodeAnalysisResult = {
  projectType: 'WEB' | 'IOS_NATIVE' | 'UNSUPPORTED';
  framework: DeployableUnitFramework;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | null;
  installCommand: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  port: number | null;
  confidence: number;
  summary?: string;
  primaryUnitPath?: string | null;
  units?: DeployableUnitPublic[];
  candidates?: Array<{
    path: string;
    kind: 'WEB' | 'IOS_NATIVE' | 'EXPO' | 'REACT_NATIVE' | 'UNSUPPORTED';
    label: string;
    deployable: boolean;
    reason: string;
  }>;
};

export type CodeAnalysisResponse = {
  skipped: boolean;
  skipReason: 'demo' | null;
  analysis: {
    id: string;
    projectId: string;
    repositoryPath: string;
    framework: string;
    packageManager: string | null;
    buildCommand: string | null;
    startCommand: string | null;
    port: number | null;
    confidence: number;
    createdAt: string;
  } | null;
  result: CodeAnalysisResult | null;
  units?: DeployableUnitPublic[];
};

export const FRAMEWORK_LABELS: Record<DeployableUnitFramework, string> = {
  NEXTJS: 'Next.js',
  VITE: 'Vite',
  VUE: 'Vue',
  NODE: 'Node.js',
  NESTJS: 'NestJS',
  IOS_NATIVE: 'iOS APP',
  EXPO: 'Expo',
  REACT_NATIVE: 'React Native',
  WECHAT_MINIPROGRAM: '微信小程序',
  ANDROID: 'Android',
  UNSUPPORTED: '暂不支持该类型',
};

export const DEPLOYABLE_UNIT_TYPE_LABELS: Record<DeployableUnitType, string> = {
  WEB: '网站',
  API: 'API 服务',
  ADMIN: '管理后台',
  IOS: 'iOS APP',
  ANDROID: 'Android APP',
  MINI_PROGRAM: '微信小程序',
  MOBILE_CROSS_PLATFORM: '移动 APP',
  OTHER: '其他内容',
};

function isMobileAnalysisFramework(framework: string | null | undefined): boolean {
  return framework === 'IOS_NATIVE' || framework === 'EXPO' || framework === 'REACT_NATIVE';
}

export function isWebLaunchableFramework(framework: string | null | undefined): boolean {
  return (
    framework === 'NEXTJS' ||
    framework === 'VITE' ||
    framework === 'VUE' ||
    framework === 'NODE' ||
    framework === 'NESTJS'
  );
}

export function isLaunchableUnit(unit: Pick<DeployableUnitPublic, 'deployable' | 'framework'>): boolean {
  return Boolean(unit.deployable && isWebLaunchableFramework(unit.framework));
}

export { isMobileAnalysisFramework };

export type DomainType = 'CUSTOM' | 'SUBDOMAIN';

export type DomainStatus = 'PENDING' | 'ACTIVE' | 'FAILED';

export type CertificateStatus = 'REQUESTING' | 'ACTIVE' | 'EXPIRED' | 'FAILED';

export type DomainCertificate = {
  id: string;
  domainId: string;
  issuer: string;
  expiresAt: string | null;
  status: CertificateStatus;
  createdAt: string;
  updatedAt: string;
};

export type DomainRecord = {
  id: string;
  projectId: string;
  serviceInstanceId: string;
  domain: string;
  type: DomainType;
  provider: string;
  status: DomainStatus;
  createdAt: string;
  updatedAt: string;
  certificates: DomainCertificate[];
};
