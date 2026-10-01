import type {
  ArtifactStatus,
  ArtifactType,
  CertificateStatus,
  CloudResourceStatus,
  CloudResourceType,
  DeploymentStatus,
  DeploymentStepStatus,
  DiagnosisCategory,
  DiagnosisSeverity,
  DomainStatus,
  DomainType,
  ExperienceStepStatus,
  HealthStatus,
  ProjectType,
  RemoteDeploymentStatus,
  ServiceStatus,
  SourceType,
} from './types';

export const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  WEB: 'Web',
  WECHAT_MINIPROGRAM: '微信小程序',
  IOS: 'iOS',
  ANDROID: 'Android',
};

export const DEPLOYMENT_STATUS_LABELS: Record<DeploymentStatus, string> = {
  CREATED: '已创建',
  QUEUED: '排队中',
  RUNNING: '运行中',
  SUCCESS: '成功',
  FAILED: '失败',
  CANCELLED: '已取消',
};

export const DEPLOYMENT_STEP_STATUS_LABELS: Record<DeploymentStepStatus, string> = {
  PENDING: '等待中',
  RUNNING: '运行中',
  SUCCESS: '成功',
  FAILED: '失败',
  SKIPPED: '已跳过',
};

export const ACTIVE_DEPLOYMENT_STATUSES: DeploymentStatus[] = ['CREATED', 'QUEUED', 'RUNNING'];

export const EXPERIENCE_STEP_STATUS_LABELS: Record<ExperienceStepStatus, string> = {
  SUCCESS: '已完成',
  RUNNING: '进行中',
  FAILED: '失败',
  WAITING: '等待中',
};

export const APP_RUNNING_STATUS_LABELS: Record<
  'READY' | 'DEPLOYING' | 'RUNNING' | 'WARNING' | 'STOPPED' | 'FAILED',
  string
> = {
  READY: '待上线',
  DEPLOYING: '正在上线',
  RUNNING: '🟢 运行正常',
  WARNING: '出现异常',
  STOPPED: '已停止',
  FAILED: '上线失败',
};

export const APPLICATION_PURPOSE_LABELS: Record<
  'WEBSITE' | 'APP_WEBSITE' | 'API' | 'ADMIN' | 'OTHER',
  string
> = {
  WEBSITE: '网站',
  APP_WEBSITE: 'APP 配套服务',
  API: 'API 服务',
  ADMIN: '管理后台',
  OTHER: '其他',
};

export const APPLICATION_PURPOSE_HINTS: Record<
  'WEBSITE' | 'APP_WEBSITE' | 'API' | 'ADMIN' | 'OTHER',
  string
> = {
  WEBSITE: '面向用户访问的网站',
  APP_WEBSITE: 'APP 的官网、隐私说明、下载页或配套 Web 服务',
  API: '提供接口，不以页面为主',
  ADMIN: '内部管理页面',
  OTHER: '不属于以上类型',
};

export const REMOTE_UPLOAD_STATUS_LABELS: Record<
  'IDLE' | 'PREPARING' | 'UPLOADING' | 'COMPLETED' | 'FAILED',
  string
> = {
  IDLE: '等待上传',
  PREPARING: '准备上传',
  UPLOADING: '上传中',
  COMPLETED: '上传完成',
  FAILED: '上传失败',
};

export const APPLICATION_VERSION_STATUS_LABELS: Record<
  'DEPLOYING' | 'ACTIVE' | 'FAILED' | 'ROLLED_BACK',
  string
> = {
  DEPLOYING: '正在上线',
  ACTIVE: '当前版本',
  FAILED: '上线失败',
  ROLLED_BACK: '已回滚',
};

export const HEALTH_STATUS_LABELS: Record<HealthStatus, string> = {
  HEALTHY: '运行正常',
  UNHEALTHY: '出现异常',
  UNKNOWN: '等待检测',
};

export const HEALTH_STATUS_DOT_CLASS: Record<HealthStatus, string> = {
  HEALTHY: 'bg-emerald-500',
  UNHEALTHY: 'bg-red-500',
  UNKNOWN: 'bg-zinc-300',
};

export const SERVER_READY_LABELS: Record<string, string> = {
  READY: '可以运行应用',
  MISSING: '还不能运行应用',
  ERROR: '还不能运行应用',
  UNKNOWN: '尚未确认',
};

export const SERVER_INSTANCE_STATUS_LABELS: Record<string, string> = {
  CREATED: '已添加',
  CONNECTED: '已连接',
  READY: '已就绪',
  UNREACHABLE: '无法连接',
};

export const REMOTE_DEPLOYMENT_STATUS_LABELS: Record<RemoteDeploymentStatus, string> = {
  PENDING: '等待中',
  CONNECTING: '连接服务器',
  DEPLOYING: '部署中',
  RUNNING: '运行中',
  FAILED: '失败',
};

