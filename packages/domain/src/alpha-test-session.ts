/**
 * External Alpha user-test session.
 * A session is one person's test. A LaunchRun is one launch execution.
 * Classification tags are analysis labels and do not change deploy models.
 */
import { assertLaunchEventSafe } from './launch-orchestrator.js';

export const ALPHA_SESSION_STATUSES = ['PLANNED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'ABANDONED'] as const;
export type AlphaSessionStatus = (typeof ALPHA_SESSION_STATUSES)[number];

export const ALPHA_PROJECT_TYPES = ['WEB', 'API', 'WEB_API'] as const;
export type AlphaProjectType = (typeof ALPHA_PROJECT_TYPES)[number];

export const ALPHA_FRAMEWORKS = ['VITE', 'NEXTJS', 'NODE', 'OTHER_SUPPORTED'] as const;
export type AlphaFrameworkTag = (typeof ALPHA_FRAMEWORKS)[number];

export const ALPHA_DEPENDENCIES = ['POSTGRESQL', 'REDIS', 'NONE'] as const;
export type AlphaDependencyTag = (typeof ALPHA_DEPENDENCIES)[number];

export const ALPHA_HEALTH_MARKS = ['HEALTHY', 'UNHEALTHY', 'UNKNOWN'] as const;
export type AlphaHealthMark = (typeof ALPHA_HEALTH_MARKS)[number];

export const ALPHA_ISSUE_SEVERITIES = ['P0', 'P1', 'P2', 'P3', 'P4'] as const;
export type AlphaIssueSeverity = (typeof ALPHA_ISSUE_SEVERITIES)[number];

export const ALPHA_PRODUCT_EVENTS = [
  'ALPHA_TEST_STARTED',
  'ALPHA_PLAN_CREATED',
  'ALPHA_LAUNCH_STARTED',
  'ALPHA_LAUNCH_SUCCESS',
  'ALPHA_LAUNCH_FAILED',
  'ALPHA_FRICTION_NOTED',
  'ALPHA_INTERVENTION_RECORDED',
  'ALPHA_FEEDBACK_SUBMITTED',
  'ALPHA_DEBRIEF_RECORDED',
  'ALPHA_HEALTH_24H_CHECKED',
] as const;
export type AlphaProductEventName = (typeof ALPHA_PRODUCT_EVENTS)[number];

export const ALPHA_EXIT_TARGETS = {
  minSample: 3,
  maxSample: 5,
  p0: 0,
  unresolvedP1: 1,
  firstLaunchSuccessRate: 0.6,
  averageInterventions: 2,
  health24hRate: 0.8,
} as const;

export const ALPHA_FAILURE_CAUSES = [
  'PRODUCT',
  'USER_CODE',
  'CLOUD_PROVIDER',
  'PERMISSION',
  'NETWORK',
  'UNKNOWN',
] as const;
export type AlphaFailureCause = (typeof ALPHA_FAILURE_CAUSES)[number];

export const ALPHA_FRICTION_AFTER_MS = 2 * 60 * 1000;
export const ALPHA_INTERVENTION_AFTER_MS = 5 * 60 * 1000;

export const ALPHA_OBSERVATION_STAGES = [
  '创建应用',
  '绑定 GitHub',
  '分析结果',
  '上线计划',
  '费用确认',
  '开始上线',
  '上线进度',
  '失败页面',
  '成功页面',
] as const;
const TEN_MINUTES_MS = 10 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export type AlphaSessionState = {
  id: string;
  userId: string;
  projectId: string | null;
  launchRunId: string | null;
  sessionStatus: AlphaSessionStatus;
  projectType: AlphaProjectType | null;
  framework: AlphaFrameworkTag | null;
  dependencies: AlphaDependencyTag | null;
  startedAt: string | null;
  completedAt: string | null;
  launchSucceeded: boolean | null;
  totalDurationMs: number | null;
  blockedStage: string | null;
  blockedStep: string | null;
  manualInterventionCount: number;
  primaryFailureCode: string | null;
  publicUrl: string | null;
  health10m: AlphaHealthMark;
  health1h: AlphaHealthMark;
  health24h: AlphaHealthMark;
  sessionStartedAt: string | null;
  planCreatedAt: string | null;
  launchStartedAt: string | null;
  launchCompletedAt: string | null;
  publicVerifiedAt: string | null;
  knewNextStep: number | null;
  billingClear: number | null;
  failureUnderstandable: number | null;
  neededHelp: number | null;
  wouldContinue: number | null;
  freeFeedback: string | null;
};

export type AlphaDurations = {
  timeToPlanMs: number | null;
  timeToLaunchMs: number | null;
  timeToPublicUrlMs: number | null;
  totalDurationMs: number | null;
};

export type AlphaTimelineStep = {
  key: 'project' | 'source' | 'analyze' | 'plan' | 'confirm' | 'launch' | 'public';
  label: string;
  state: 'SUCCESS' | 'FAILED' | 'PENDING';
  durationMs: number | null;
  intervention: boolean;
};

export type AlphaSummary = {
  total: number;
  successCount: number;
  firstLaunchSuccessRate: number | null;
  medianLaunchDurationMs: number | null;
  averageInterventions: number;
  mostCommonFailureStage: string | null;
  health24hRate: number | null;
  exit: AlphaExitEvaluation;
};

export type AlphaExitEvaluation = {
  sampleReady: boolean;
  met: boolean;
  note: string;
  checks: Array<{ id: string; label: string; met: boolean; actual: string }>;
};

function msBetween(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const delta = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(delta) || delta < 0) return null;
  return delta;
}

