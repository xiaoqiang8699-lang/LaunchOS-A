import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  ALPHA_FRICTION_AFTER_MS,
  ALPHA_INTERVENTION_AFTER_MS,
  applyHealthCheckpoint,
  applyLaunchObservation,
  assertAlphaRecordSafe,
  bindAlphaProject,
  buildModeratorChecklist,
  classifyAlphaIssue,
  classifyUserStall,
  computeAlphaDurations,
  createAlphaSession,
  healthFollowUpSchedule,
  isFirstWaveTesterScope,
  markAlphaUserStarted,
  recordAlphaDebrief,
  recordAlphaFriction,
  recordAlphaIntervention,
  submitAlphaFeedback,
  summarizeAlphaSessions,
  type AlphaSessionState,
} from './alpha-test-session.js';

const START = '2026-09-28T04:00:00.000Z';

function session(): AlphaSessionState {
  return markAlphaUserStarted(createAlphaSession({ id: 's1', userId: 'u1', now: START }).session, START).session;
}

test('create Alpha session stays planned', () => {
  const created = createAlphaSession({
    id: 's1',
    userId: 'u1',
    now: START,
    projectId: 'p1',
    projectType: 'WEB',
    framework: 'VITE',
    dependencies: 'NONE',
  });
  assert.equal(created.session.sessionStatus, 'PLANNED');
  assert.equal(created.session.userId, 'u1');
  assert.equal(created.session.projectId, 'p1');
  assert.equal(created.session.startedAt, null);
  assert.equal(created.session.launchRunId, null);
  assert.deepEqual(created.events, []);
});

test('bind Project', () => {
  const bound = bindAlphaProject(session(), {
    projectId: 'p1',
    projectType: 'WEB',
    framework: 'VITE',
    dependencies: 'NONE',
  });
  assert.equal(bound.projectId, 'p1');
  assert.equal(bound.projectType, 'WEB');
  assert.equal(bound.framework, 'VITE');
  assert.equal(bound.dependencies, 'NONE');
  assert.equal(bound.sessionStatus, 'IN_PROGRESS');
  assert.equal(bound.launchRunId, null);
});

test('binding a project does not start the session or set LaunchRun', () => {
  const planned = createAlphaSession({ id: 's1', userId: 'u1', now: START }).session;
  const bound = bindAlphaProject(planned, { projectId: 'p1', projectType: 'API', framework: 'NODE', dependencies: 'POSTGRESQL' });
  assert.equal(bound.sessionStatus, 'PLANNED');
  assert.equal(bound.startedAt, null);
  assert.equal(bound.launchRunId, null);
});

test('bind LaunchRun and aggregate success', () => {
  let current = bindAlphaProject(session(), { projectId: 'p1', projectType: 'WEB_API' });
  current = applyLaunchObservation(current, {
    kind: 'PLAN_CREATED',
    launchRunId: 'run-1',
    at: '2026-09-28T04:05:00.000Z',
  }).session;
  const started = applyLaunchObservation(current, {
    kind: 'LAUNCH_STARTED',
    launchRunId: 'run-1',
    at: '2026-09-28T04:10:00.000Z',
  });
  assert.equal(started.session.launchRunId, 'run-1');
  assert.deepEqual(started.events, ['ALPHA_LAUNCH_STARTED']);
  const finished = applyLaunchObservation(started.session, {
    kind: 'LAUNCH_FINISHED',
    launchRunId: 'run-1',
    at: '2026-09-28T04:20:00.000Z',
    status: 'SUCCESS',
    publicUrl: 'https://app.example.com',
  });
  assert.equal(finished.session.launchSucceeded, true);
  assert.equal(finished.session.sessionStatus, 'COMPLETED');
  assert.equal(finished.session.publicUrl, 'https://app.example.com');
  assert.deepEqual(finished.events, ['ALPHA_LAUNCH_SUCCESS']);
  assert.equal(finished.session.totalDurationMs, 20 * 60 * 1000);
});

