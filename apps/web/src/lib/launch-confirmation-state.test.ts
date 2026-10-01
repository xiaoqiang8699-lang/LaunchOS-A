import assert from 'node:assert/strict';
import test from 'node:test';
import { planNeedsBillingConfirmation, presentLaunchPageError, resolveLaunchPrimaryCta } from './launch-confirmation-state.ts';

test('requiresConfirmation=false page does not need a confirmation hash', () => {
  const gate = planNeedsBillingConfirmation({
    requiresConfirmation: false,
    billableStepTypes: [],
    confirmedPlanHash: null,
    planVersion: 'v1',
    confirmedForPlanVersion: null,
  });
  assert.equal(gate.needsConfirmation, false);
  assert.equal(gate.blockedReason, null);
});

test('no billable resources leaves start launch available', () => {
  const gate = planNeedsBillingConfirmation({
    requiresConfirmation: false,
    billableStepTypes: ['VERIFY_WEB_HTTPS', 'FINAL_ACCEPTANCE'],
    confirmedPlanHash: null,
    planVersion: 'v1',
    confirmedForPlanVersion: null,
  });
  assert.equal(gate.needsConfirmation, false);
});

test('regenerate clears confirmation by passing a null hash', () => {
  const gate = planNeedsBillingConfirmation({
    requiresConfirmation: false,
    billableStepTypes: [],
    confirmedPlanHash: null,
    planVersion: 'v2',
    confirmedForPlanVersion: null,
  });
  assert.equal(gate.needsConfirmation, false);
});

test('billable plan still requires confirmation', () => {
  const gate = planNeedsBillingConfirmation({
    requiresConfirmation: true,
    billableStepTypes: ['CREATE_ECS', 'CREATE_RDS', 'CREATE_REDIS'],
    confirmedPlanHash: null,
    planVersion: 'v1',
    confirmedForPlanVersion: null,
  });
  assert.equal(gate.needsConfirmation, true);
  assert.equal(gate.blockedReason, 'missing');
});

test('confirmedPlanHash stale still blocks', () => {
  const gate = planNeedsBillingConfirmation({
    requiresConfirmation: true,
    billableStepTypes: ['CREATE_ECS'],
    confirmedPlanHash: 'hash-old',
    planVersion: 'v2',
    confirmedForPlanVersion: 'v1',
  });
  assert.equal(gate.needsConfirmation, true);
  assert.equal(gate.blockedReason, 'stale');
});

test('未上线 shows 开始上线', () => {
  const cta = resolveLaunchPrimaryCta({
    launchRunStatus: 'READY',
    accessEntryActive: false,
    latestFinishedLaunchStatus: null,
    needsBillingConfirmation: false,
    planStale: false,
    pending: false,
  });
  assert.equal(cta.label, '开始上线');
  assert.equal(cta.disabled, false);
});

test('RUNNING shows 正在上线', () => {
  const cta = resolveLaunchPrimaryCta({
    launchRunStatus: 'RUNNING',
    accessEntryActive: false,
    latestFinishedLaunchStatus: null,
    needsBillingConfirmation: false,
    planStale: false,
    pending: true,
  });
  assert.equal(cta.label, '正在上线…');
  assert.equal(cta.disabled, true);
});

test('SUCCESS and active access entry shows 发布新版本', () => {
  const current = resolveLaunchPrimaryCta({
    launchRunStatus: 'SUCCESS',
    accessEntryActive: true,
    latestFinishedLaunchStatus: 'SUCCESS',
    needsBillingConfirmation: false,
    planStale: false,
    pending: false,
  });
  assert.equal(current.label, '发布新版本');
  const reopened = resolveLaunchPrimaryCta({
    launchRunStatus: 'READY',
    accessEntryActive: true,
    latestFinishedLaunchStatus: 'SUCCESS',
    needsBillingConfirmation: false,
    planStale: false,
    pending: false,
  });
  assert.equal(reopened.label, '发布新版本');
  assert.equal(reopened.action, 'execute');
});

test('FAILED shows 重新尝试', () => {
  const cta = resolveLaunchPrimaryCta({
    launchRunStatus: 'FAILED',
    accessEntryActive: true,
    latestFinishedLaunchStatus: 'SUCCESS',
    needsBillingConfirmation: false,
    planStale: false,
    pending: false,
  });
  assert.equal(cta.label, '重新尝试');
});

test('stale plan shows 重新生成计划', () => {
  const cta = resolveLaunchPrimaryCta({
    launchRunStatus: 'READY',
    accessEntryActive: true,
    latestFinishedLaunchStatus: 'SUCCESS',
    needsBillingConfirmation: true,
    planStale: true,
    pending: false,
  });
  assert.equal(cta.label, '重新生成计划');
  assert.equal(cta.action, 'replan');
});

test('requiresConfirmation shows 确认费用并上线', () => {
  const cta = resolveLaunchPrimaryCta({
    launchRunStatus: 'WAITING_CONFIRMATION',
    accessEntryActive: false,
    latestFinishedLaunchStatus: null,
    needsBillingConfirmation: true,
    planStale: false,
    pending: false,
  });
  assert.equal(cta.label, '确认费用并上线');
  assert.equal(cta.action, 'confirm');
});

test('page does not show a raw ReferenceError', () => {
  const view = presentLaunchPageError(new ReferenceError('setConfirmedHash is not defined'));
  assert.equal(view.message, '页面加载失败，请重新生成上线计划后再试。');
  assert.match(view.technical ?? '', /ReferenceError/);
  assert.match(view.technical ?? '', /setConfirmedHash is not defined/);
  assert.equal(view.message.includes('setConfirmedHash'), false);
});