export function canViewAlphaDashboard(role: string): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

export function assertAlphaRecordSafe(value: unknown): void {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    assertLaunchEventSafe(value as Record<string, unknown>);
    return;
  }
  assertLaunchEventSafe({ note: value == null ? '' : String(value) });
}

export function classifyAlphaIssue(category: string): AlphaIssueSeverity {
  switch (category) {
    case 'SECURITY':
    case 'DATA_LEAK':
    case 'UNCONFIRMED_BILLING':
    case 'PRODUCTION_DAMAGE':
      return 'P0';
    case 'CANNOT_COMPLETE':
      return 'P1';
    case 'NEEDS_HELP':
      return 'P2';
    case 'EXPERIENCE':
      return 'P3';
    case 'SUGGESTION':
      return 'P4';
    default:
      return 'P3';
  }
}

export function createAlphaSession(input: {
  id: string;
  userId: string;
  now: string;
  projectId?: string | null;
  projectType?: AlphaProjectType | null;
  framework?: AlphaFrameworkTag | null;
  dependencies?: AlphaDependencyTag | null;
}): { session: AlphaSessionState; events: AlphaProductEventName[] } {
  const projectId = input.projectId ?? null;
  const session: AlphaSessionState = {
    id: input.id,
    userId: input.userId,
    projectId,
    launchRunId: null,
    sessionStatus: 'PLANNED',
    projectType: input.projectType ?? null,
    framework: input.framework ?? null,
    dependencies: input.dependencies ?? null,
    startedAt: null,
    completedAt: null,
    launchSucceeded: null,
    totalDurationMs: null,
    blockedStage: null,
    blockedStep: null,
    manualInterventionCount: 0,
    primaryFailureCode: null,
    publicUrl: null,
    health10m: 'UNKNOWN',
    health1h: 'UNKNOWN',
    health24h: 'UNKNOWN',
    sessionStartedAt: null,
    planCreatedAt: null,
    launchStartedAt: null,
    launchCompletedAt: null,
    publicVerifiedAt: null,
    knewNextStep: null,
    billingClear: null,
    failureUnderstandable: null,
    neededHelp: null,
    wouldContinue: null,
    freeFeedback: null,
  };
  return { session, events: [] };
}