test('failed LaunchRun maps failure stage', () => {
  let current = bindAlphaProject(session(), { projectId: 'p1' });
  current = applyLaunchObservation(current, {
    kind: 'LAUNCH_STARTED',
    launchRunId: 'run-2',
    at: '2026-09-28T04:10:00.000Z',
  }).session;
  const failed = applyLaunchObservation(current, {
    kind: 'LAUNCH_FINISHED',
    launchRunId: 'run-2',
    at: '2026-09-28T04:12:00.000Z',
    status: 'FAILED',
    failureCode: 'PLAN_STALE',
    failedStage: 'VERIFY',
    failedStep: 'VERIFY_WEB_HTTPS',
  });
  assert.equal(failed.session.sessionStatus, 'FAILED');
  assert.equal(failed.session.launchSucceeded, false);
  assert.equal(failed.session.blockedStage, 'VERIFY');
  assert.equal(failed.session.blockedStep, 'VERIFY_WEB_HTTPS');
  assert.equal(failed.session.primaryFailureCode, 'PLAN_STALE');
  assert.deepEqual(failed.events, ['ALPHA_LAUNCH_FAILED']);
});

test('intervention count', () => {
  const once = recordAlphaIntervention(session(), {
    stage: '确认',
    reason: '费用说明看不懂',
    actionTaken: '当面解释确认页',
  });
  const twice = recordAlphaIntervention(once.session, {
    stage: '上线',
    reason: '不知道要等待进度',
    actionTaken: '指出进度区',
  });
  assert.equal(twice.session.manualInterventionCount, 2);
  assert.deepEqual(twice.events, ['ALPHA_INTERVENTION_RECORDED']);
});

test('duration calculation', () => {
  let current = session();
  current = applyLaunchObservation(current, {
    kind: 'PLAN_CREATED',
    launchRunId: 'run-1',
    at: '2026-09-28T04:04:00.000Z',
  }).session;
  current = applyLaunchObservation(current, {
    kind: 'LAUNCH_STARTED',
    launchRunId: 'run-1',
    at: '2026-09-28T04:10:00.000Z',
  }).session;
  current = applyLaunchObservation(current, {
    kind: 'LAUNCH_FINISHED',
    launchRunId: 'run-1',
    at: '2026-09-28T04:16:00.000Z',
    status: 'SUCCESS',
    publicUrl: 'https://app.example.com',
  }).session;
  const durations = computeAlphaDurations(current);
  assert.equal(durations.timeToPlanMs, 4 * 60 * 1000);
  assert.equal(durations.timeToLaunchMs, 6 * 60 * 1000);
  assert.equal(durations.timeToPublicUrlMs, 16 * 60 * 1000);
  assert.equal(durations.totalDurationMs, 16 * 60 * 1000);
});

test('feedback', () => {
  const saved = submitAlphaFeedback(session(), {
    knewNextStep: 4,
    billingClear: 5,
    failureUnderstandable: 3,
    neededHelp: 2,
    wouldContinue: 4,
    freeFeedback: '确认页可以再短一点',
  });
  assert.equal(saved.session.billingClear, 5);
  assert.equal(saved.session.freeFeedback, '确认页可以再短一点');
  assert.deepEqual(saved.events, ['ALPHA_FEEDBACK_SUBMITTED']);
  assert.throws(() =>
    submitAlphaFeedback(session(), {
      knewNextStep: 0,
      billingClear: 5,
      failureUnderstandable: 3,
      neededHelp: 2,
      wouldContinue: 4,
    }),
  );
});

test('health 10m/1h/24h', () => {
  const finished = applyLaunchObservation(bindAlphaProject(session(), { projectId: 'p1' }), {
    kind: 'LAUNCH_FINISHED',
    launchRunId: 'run-1',
    at: START,
    status: 'SUCCESS',
    publicUrl: 'https://app.example.com',
  }).session;
  const ten = applyHealthCheckpoint(finished, {
    now: '2026-09-28T04:10:00.000Z',
    mark: 'HEALTHY',
  });
  assert.deepEqual(ten.recorded, ['10m']);
  assert.equal(ten.session.health10m, 'HEALTHY');
  assert.equal(ten.session.health24h, 'UNKNOWN');
  const day = applyHealthCheckpoint(ten.session, {
    now: '2026-09-29T04:00:00.000Z',
    mark: 'UNHEALTHY',
  });
  assert.deepEqual(day.recorded, ['1h', '24h']);
  assert.equal(day.session.health1h, 'UNHEALTHY');
  assert.equal(day.session.health24h, 'UNHEALTHY');
  assert.deepEqual(day.events, ['ALPHA_HEALTH_24H_CHECKED']);
});

