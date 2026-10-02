/**
 * First-login guided onboarding.
 * Stage comes from Project, Source, analysis, and LaunchRun. Not a client step number.
 * Launch execution stays on the existing orchestrator.
 */
import { assertLaunchEventSafe } from './launch-orchestrator.js';
import { evaluateProductBillingGate } from './launch-product-execute.js';
import type { LaunchConfirmationPayload, LaunchConfirmationRecord } from './launch-confirmation.js';

export const ONBOARDING_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED'] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

export const ONBOARDING_STAGES = ['CONNECT', 'ANALYZE', 'PLAN', 'LAUNCH', 'SUCCESS'] as const;
export type OnboardingStage = (typeof ONBOARDING_STAGES)[number];

export const ONBOARDING_EVENTS = [
  'ONBOARDING_STARTED',
  'ONBOARDING_SOURCE_VIEWED',
  'GITHUB_CONNECT_STARTED',
  'GITHUB_CONNECT_SUCCEEDED',
  'GITHUB_CONNECT_FAILED',
  'GITHUB_REPOSITORY_SELECTED',
  'LOCAL_ZIP_UPLOAD_STARTED',
  'LOCAL_ZIP_UPLOAD_SUCCEEDED',
  'SOURCE_ZIP_SELECTED',
  'SOURCE_ZIP_REJECTED_SIZE',
  'SOURCE_ZIP_UPLOAD_STARTED',
  'SOURCE_ZIP_UPLOAD_SUCCEEDED',
  'SOURCE_ZIP_UPLOAD_FAILED',
  'SOURCE_ZIP_ANALYSIS_STARTED',
  'SOURCE_ZIP_ANALYSIS_SUCCEEDED',
  'SOURCE_ZIP_ANALYSIS_FAILED',
  'PUBLIC_REPO_SELECTED',
  'SOURCE_CONNECTED',
  'ANALYSIS_COMPLETED',
  'LAUNCH_PLAN_VIEWED',
  'LAUNCH_STARTED',
  'ONBOARDING_COMPLETED',
] as const;
export type OnboardingEventName = (typeof ONBOARDING_EVENTS)[number];

export const ONBOARDING_PROGRESS = [
  { stage: 'CONNECT', label: '连接代码' },
  { stage: 'ANALYZE', label: '智能检测' },
  { stage: 'PLAN', label: '上线方案' },
  { stage: 'SUCCESS', label: '发布成功' },
] as const;

export const ONBOARDING_LAUNCH_PHASES = [
  '分析应用',
  '准备依赖',
  '准备服务器',
  '构建应用',
  '部署应用',
  '配置访问入口',
  '上线检查',
] as const;

export const ONBOARDING_LAUNCH_ENTRY = 'EXISTING_ORCHESTRATOR' as const;

export function shouldEnterOnboarding(status: OnboardingStatus): boolean {
  return status !== 'COMPLETED';
}

export function isFirstTimeUser(input: {
  onboardingStatus: OnboardingStatus;
  realProjectCount: number;
}): boolean {
  return input.onboardingStatus !== 'COMPLETED' && input.realProjectCount === 0;
}

export function isOrdinaryUserProject(project: { isDemo: boolean; name: string; slug?: string | null }): boolean {
  if (project.isDemo) return false;
  const name = project.name.trim();
  const slug = (project.slug ?? '').trim().toLowerCase();
  if (name === '示例应用' || name === '体验应用') return false;
  if (slug === 'demo-app') return false;
  return true;
}

export function canSeeInternalTestRecords(input: {
  platformRole: string;
  isInternalTester: boolean;
}): boolean {
  return input.platformRole === 'PLATFORM_ADMIN' || input.isInternalTester;
}

export function visiblePrimaryNav(input: {
  onboardingStatus: OnboardingStatus;
  platformRole?: string;
}): string[] {
  if (shouldEnterOnboarding(input.onboardingStatus)) return [];
  const links = ['我的应用', '工作台', '账户'];
  if (input.platformRole === 'PLATFORM_ADMIN') links.push('平台管理');
  return links;
}

export function resolveOnboardingStage(input: {
  sourceBound: boolean;
  analysisCompleted: boolean;
  launchStatus: string | null;
}): OnboardingStage {
  if (input.launchStatus === 'SUCCESS') return 'SUCCESS';
  if (input.launchStatus === 'RUNNING' || input.launchStatus === 'VERIFYING') return 'LAUNCH';
  if (input.analysisCompleted) return 'PLAN';
  if (input.sourceBound) return 'ANALYZE';
  return 'CONNECT';
}