export function markAlphaUserStarted(
  session: AlphaSessionState,
  at: string,
): { session: AlphaSessionState; events: AlphaProductEventName[] } {
  if (session.startedAt) {
    return { session, events: [] };
  }
  return {
    session: {
      ...session,
      sessionStatus: session.sessionStatus === 'PLANNED' ? 'IN_PROGRESS' : session.sessionStatus,
      startedAt: at,
      sessionStartedAt: at,
    },
    events: ['ALPHA_TEST_STARTED'],
  };
}

export function bindAlphaProject(
  session: AlphaSessionState,
  input: {
    projectId: string;
    projectType?: AlphaProjectType | null;
    framework?: AlphaFrameworkTag | null;
    dependencies?: AlphaDependencyTag | null;
  },
): AlphaSessionState {
  return {
    ...session,
    projectId: input.projectId,
    projectType: input.projectType === undefined ? session.projectType : input.projectType,
    framework: input.framework === undefined ? session.framework : input.framework,
    dependencies: input.dependencies === undefined ? session.dependencies : input.dependencies,
  };
}

export function computeAlphaDurations(session: AlphaSessionState): AlphaDurations {
  const totalDurationMs =
    session.totalDurationMs ??
    msBetween(session.sessionStartedAt, session.completedAt ?? session.launchCompletedAt);
  return {
    timeToPlanMs: msBetween(session.sessionStartedAt, session.planCreatedAt),
    timeToLaunchMs: msBetween(session.launchStartedAt, session.launchCompletedAt),
    timeToPublicUrlMs: msBetween(session.sessionStartedAt, session.publicVerifiedAt),
    totalDurationMs,
  };
}

export function applyLaunchObservation(
  session: AlphaSessionState,
  observation: {
    kind: 'PLAN_CREATED' | 'LAUNCH_STARTED' | 'LAUNCH_FINISHED';
    launchRunId: string;
    at: string;
    status?: string | null;
    failureCode?: string | null;
    failedStage?: string | null;
    failedStep?: string | null;
    publicUrl?: string | null;
  },
): { session: AlphaSessionState; events: AlphaProductEventName[] } {
  if (observation.kind === 'PLAN_CREATED') {
    const started = markAlphaUserStarted(session, observation.at);
    return {
      session: {
        ...started.session,
        launchRunId: started.session.launchRunId ?? observation.launchRunId,
        planCreatedAt: started.session.planCreatedAt ?? observation.at,
      },
      events: [...started.events, 'ALPHA_PLAN_CREATED'],
    };
  }
  if (observation.kind === 'LAUNCH_STARTED') {
    const started = markAlphaUserStarted(session, observation.at);
    return {
      session: {
        ...started.session,
        launchRunId: observation.launchRunId,
        launchStartedAt: started.session.launchStartedAt ?? observation.at,
        sessionStatus:
          started.session.sessionStatus === 'COMPLETED' ||
          started.session.sessionStatus === 'FAILED' ||
          started.session.sessionStatus === 'ABANDONED'
            ? started.session.sessionStatus
            : 'IN_PROGRESS',
        publicUrl: observation.publicUrl ?? started.session.publicUrl,
      },
      events: [...started.events, 'ALPHA_LAUNCH_STARTED'],
    };
  }
  const started = markAlphaUserStarted(session, observation.at);
  const succeeded = observation.status === 'SUCCESS';
  const finished: AlphaSessionState = {
    ...started.session,
    launchRunId: observation.launchRunId,
    launchCompletedAt: observation.at,
    launchSucceeded: succeeded,
    sessionStatus: succeeded ? 'COMPLETED' : 'FAILED',
    completedAt: observation.at,
    blockedStage: succeeded ? null : observation.failedStage ?? session.blockedStage,
    blockedStep: succeeded ? null : observation.failedStep ?? session.blockedStep,
    primaryFailureCode: succeeded ? null : observation.failureCode ?? session.primaryFailureCode,
    publicUrl: observation.publicUrl ?? session.publicUrl,
    publicVerifiedAt: succeeded && (observation.publicUrl || session.publicUrl) ? observation.at : session.publicVerifiedAt,
  };
  const durations = computeAlphaDurations(finished);
  return {
    session: { ...finished, totalDurationMs: durations.totalDurationMs },
    events: [...started.events, succeeded ? 'ALPHA_LAUNCH_SUCCESS' : 'ALPHA_LAUNCH_FAILED'],
  };
}

