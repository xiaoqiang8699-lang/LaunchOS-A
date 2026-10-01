/**
 * Step 30 Phase 1 — user-facing launch stages (no Step 25–29 numbering).
 */

export const LAUNCH_STAGES = [
  'ANALYZE',
  'DEPENDENCIES',
  'INFRASTRUCTURE',
  'BUILD',
  'DEPLOY',
  'PUBLIC_ENTRY',
  'VERIFY',
] as const;

export type LaunchStageId = (typeof LAUNCH_STAGES)[number];

export const LAUNCH_STAGE_LABELS_ZH: Record<LaunchStageId, string> = {
  ANALYZE: '分析应用',
  DEPENDENCIES: '准备依赖',
  INFRASTRUCTURE: '准备服务器',
  BUILD: '构建应用',
  DEPLOY: '部署应用',
  PUBLIC_ENTRY: '配置访问入口',
  VERIFY: '上线检查',
};

export const LAUNCH_STAGE_PROGRESS_LABELS_ZH: Record<LaunchStageId, string> = {
  ANALYZE: '正在分析应用',
  DEPENDENCIES: '正在准备依赖',
  INFRASTRUCTURE: '正在准备服务器',
  BUILD: '正在构建应用',
  DEPLOY: '正在部署应用',
  PUBLIC_ENTRY: '正在配置访问入口',
  VERIFY: '正在进行上线检查',
};

/** Progress weights sum to 100. */
export const LAUNCH_STAGE_WEIGHTS: Record<LaunchStageId, number> = {
  ANALYZE: 10,
  DEPENDENCIES: 15,
  INFRASTRUCTURE: 20,
  BUILD: 15,
  DEPLOY: 20,
  PUBLIC_ENTRY: 15,
  VERIFY: 5,
};

export type LaunchStageUiStatus = 'WAITING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'SKIPPED';
