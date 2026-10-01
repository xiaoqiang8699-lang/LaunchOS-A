/**
 * Step 32 regression — real External Alpha failure presentation
 * (LaunchRun cmunsomd000e9rl01l54fl7vk / AUTH_SECRET missing).
 */
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const { presentDeploymentFailure } = requireDomain('@launchos/domain');

const REAL_FAILURE = {
  launchRunId: 'cmunsomd000e9rl01l54fl7vk',
  projectId: 'cmunsm2lk00ctrl01nnu1pwyd',
  projectName: 'web-ceshi',
  currentStage: 'DEPLOY',
  currentStep: 'DEPLOY_WEB',
  failureCode: '上线前还需要完成 1 项运行配置：AUTH_SECRET',
  failureMessage: '上线没有完成',
  deployableUnitId: 'cmunsmcpc00d2rl0184kdxdb3',
};

const presented = presentDeploymentFailure({
  failureCode: REAL_FAILURE.failureCode,
  failureMessage: REAL_FAILURE.failureMessage,
  currentStage: REAL_FAILURE.currentStage,
  currentStep: REAL_FAILURE.currentStep,
  projectId: REAL_FAILURE.projectId,
  deployableUnitId: REAL_FAILURE.deployableUnitId,
  projectName: REAL_FAILURE.projectName,
  missingKeys: ['AUTH_SECRET'],
});

assert.equal(presented.title, '上线失败');
assert.equal(presented.category, 'USER_CONFIG');
assert.equal(presented.productStage, 'DEPLOY');
assert.equal(presented.stageLabel, '部署应用');
assert.equal(presented.techCode, 'RUNTIME_CONFIG_MISSING');
assert.equal(presented.retryable, true);
assert.equal(presented.fixPromptAvailable, true);
assert.match(presented.userMessage, /AUTH_SECRET|运行配置/);
assert.doesNotMatch(presented.userMessage, /上线没有完成/);
assert.match(presented.suggestedAction, /AUTH_SECRET|运行配置|重新上线/);
assert.ok(presented.fixPrompt);
assert.match(presented.fixPrompt, /不要直接改仓库代码/);
assert.doesNotMatch(
  `${presented.userMessage}\n${presented.suggestedAction}\n${presented.fixPrompt}`,
  /116\.62\.198\.184|ghp_|password=|Bearer /i,
);

const out = {
  ok: true,
  launchRunId: REAL_FAILURE.launchRunId,
  deployment: null,
  realFailureStage: presented.productStage,
  rawRootCauseSummary: 'RUNTIME_CONFIG_MISSING: AUTH_SECRET required before managed deploy',
  failureCategory: presented.category,
  userResponsibility: true,
  retryable: presented.retryable,
  presented,
};
mkdirSync(join(root, '.tools/alpha-runtime'), { recursive: true });
writeFileSync(join(root, '.tools/alpha-runtime/step32-regress-real-failure.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