export function recordAlphaIntervention(
  session: AlphaSessionState,
  input: { stage: string; reason: string; actionTaken: string; resolved?: boolean },
): { session: AlphaSessionState; events: AlphaProductEventName[] } {
  assertAlphaRecordSafe({
    stage: input.stage,
    reason: input.reason,
    actionTaken: input.actionTaken,
  });
  return {
    session: {
      ...session,
      manualInterventionCount: session.manualInterventionCount + 1,
    },
    events: ['ALPHA_INTERVENTION_RECORDED'],
  };
}

function score(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new Error(`${label} 需要 1 到 5 分`);
  }
  return value;
}

export function submitAlphaFeedback(
  session: AlphaSessionState,
  input: {
    knewNextStep: number;
    billingClear: number;
    failureUnderstandable: number;
    neededHelp: number;
    wouldContinue: number;
    freeFeedback?: string | null;
  },
): { session: AlphaSessionState; events: AlphaProductEventName[] } {
  const freeFeedback = input.freeFeedback?.trim() || null;
  assertAlphaRecordSafe({
    knewNextStep: input.knewNextStep,
    billingClear: input.billingClear,
    failureUnderstandable: input.failureUnderstandable,
    neededHelp: input.neededHelp,
    wouldContinue: input.wouldContinue,
    freeFeedback: freeFeedback ?? '',
  });
  return {
    session: {
      ...session,
      knewNextStep: score(input.knewNextStep, '下一步'),
      billingClear: score(input.billingClear, '费用确认'),
      failureUnderstandable: score(input.failureUnderstandable, '失败原因'),
      neededHelp: score(input.neededHelp, '帮助'),
      wouldContinue: score(input.wouldContinue, '继续使用'),
      freeFeedback,
    },
    events: ['ALPHA_FEEDBACK_SUBMITTED'],
  };
}

export function applyHealthCheckpoint(
  session: AlphaSessionState,
  input: { now: string; mark: AlphaHealthMark },
): { session: AlphaSessionState; events: AlphaProductEventName[]; recorded: Array<'10m' | '1h' | '24h'> } {
  const anchor = session.publicVerifiedAt ?? session.launchCompletedAt;
  const elapsed = msBetween(anchor, input.now);
  if (elapsed == null) {
    return { session, events: [], recorded: [] };
  }
  const next = { ...session };
  const recorded: Array<'10m' | '1h' | '24h'> = [];
  if (elapsed >= TEN_MINUTES_MS && next.health10m === 'UNKNOWN') {
    next.health10m = input.mark;
    recorded.push('10m');
  }
  if (elapsed >= ONE_HOUR_MS && next.health1h === 'UNKNOWN') {
    next.health1h = input.mark;
    recorded.push('1h');
  }
  if (elapsed >= ONE_DAY_MS && next.health24h === 'UNKNOWN') {
    next.health24h = input.mark;
    recorded.push('24h');
  }
  return {
    session: next,
    events: recorded.includes('24h') ? ['ALPHA_HEALTH_24H_CHECKED'] : [],
    recorded,
  };
}

export function foldServiceHealth(statuses: string[]): AlphaHealthMark {
  if (statuses.length === 0) return 'UNKNOWN';
  if (statuses.some((status) => status === 'UNHEALTHY')) return 'UNHEALTHY';
  if (statuses.every((status) => status === 'HEALTHY')) return 'HEALTHY';
  return 'UNKNOWN';
}

