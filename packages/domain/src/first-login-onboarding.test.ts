import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ONBOARDING_LAUNCH_ENTRY,
  assertOnboardingEventSafe,
  buildOnboardingProjectInput,
  canSeeInternalTestRecords,
  describeDetectedApplication,
  isFirstTimeUser,
  isOrdinaryUserProject,
  markOnboardingCompleted,
  onboardingBillingStillRequired,
  onboardingHidesTestControls,
  presentOnboardingPlan,
  resolveOnboardingStage,
  shouldEnterOnboarding,
  visiblePrimaryNav,
} from './first-login-onboarding.js';

const payload = {
  planVersion: 'v1',
  projectId: 'p1',
  environmentId: 'e1',
  resourcesToCreate: [] as Array<{ kind: string; labelZh: string }>,
  billableActions: [] as Array<{ stepType: string; labelZh: string }>,
};

test('new user enters onboarding', () => {
  assert.equal(isFirstTimeUser({ onboardingStatus: 'NOT_STARTED', realProjectCount: 0 }), true);
  assert.equal(shouldEnterOnboarding('NOT_STARTED'), true);
  assert.equal(resolveOnboardingStage({ sourceBound: false, analysisCompleted: false, launchStatus: null }), 'CONNECT');
});

test('new user does not see the full nav', () => {
  assert.deepEqual(visiblePrimaryNav({ onboardingStatus: 'NOT_STARTED' }), []);
});

test('new user does not see the demo app', () => {
  assert.equal(isOrdinaryUserProject({ isDemo: true, name: '示例应用', slug: 'demo-app' }), false);
  assert.equal(isOrdinaryUserProject({ isDemo: false, name: '体验应用', slug: 'try' }), false);
  assert.equal(isOrdinaryUserProject({ isDemo: false, name: '我的网站', slug: 'site' }), true);
});

test('connect repo builds a project and a source together', () => {
  const created = buildOnboardingProjectInput({
    fullName: 'acme/web',
    cloneUrl: 'https://github.com/acme/web.git',
    branch: 'main',
    connectionId: 'conn',
    providerRepositoryId: '1',
    isPrivate: false,
  });
  assert.equal(created.name, 'web');
  assert.equal(created.source.url, 'https://github.com/acme/web.git');
  assert.equal(created.source.type, 'GITHUB');
});

test('analyze completes step 2 in plain language', () => {
  const detected = describeDetectedApplication({
    unitTypes: ['WEB', 'API'],
    needsDatabase: true,
    needsCache: false,
    uncertainWebRoots: [],
  });
  assert.deepEqual(detected.findings, ['网页应用', '后端接口', '需要 PostgreSQL']);
  assert.equal(detected.technicalHidden, true);
  assert.equal(
    resolveOnboardingStage({ sourceBound: true, analysisCompleted: true, launchStatus: null }),
    'PLAN',
  );
});

test('billing-free plan says no new paid resources', () => {
  const plan = presentOnboardingPlan({ readyLabels: ['服务器'], resourcesToCreate: [], requiresConfirmation: false });
  assert.equal(plan.noNewBillable, true);
  assert.equal(plan.primaryLabel, '开始上线');
});

test('billable plan asks to confirm cost', () => {
  const plan = presentOnboardingPlan({
    readyLabels: [],
    resourcesToCreate: [{ kind: 'CREATE_RDS', profileHint: '基础版' }],
    requiresConfirmation: true,
  });
  assert.equal(plan.needsBilling, true);
  assert.equal(plan.toCreate[0]?.label, '数据库');
  assert.equal(plan.primaryLabel, '确认费用并上线');
  assert.equal(JSON.stringify(plan).includes('RDS'), false);
});

test('billing confirmation is still required before launch', () => {
  assert.equal(
    onboardingBillingStillRequired({
      requiresConfirmation: true,
      billableStepTypes: ['CREATE_ECS'],
      record: null,
      currentPayload: {
        ...payload,
        billableActions: [{ stepType: 'CREATE_ECS', labelZh: '云服务器' }],
        resourcesToCreate: [{ kind: 'CREATE_ECS', labelZh: '云服务器' }],
      },
    }),
    true,
  );
});

test('start launch uses the existing orchestrator', () => {
  assert.equal(ONBOARDING_LAUNCH_ENTRY, 'EXISTING_ORCHESTRATOR');
  assert.equal(
    resolveOnboardingStage({ sourceBound: true, analysisCompleted: true, launchStatus: 'RUNNING' }),
    'LAUNCH',
  );
});

test('success completes onboarding and unlocks nav', () => {
  const done = markOnboardingCompleted({ reason: 'SUCCESS', now: '2026-09-28T06:00:00.000Z' });
  assert.equal(done.onboardingStatus, 'COMPLETED');
  assert.equal(shouldEnterOnboarding(done.onboardingStatus), false);
  assert.deepEqual(visiblePrimaryNav({ onboardingStatus: 'COMPLETED', platformRole: 'USER' }), [
    '我的应用',
    '工作台',
    '账户',
  ]);
});

test('reload resumes the connected stage', () => {
  assert.equal(
    resolveOnboardingStage({ sourceBound: true, analysisCompleted: false, launchStatus: null }),
    'ANALYZE',
  );
});

test('returning user skips onboarding', () => {
  assert.equal(isFirstTimeUser({ onboardingStatus: 'COMPLETED', realProjectCount: 2 }), false);
  assert.equal(shouldEnterOnboarding('COMPLETED'), false);
});

test('alpha tester sees the same onboarding, without test controls', () => {
  assert.equal(onboardingHidesTestControls(), true);
  assert.equal(shouldEnterOnboarding('IN_PROGRESS'), true);
});

test('ordinary owner cannot see test records', () => {
  assert.equal(canSeeInternalTestRecords({ platformRole: 'USER', isInternalTester: false }), false);
  assert.equal(canSeeInternalTestRecords({ platformRole: 'PLATFORM_ADMIN', isInternalTester: false }), true);
  assert.equal(canSeeInternalTestRecords({ platformRole: 'USER', isInternalTester: true }), true);
});

test('onboarding events reject secrets', () => {
  assert.throws(() => assertOnboardingEventSafe({ note: 'token=abc' }));
  assert.doesNotThrow(() => assertOnboardingEventSafe({ stage: 'CONNECT' }));
});