export function buildOnboardingPublicRepoInput(input: {
  cloneUrl: string;
  branch?: string;
  fullName?: string | null;
}): {
  name: string;
  source: {
    type: 'GITHUB';
    url: string;
    branch: string;
    fullName: string;
    isPrivate: false;
  };
} {
  const url = input.cloneUrl.trim();
  const fromUrl =
    input.fullName?.trim() ||
    url
      .replace(/\.git$/i, '')
      .split('/')
      .filter(Boolean)
      .slice(-2)
      .join('/');
  const name = fromUrl.split('/').filter(Boolean).pop() || '我的应用';
  return {
    name,
    source: {
      type: 'GITHUB',
      url,
      branch: input.branch?.trim() || 'main',
      fullName: fromUrl || name,
      isPrivate: false,
    },
  };
}

export function buildOnboardingUploadInput(input: {
  appName: string;
  localPath: string;
}): {
  name: string;
  source: {
    type: 'UPLOAD';
    url: string;
    branch: string;
    fullName: string;
    isPrivate: false;
  };
} {
  const name = input.appName.trim() || '我的应用';
  return {
    name,
    source: {
      type: 'UPLOAD',
      url: `local://${name}`,
      branch: 'local',
      fullName: name,
      isPrivate: false,
    },
  };
}

export function buildOnboardingProjectInput(input: {
  fullName: string;
  cloneUrl: string;
  branch: string;
  connectionId: string;
  providerRepositoryId: string;
  isPrivate: boolean;
}): {
  name: string;
  source: {
    type: 'GITHUB';
    url: string;
    branch: string;
    connectionId: string;
    providerRepositoryId: string;
    fullName: string;
    isPrivate: boolean;
  };
} {
  const name = input.fullName.split('/').filter(Boolean).pop() || '我的应用';
  return {
    name,
    source: {
      type: 'GITHUB',
      url: input.cloneUrl,
      branch: input.branch || 'main',
      connectionId: input.connectionId,
      providerRepositoryId: input.providerRepositoryId,
      fullName: input.fullName,
      isPrivate: input.isPrivate,
    },
  };
}

export function describeDetectedApplication(input: {
  unitTypes: string[];
  needsDatabase: boolean;
  needsCache: boolean;
  uncertainWebRoots: string[];
}): { findings: string[]; uncertainties: string[]; technicalHidden: true } {
  const findings: string[] = [];
  if (input.unitTypes.includes('WEB') || input.unitTypes.includes('ADMIN')) findings.push('网页应用');
  if (input.unitTypes.includes('API')) findings.push('后端接口');
  if (input.needsDatabase) findings.push('需要 PostgreSQL');
  if (input.needsCache) findings.push('需要 Redis');
  const uncertainties =
    input.uncertainWebRoots.length > 1
      ? ['我们不确定哪个目录是网页应用。']
      : [];
  return { findings, uncertainties, technicalHidden: true };
}

export function plainCloudResourceLabel(kind: string): '云服务器' | '数据库' | '缓存' | null {
  const value = kind.toUpperCase();
  if (value.includes('ECS') || value.includes('SERVER')) return '云服务器';
  if (value.includes('RDS') || value.includes('POSTGRES') || value.includes('DATABASE')) return '数据库';
  if (value.includes('REDIS') || value.includes('CACHE')) return '缓存';
  return null;
}

export function presentOnboardingPlan(input: {
  readyLabels: string[];
  resourcesToCreate: Array<{ kind: string; profileHint?: string | null }>;
  requiresConfirmation: boolean;
}): {
  ready: string[];
  toCreate: Array<{ label: string; spec: string | null }>;
  noNewBillable: boolean;
  needsBilling: boolean;
  primaryLabel: '确认费用并上线' | '开始上线';
} {
  const toCreate: Array<{ label: '云服务器' | '数据库' | '缓存'; spec: string | null }> = [];
  for (const item of input.resourcesToCreate) {
    const label = plainCloudResourceLabel(item.kind);
    if (!label) continue;
    toCreate.push({ label, spec: item.profileHint ?? null });
  }
  const needsBilling = input.requiresConfirmation || toCreate.length > 0;
  return {
    ready: input.readyLabels,
    toCreate,
    noNewBillable: !needsBilling,
    needsBilling,
    primaryLabel: needsBilling ? '确认费用并上线' : '开始上线',
  };
}

export function onboardingBillingStillRequired(input: {
  requiresConfirmation: boolean;
  billableStepTypes: string[];
  record: LaunchConfirmationRecord | null;
  currentPayload: LaunchConfirmationPayload;
}): boolean {
  return !evaluateProductBillingGate(input).ok;
}

export function markOnboardingCompleted(input: {
  reason: 'SUCCESS' | 'SKIP';
  now: string;
}): { onboardingStatus: 'COMPLETED'; onboardingCompletedAt: string; hasCompletedOnboarding: true; events: OnboardingEventName[] } {
  return {
    onboardingStatus: 'COMPLETED',
    onboardingCompletedAt: input.now,
    hasCompletedOnboarding: true,
    events: ['ONBOARDING_COMPLETED'],
  };
}

export function assertOnboardingEventSafe(metadata: Record<string, unknown>): void {
  assertLaunchEventSafe(metadata);
}

export function onboardingHidesTestControls(): true {
  return true;
}