const TIMELINE: Array<{ key: AlphaTimelineStep['key']; label: string }> = [
  { key: 'project', label: '创建应用' },
  { key: 'source', label: '代码连接' },
  { key: 'analyze', label: '分析' },
  { key: 'plan', label: '计划' },
  { key: 'confirm', label: '确认' },
  { key: 'launch', label: '上线' },
  { key: 'public', label: '公网验证' },
];

function stageHits(blockedStage: string | null, keys: string[]): boolean {
  if (!blockedStage) return false;
  const stage = blockedStage.toUpperCase();
  return keys.some((key) => stage.includes(key));
}

export function buildAlphaTimeline(
  session: AlphaSessionState,
  interventionStages: string[] = [],
): AlphaTimelineStep[] {
  const durations = computeAlphaDurations(session);
  const helped = (key: string, label: string) =>
    interventionStages.some((stage) => stage === key || stage === label);
  const failedLaunch = session.launchSucceeded === false;
  return TIMELINE.map((step) => {
    let state: AlphaTimelineStep['state'] = 'PENDING';
    let durationMs: number | null = null;
    if (step.key === 'project') state = session.projectId ? 'SUCCESS' : 'PENDING';
    if (step.key === 'source' || step.key === 'analyze') {
      state = session.planCreatedAt ? 'SUCCESS' : 'PENDING';
      if (step.key === 'analyze' && stageHits(session.blockedStage, ['ANALYZE', 'DEPENDENCIES'])) state = 'FAILED';
    }
    if (step.key === 'plan') {
      state = session.planCreatedAt ? 'SUCCESS' : 'PENDING';
      durationMs = durations.timeToPlanMs;
    }
    if (step.key === 'confirm') {
      state = session.launchStartedAt ? 'SUCCESS' : 'PENDING';
      if (stageHits(session.blockedStage, ['CONFIRM'])) state = 'FAILED';
    }
    if (step.key === 'launch') {
      if (session.launchSucceeded === true) state = 'SUCCESS';
      else if (failedLaunch) state = 'FAILED';
      durationMs = durations.timeToLaunchMs;
    }
    if (step.key === 'public') {
      if (session.publicVerifiedAt) state = 'SUCCESS';
      else if (failedLaunch && stageHits(session.blockedStage, ['PUBLIC', 'VERIFY'])) state = 'FAILED';
      durationMs = session.publicVerifiedAt && session.launchCompletedAt
        ? msBetween(session.launchCompletedAt, session.publicVerifiedAt)
        : null;
    }
    return { ...step, state, durationMs, intervention: helped(step.key, step.label) };
  });
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const left = sorted[mid - 1];
  const right = sorted[mid];
  if (left == null || right == null) return null;
  return Math.round((left + right) / 2);
}

export function evaluateAlphaExit(input: {
  total: number;
  openP0: number;
  unresolvedP1: number;
  firstLaunchSuccessRate: number | null;
  averageInterventions: number;
  health24hRate: number | null;
}): AlphaExitEvaluation {
  const checks = [
    {
      id: 'p0',
      label: 'P0 = 0',
      met: input.openP0 === ALPHA_EXIT_TARGETS.p0,
      actual: String(input.openP0),
    },
    {
      id: 'p1',
      label: '未解决 P1 ≤ 1',
      met: input.unresolvedP1 <= ALPHA_EXIT_TARGETS.unresolvedP1,
      actual: String(input.unresolvedP1),
    },
    {
      id: 'success',
      label: '首次上线成功率 ≥ 60%',
      met: input.firstLaunchSuccessRate != null && input.firstLaunchSuccessRate >= ALPHA_EXIT_TARGETS.firstLaunchSuccessRate,
      actual: input.firstLaunchSuccessRate == null ? '—' : `${Math.round(input.firstLaunchSuccessRate * 100)}%`,
    },
    {
      id: 'help',
      label: '平均人工介入 ≤ 2',
      met: input.averageInterventions <= ALPHA_EXIT_TARGETS.averageInterventions,
      actual: input.averageInterventions.toFixed(1),
    },
    {
      id: 'health',
      label: '24h 健康率 ≥ 80%',
      met: input.health24hRate != null && input.health24hRate >= ALPHA_EXIT_TARGETS.health24hRate,
      actual: input.health24hRate == null ? '—' : `${Math.round(input.health24hRate * 100)}%`,
    },
  ];
  const sampleReady = input.total >= ALPHA_EXIT_TARGETS.minSample;
  return {
    sampleReady,
    met: sampleReady && checks.every((check) => check.met),
    note: '第一轮内部目标，不是最终商业 SLA。3–5 人完成后再决定下一轮。',
    checks,
  };
}