test('P0-P4 issue classification', () => {
  assert.equal(classifyAlphaIssue('DATA_LEAK'), 'P0');
  assert.equal(classifyAlphaIssue('UNCONFIRMED_BILLING'), 'P0');
  assert.equal(classifyAlphaIssue('PRODUCTION_DAMAGE'), 'P0');
  assert.equal(classifyAlphaIssue('CANNOT_COMPLETE'), 'P1');
  assert.equal(classifyAlphaIssue('NEEDS_HELP'), 'P2');
  assert.equal(classifyAlphaIssue('EXPERIENCE'), 'P3');
  assert.equal(classifyAlphaIssue('SUGGESTION'), 'P4');
});

test('secret safe', () => {
  assert.throws(() =>
    recordAlphaIntervention(session(), {
      stage: '上线',
      reason: 'DATABASE_URL=postgres://u:p@h/db',
      actionTaken: '停止记录',
    }),
  );
  assert.doesNotThrow(() => assertAlphaRecordSafe({ stage: '计划', reason: '费用说明不清楚' }));
});

test('Alpha summary statistics', () => {
  const ok = applyLaunchObservation(bindAlphaProject(session(), { projectId: 'p1' }), {
    kind: 'LAUNCH_FINISHED',
    launchRunId: 'run-ok',
    at: '2026-09-28T04:10:00.000Z',
    status: 'SUCCESS',
    publicUrl: 'https://ok.example.com',
  }).session;
  const slow = applyLaunchObservation(
    {
      ...bindAlphaProject(
        markAlphaUserStarted(createAlphaSession({ id: 's2', userId: 'u2', now: START }).session, START).session,
        { projectId: 'p2' },
      ),
    },
    {
      kind: 'LAUNCH_FINISHED',
      launchRunId: 'run-slow',
      at: '2026-09-28T04:30:00.000Z',
      status: 'SUCCESS',
      publicUrl: 'https://slow.example.com',
    },
  ).session;
  const bad = applyLaunchObservation(bindAlphaProject(markAlphaUserStarted(createAlphaSession({ id: 's3', userId: 'u3', now: START }).session, START).session, { projectId: 'p3' }), {
    kind: 'LAUNCH_FINISHED',
    launchRunId: 'run-bad',
    at: '2026-09-28T04:08:00.000Z',
    status: 'FAILED',
    failureCode: 'PLAN_STALE',
    failedStage: 'VERIFY',
    failedStep: 'VERIFY_WEB_HTTPS',
  }).session;
  const helped = recordAlphaIntervention(recordAlphaIntervention(ok, {
    stage: '确认',
    reason: '看不懂费用',
    actionTaken: '解释',
  }).session, {
    stage: '上线',
    reason: '进度不清楚',
    actionTaken: '指出进度',
  }).session;
  const withHealth = { ...helped, health24h: 'HEALTHY' as const };
  const summary = summarizeAlphaSessions([withHealth, { ...slow, health24h: 'HEALTHY' }, bad], [
    { severity: 'P2', resolved: true },
  ]);
  assert.equal(summary.total, 3);
  assert.equal(summary.successCount, 2);
  assert.equal(summary.firstLaunchSuccessRate, 2 / 3);
  assert.equal(summary.medianLaunchDurationMs, Math.round((10 * 60 * 1000 + 30 * 60 * 1000) / 2));
  assert.equal(summary.mostCommonFailureStage, 'VERIFY');
  assert.equal(summary.health24hRate, 1);
  assert.ok(summary.averageInterventions > 0);
});

