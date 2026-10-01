import assert from 'node:assert/strict';
import test from 'node:test';
import { presentDeploymentFailure, extractNestFailurePayload } from './deployment-failure-presentation.js';

test('AUTH_SECRET missing → USER_CONFIG presentation', () => {
  const p = presentDeploymentFailure({
    failureCode: '上线前还需要完成 1 项运行配置：AUTH_SECRET',
    failureMessage: '上线没有完成',
    currentStage: 'DEPLOY',
    currentStep: 'DEPLOY_WEB',
    projectId: 'proj_1',
    deployableUnitId: 'unit_1',
  });
  assert.equal(p.category, 'USER_CONFIG');
  assert.equal(p.title, '上线失败');
  assert.equal(p.stageLabel, '部署应用');
  assert.equal(p.techCode, 'RUNTIME_CONFIG_MISSING');
  assert.equal(p.retryable, true);
  assert.equal(p.fixPromptAvailable, true);
  assert.match(p.userMessage, /AUTH_SECRET|运行配置/);
  assert.match(p.suggestedAction, /重新上线|运行配置/);
  assert.ok(p.fixPrompt && p.fixPrompt.includes('不要直接改仓库代码'));
  assert.equal(p.configPath, '/projects/proj_1/units/unit_1/config');
});

test('platform worker missing → PLATFORM, no fix prompt', () => {
  const p = presentDeploymentFailure({
    failureCode: 'NO_DEPLOYMENT_WORKER_AVAILABLE',
    failureMessage: '上线服务暂时不可用，请稍后再试。',
    currentStage: 'DEPLOY',
    currentStep: 'DEPLOY_API',
  });
  assert.equal(p.category, 'PLATFORM');
  assert.equal(p.fixPromptAvailable, false);
  assert.equal(p.fixPrompt, null);
  assert.match(p.suggestedAction, /稍后重试/);
});

test('extractNestFailurePayload reads BadRequest-shaped response', () => {
  const err = {
    message: 'Bad Request Exception',
    getResponse: () => ({
      message: '上线前还需要完成 1 项运行配置：AUTH_SECRET',
      code: 'RUNTIME_CONFIG_MISSING',
      missing: [{ key: 'AUTH_SECRET', label: 'AUTH_SECRET' }],
      configPath: '/projects/proj_1/units/unit_1/config',
    }),
  };
  const extracted = extractNestFailurePayload(err);
  assert.equal(extracted.code, 'RUNTIME_CONFIG_MISSING');
  assert.deepEqual(extracted.missingKeys, ['AUTH_SECRET']);
  assert.equal(extracted.configPath, '/projects/proj_1/units/unit_1/config');
  assert.equal(extracted.deployableUnitId, 'unit_1');
});

test('redacts secrets and IPs from user text', () => {
  const p = presentDeploymentFailure({
    failureCode: 'BUILD_FAILED',
    failureMessage: 'token=ghp_abcdefghijklmnopqrstuvwxyz123456 host=116.62.198.184',
    currentStage: 'BUILD',
  });
  assert.doesNotMatch(p.userMessage, /ghp_/);
  assert.doesNotMatch(p.userMessage + p.suggestedAction, /116\.62\.198\.184/);
});