export function summarizeAlphaSessions(
  sessions: AlphaSessionState[],
  issues: Array<{ severity: AlphaIssueSeverity; resolved: boolean }> = [],
): AlphaSummary {
  const success = sessions.filter((session) => session.launchSucceeded === true);
  const attempted = sessions.filter((session) => session.launchRunId);
  const firstLaunchSuccessRate = attempted.length === 0 ? null : success.length / attempted.length;
  const durations = success
    .map((session) => computeAlphaDurations(session).totalDurationMs)
    .filter((value): value is number => value != null);
  const stageCounts = new Map<string, number>();
  for (const session of sessions) {
    if (!session.blockedStage) continue;
    stageCounts.set(session.blockedStage, (stageCounts.get(session.blockedStage) ?? 0) + 1);
  }
  let mostCommonFailureStage: string | null = null;
  let most = 0;
  for (const [stage, count] of stageCounts) {
    if (count > most) {
      most = count;
      mostCommonFailureStage = stage;
    }
  }
  const checked = sessions.filter((session) => session.health24h !== 'UNKNOWN');
  const healthy = checked.filter((session) => session.health24h === 'HEALTHY');
  const health24hRate = checked.length === 0 ? null : healthy.length / checked.length;
  const averageInterventions =
    sessions.length === 0
      ? 0
      : sessions.reduce((sum, session) => sum + session.manualInterventionCount, 0) / sessions.length;
  const openP0 = issues.filter((issue) => issue.severity === 'P0' && !issue.resolved).length;
  const unresolvedP1 = issues.filter((issue) => issue.severity === 'P1' && !issue.resolved).length;
  return {
    total: sessions.length,
    successCount: success.length,
    firstLaunchSuccessRate,
    medianLaunchDurationMs: median(durations),
    averageInterventions,
    mostCommonFailureStage,
    health24hRate,
    exit: evaluateAlphaExit({
      total: sessions.length,
      openP0,
      unresolvedP1,
      firstLaunchSuccessRate,
      averageInterventions,
      health24hRate,
    }),
  };
}

export function isFirstWaveTesterScope(input: {
  projectType: string | null;
  framework: string | null;
  dependencies: string | null;
}): boolean {
  const dependencyOk =
    input.dependencies === 'NONE' || input.dependencies === 'POSTGRESQL' || input.dependencies === 'REDIS';
  if (!dependencyOk) return false;
  if (input.projectType === 'WEB') return input.framework === 'VITE' || input.framework === 'NEXTJS';
  if (input.projectType === 'API') return input.framework === 'NODE';
  if (input.projectType === 'WEB_API') {
    return input.framework === 'VITE' || input.framework === 'NEXTJS' || input.framework === 'NODE';
  }
  return false;
}

export function classifyUserStall(input: {
  stalledMs: number;
  productBlocked: boolean;
  safetyIncident: boolean;
}): { record: 'watch' | 'friction' | 'intervention'; severity: AlphaIssueSeverity | null } {
  if (input.safetyIncident) return { record: 'intervention', severity: 'P0' };
  if (input.productBlocked) return { record: 'intervention', severity: 'P1' };
  if (input.stalledMs >= ALPHA_INTERVENTION_AFTER_MS) return { record: 'intervention', severity: 'P2' };
  if (input.stalledMs >= ALPHA_FRICTION_AFTER_MS) return { record: 'friction', severity: 'P3' };
  return { record: 'watch', severity: null };
}

