/** Centralized onboarding risk thresholds — do not hardcode elsewhere. */
export const ONBOARDING_THRESHOLDS = {
  hoursAfterProjectWithoutSource: 24,
  hoursAfterSourceWithoutDeploy: 24,
  hoursAfterFailedDeployWithoutRetry: 24,
  hoursPreflightHighUnresolved: 12,
  consecutiveFailuresForBlocked: 2,
  hoursInactiveForDormant: 72,
} as const;

export const ACTIVATION_STAGE_BASE_SCORE: Record<string, number> = {
  REGISTERED: 10,
  WORKSPACE_READY: 15,
  PROJECT_CREATED: 30,
  SOURCE_CONNECTED: 45,
  ANALYSIS_COMPLETED: 55,
  CONFIG_COMPLETED: 65,
  PREFLIGHT_PASSED: 75,
  FIRST_DEPLOY_STARTED: 80,
  FIRST_DEPLOY_SUCCEEDED: 90,
  PUBLIC_ENTRY_READY: 100,
  ACTIVATED: 100,
};

export const ACTIVATION_STAGES = [
  'REGISTERED',
  'WORKSPACE_READY',
  'PROJECT_CREATED',
  'SOURCE_CONNECTED',
  'ANALYSIS_COMPLETED',
  'CONFIG_COMPLETED',
  'PREFLIGHT_PASSED',
  'FIRST_DEPLOY_STARTED',
  'FIRST_DEPLOY_SUCCEEDED',
  'PUBLIC_ENTRY_READY',
  'ACTIVATED',
] as const;

export type ActivationStage = (typeof ACTIVATION_STAGES)[number];

export function stageRank(stage: string): number {
  const i = ACTIVATION_STAGES.indexOf(stage as ActivationStage);
  return i < 0 ? 0 : i;
}

export function maxStage(a: string, b: string): ActivationStage {
  return stageRank(a) >= stageRank(b) ? (a as ActivationStage) : (b as ActivationStage);
}

export const STAGE_LABELS: Record<string, string> = {
  REGISTERED: '已注册',
  WORKSPACE_READY: '工作区就绪',
  PROJECT_CREATED: '已创建应用',
  SOURCE_CONNECTED: '已连接代码',
  ANALYSIS_COMPLETED: '已完成分析',
  CONFIG_COMPLETED: '已完成配置',
  PREFLIGHT_PASSED: '预检通过',
  FIRST_DEPLOY_STARTED: '已发起首次部署',
  FIRST_DEPLOY_SUCCEEDED: '首次部署成功',
  PUBLIC_ENTRY_READY: '公网可访问',
  ACTIVATED: '已激活',
};

export const STATUS_LABELS: Record<string, string> = {
  NOT_STARTED: '未开始',
  IN_PROGRESS: '进行中',
  BLOCKED: '已阻塞',
  AT_RISK: '激活风险',
  ACTIVATED: '已激活',
  DORMANT: '沉寂',
};

export const BLOCKER_LABELS: Record<string, string> = {
  SOURCE: '代码源未就绪',
  CONFIG: '缺少运行配置',
  PREFLIGHT: '预检未通过',
  BUILD: '构建失败',
  RUNTIME: '运行异常',
  DOMAIN: '公网入口未就绪',
  PERMISSION: '权限不足',
  QUOTA: '额度不足',
  UNKNOWN: '未知阻塞',
};