export const REMOTE_DEPLOY_STAGES = [
  { key: 'connect', label: '连接服务器' },
  { key: 'upload', label: '上传' },
  { key: 'deploy', label: '部署' },
  { key: 'run', label: '运行' },
] as const;

export type RemoteDeployStageKey = (typeof REMOTE_DEPLOY_STAGES)[number]['key'];

export function remoteDeployStage(
  status: RemoteDeploymentStatus | undefined,
  logs: string,
): RemoteDeployStageKey | 'idle' {
  if (!status || status === 'PENDING') {
    return 'idle';
  }
  if (status === 'RUNNING') {
    return 'run';
  }
  if (status === 'CONNECTING') {
    return 'connect';
  }
  if (logs.includes('启动 Container') || logs.includes('健康检查')) {
    return 'deploy';
  }
  if (logs.includes('上传 Artifact') || logs.includes('上传')) {
    return 'upload';
  }
  return 'connect';
}

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  GITHUB: 'GitHub',
  GITLAB: 'GitLab',
  UPLOAD: '本地上传',
};

export const ARTIFACT_TYPE_LABELS: Record<ArtifactType, string> = {
  BUILD_OUTPUT: '构建产物',
  DOCKER_IMAGE: 'Docker 镜像',
  PACKAGE: '软件包',
};

export const ARTIFACT_STATUS_LABELS: Record<ArtifactStatus, string> = {
  CREATED: '已创建',
  UPLOADING: '上传中',
  READY: '就绪',
  FAILED: '失败',
};

export const SERVICE_STATUS_LABELS: Record<ServiceStatus, string> = {
  CREATING: '创建中',
  RUNNING: '运行中',
  STOPPED: '已停止',
  FAILED: '失败',
};

export const CLOUD_RESOURCE_TYPE_LABELS: Record<CloudResourceType, string> = {
  SERVER: '服务器',
  DATABASE: '数据库',
  STORAGE: '存储',
  NETWORK: '网络',
};

export const CLOUD_RESOURCE_STATUS_LABELS: Record<CloudResourceStatus, string> = {
  CREATING: '创建中',
  RUNNING: '运行中',
  STOPPED: '已停止',
  FAILED: '失败',
};

export const SERVER_STATUS_LABELS: Record<CloudResourceStatus | 'NONE', string> = {
  ...CLOUD_RESOURCE_STATUS_LABELS,
  NONE: '未创建',
};

export const DOMAIN_TYPE_LABELS: Record<DomainType, string> = {
  CUSTOM: '自定义域名',
  SUBDOMAIN: 'LaunchOS 子域名',
};

export const DOMAIN_STATUS_LABELS: Record<DomainStatus, string> = {
  PENDING: '等待中',
  ACTIVE: '已生效',
  FAILED: '失败',
};

export const CERTIFICATE_STATUS_LABELS: Record<CertificateStatus, string> = {
  REQUESTING: '申请中',
  ACTIVE: '已生效',
  EXPIRED: '已过期',
  FAILED: '失败',
};

export const DIAGNOSIS_CATEGORY_LABELS: Record<DiagnosisCategory, string> = {
  BUILD_ERROR: '构建错误',
  DEPENDENCY_ERROR: '依赖错误',
  CONFIG_ERROR: '配置错误',
  RUNTIME_ERROR: '运行时错误',
  PORT_ERROR: '端口错误',
  DATABASE_ERROR: '数据库错误',
  UNKNOWN: '未知错误',
};

export const DIAGNOSIS_SEVERITY_LABELS: Record<DiagnosisSeverity, string> = {
  LOW: '低',
  MEDIUM: '中',
  HIGH: '高',
  CRITICAL: '严重',
};

export function formatDateTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function artifactName(storagePath: string): string {
  const parts = storagePath.split('/').filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? storagePath;
}

export function formatDuration(ms: number | null): string {
  if (ms == null) {
    return '-';
  }
  if (ms < 1000) {
    return `${ms} ms`;
  }
  return `${(ms / 1000).toFixed(1)} s`;
}

export function statusBadgeClass(status: string): string {
  switch (status) {
    case 'SUCCESS':
    case 'READY':
    case 'ACTIVE':
    case 'RUNNING':
    case 'HEALTHY':
      return 'bg-emerald-50 text-emerald-700';
    case 'FAILED':
    case 'CRITICAL':
    case 'HIGH':
    case 'WARNING':
    case 'UNHEALTHY':
      return 'bg-red-50 text-red-700';
    case 'UPLOADING':
    case 'DEPLOYING':
    case 'CONNECTING':
    case 'MEDIUM':
      return 'bg-blue-50 text-blue-700';
    case 'QUEUED':
    case 'CREATED':
    case 'CREATING':
    case 'PENDING':
    case 'WAITING':
    case 'IDLE':
    case 'REQUESTING':
      return 'bg-amber-50 text-amber-700';
    case 'STOPPED':
    case 'EXPIRED':
    case 'LOW':
      return 'bg-zinc-100 text-zinc-600';
    default:
      return 'bg-zinc-100 text-zinc-600';
  }
}