export function recordAlphaFriction(
  session: AlphaSessionState,
  input: { stage: string; note: string },
): { session: AlphaSessionState; events: AlphaProductEventName[] } {
  assertAlphaRecordSafe({ stage: input.stage, note: input.note });
  return { session, events: ['ALPHA_FRICTION_NOTED'] };
}

export type AlphaDebrief = {
  biggestFriction: string;
  confusingCopy: string;
  explainedTechnicalConcept: boolean;
  viewedTechnicalDetails: boolean;
  failureCause: AlphaFailureCause | null;
};

export function recordAlphaDebrief(
  input: AlphaDebrief,
): { debrief: AlphaDebrief; events: AlphaProductEventName[] } {
  if (input.failureCause && !ALPHA_FAILURE_CAUSES.includes(input.failureCause)) {
    throw new Error('失败根因无效');
  }
  assertAlphaRecordSafe({
    biggestFriction: input.biggestFriction,
    confusingCopy: input.confusingCopy,
    failureCause: input.failureCause ?? '',
  });
  return { debrief: input, events: ['ALPHA_DEBRIEF_RECORDED'] };
}

export function healthFollowUpSchedule(anchor: string | null): {
  health10mDueAt: string | null;
  health1hDueAt: string | null;
  health24hDueAt: string | null;
} {
  if (!anchor) {
    return { health10mDueAt: null, health1hDueAt: null, health24hDueAt: null };
  }
  const start = new Date(anchor).getTime();
  return {
    health10mDueAt: new Date(start + TEN_MINUTES_MS).toISOString(),
    health1hDueAt: new Date(start + ONE_HOUR_MS).toISOString(),
    health24hDueAt: new Date(start + ONE_DAY_MS).toISOString(),
  };
}

export type AlphaChecklistItem = {
  phase: 'before' | 'during' | 'after';
  id: string;
  label: string;
  done: boolean | null;
};

export function buildModeratorChecklist(session: AlphaSessionState): AlphaChecklistItem[] {
  const started = session.sessionStatus !== 'PLANNED';
  const schedule = healthFollowUpSchedule(session.publicVerifiedAt ?? session.launchCompletedAt);
  return [
    { phase: 'before', id: 'github', label: 'GitHub 账号可用', done: null },
    { phase: 'before', id: 'repo', label: '用户自己的仓库可访问，且 LaunchOS 第一次接触', done: null },
    { phase: 'before', id: 'session', label: '已创建测试记录，且没有提前填写 LaunchRun', done: session.launchRunId == null || started },
    { phase: 'during', id: 'no-coaching', label: '没有提前教用户点哪里', done: null },
    { phase: 'during', id: 'friction', label: '卡住约 2 分钟时记录体验摩擦', done: null },
    { phase: 'during', id: 'intervention', label: '无法继续时才记录人工介入', done: null },
    { phase: 'during', id: 'error', label: '产品报错已记录阶段和错误码', done: session.primaryFailureCode ? true : session.launchSucceeded === false ? false : null },
    { phase: 'after', id: 'feedback', label: '五个问题已提交', done: session.knewNextStep != null },
    { phase: 'after', id: 'url', label: '公网地址已由用户打开', done: Boolean(session.publicUrl && session.launchSucceeded) },
    { phase: 'after', id: 'health10m', label: '10 分钟健康复查已安排', done: Boolean(schedule.health10mDueAt) },
    { phase: 'after', id: 'health1h', label: '1 小时健康复查已安排', done: Boolean(schedule.health1hDueAt) },
    { phase: 'after', id: 'health24h', label: '24 小时健康复查已安排', done: Boolean(schedule.health24hDueAt) },
  ];
}
