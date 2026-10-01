import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deploymentJobId, isRetryableDeploymentError } from './queue';

describe('deploymentJobId', () => {
  it('uses stable deployment-{id} form', () => {
    assert.equal(deploymentJobId('abc123'), 'deployment-abc123');
  });
});

describe('isRetryableDeploymentError', () => {
  it('retries infrastructure errors', () => {
    assert.equal(isRetryableDeploymentError('Redis connection lost'), true);
    assert.equal(isRetryableDeploymentError('SSH ECONNRESET'), true);
    assert.equal(isRetryableDeploymentError('socket hang up'), true);
  });

  it('does not retry build/config errors', () => {
    assert.equal(isRetryableDeploymentError('npm ERR! missing script'), false);
    assert.equal(isRetryableDeploymentError('Build failed'), false);
    assert.equal(isRetryableDeploymentError('unsupported project type'), false);
    assert.equal(isRetryableDeploymentError('配置错误：缺少启动命令'), false);
  });
});