test('LaunchRun binds when the user creates a plan', () => {
  const planned = bindAlphaProject(createAlphaSession({ id: 's1', userId: 'u1', now: START }).session, {
    projectId: 'p1',
  });
  assert.equal(planned.launchRunId, null);
  const plannedClock = applyLaunchObservation(planned, {
    kind: 'PLAN_CREATED',
    launchRunId: 'run-real',
    at: '2026-09-28T04:06:00.000Z',
  });
  assert.equal(plannedClock.session.launchRunId, 'run-real');
  assert.equal(plannedClock.session.sessionStatus, 'IN_PROGRESS');
  assert.equal(plannedClock.session.startedAt, '2026-09-28T04:06:00.000Z');
  assert.deepEqual(plannedClock.events, ['ALPHA_TEST_STARTED', 'ALPHA_PLAN_CREATED']);
});

test('friction does not count as intervention', () => {
  const noted = recordAlphaFriction(session(), { stage: '上线计划', note: '停了两分钟' });
  assert.equal(noted.session.manualInterventionCount, 0);
  assert.deepEqual(noted.events, ['ALPHA_FRICTION_NOTED']);
  assert.equal(classifyUserStall({ stalledMs: ALPHA_FRICTION_AFTER_MS, productBlocked: false, safetyIncident: false }).record, 'friction');
  assert.equal(classifyUserStall({ stalledMs: ALPHA_INTERVENTION_AFTER_MS, productBlocked: false, safetyIncident: false }).record, 'intervention');
  assert.equal(classifyUserStall({ stalledMs: 0, productBlocked: true, safetyIncident: false }).severity, 'P1');
  assert.equal(classifyUserStall({ stalledMs: 0, productBlocked: false, safetyIncident: true }).severity, 'P0');
});

test('debrief, checklist, health schedule, and first-wave scope', () => {
  const debrief = recordAlphaDebrief({
    biggestFriction: '费用确认',
    confusingCopy: '下一步不清楚',
    explainedTechnicalConcept: false,
    viewedTechnicalDetails: false,
    failureCause: 'PRODUCT',
  });
  assert.deepEqual(debrief.events, ['ALPHA_DEBRIEF_RECORDED']);
  const finished = applyLaunchObservation(session(), {
    kind: 'LAUNCH_FINISHED',
    launchRunId: 'run-1',
    at: '2026-09-28T04:20:00.000Z',
    status: 'SUCCESS',
    publicUrl: 'https://app.example.com',
  }).session;
  const schedule = healthFollowUpSchedule(finished.publicVerifiedAt);
  assert.equal(schedule.health10mDueAt, '2026-09-28T04:30:00.000Z');
  assert.equal(schedule.health1hDueAt, '2026-09-28T05:20:00.000Z');
  assert.equal(schedule.health24hDueAt, '2026-09-29T04:20:00.000Z');
  const checklist = buildModeratorChecklist(finished);
  assert.ok(checklist.some((item) => item.id === 'health24h' && item.done === true));
  assert.equal(isFirstWaveTesterScope({ projectType: 'WEB', framework: 'VITE', dependencies: 'NONE' }), true);
  assert.equal(isFirstWaveTesterScope({ projectType: 'API', framework: 'NODE', dependencies: 'REDIS' }), true);
  assert.equal(isFirstWaveTesterScope({ projectType: 'WEB_API', framework: 'NODE', dependencies: 'POSTGRESQL' }), true);
  assert.equal(isFirstWaveTesterScope({ projectType: 'API', framework: 'VITE', dependencies: 'NONE' }), false);
  assert.equal(isFirstWaveTesterScope({ projectType: 'WEB', framework: 'OTHER_SUPPORTED', dependencies: 'NONE' }), false);
});

test('user guide stays in plain language', () => {
  const guide = readFileSync(join(__dirname, '../../../docs/external-alpha-user-test-guide.md'), 'utf8');
  for (const word of ['ECS', 'RDS', 'Redis', 'Podman', 'BullMQ', 'Artifact', 'GatewayRoute']) {
    assert.equal(guide.includes(word), false, word);
  }
  assert.match(guide, /请把你的应用通过 LaunchOS 发布到公网/);
});
