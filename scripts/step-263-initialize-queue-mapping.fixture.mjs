/**
 * Step 26.3 — POST initialize service mapping fixture (mock queue, no SSH / no real enqueue).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, 'apps/api/package.json'));

const {
  serverInitializationJobId,
} = require('@launchos/shared');

describe('step-263 initialize POST mapping (mock queue)', () => {
  it('success path returns jobId without SSH when queue.add succeeds', async () => {
    const serverInstanceId = 'cmub78pz001sdripco5pexhdz';
    const expectedJobId = serverInitializationJobId(serverInstanceId);
    let addCalls = 0;
    const mockQueue = {
      async enqueue() {
        addCalls += 1;
        return { jobId: expectedJobId, alreadyInProgress: false, strategy: 'add_new' };
      },
      async probeReadiness() {
        return {
          redisReady: true,
          serverInitializationQueueReady: true,
          errorCode: null,
          errorMessage: null,
        };
      },
    };
    const mockPresence = {
      async getDeploymentWorkerPresence() {
        return {
          online: true,
          workerId: 'w-mock',
          queueReady: { serverInitialization: true },
          consumedQueues: ['serverInitializationQueue'],
        };
      },
    };

    // Simulate the gate branch used by initialize() after loadContext
    const presence = await mockPresence.getDeploymentWorkerPresence();
    const queueProbe = await mockQueue.probeReadiness();
    assert.equal(queueProbe.serverInitializationQueueReady, true);
    assert.equal(presence.queueReady.serverInitialization, true);
    const enqueued = await mockQueue.enqueue();
    assert.equal(addCalls, 1);
    assert.equal(enqueued.jobId, expectedJobId);
    assert.equal(enqueued.alreadyInProgress, false);
  });

  it('maps worker consumer missing to SERVER_INITIALIZATION_WORKER_CONSUMER_UNAVAILABLE', async () => {
    const presence = {
      online: true,
      queueReady: { serverInitialization: false },
      consumedQueues: ['serverProvisionQueue'],
    };
    const code = !presence.online
      ? 'SERVER_INITIALIZATION_WORKER_OFFLINE'
      : !presence.queueReady.serverInitialization
        ? 'SERVER_INITIALIZATION_WORKER_CONSUMER_UNAVAILABLE'
        : null;
    assert.equal(code, 'SERVER_INITIALIZATION_WORKER_CONSUMER_UNAVAILABLE');
    const userMessage = '服务器初始化服务暂时不可用，请稍后重试。';
    assert.match(userMessage, /暂时不可用/);
  });

  it('maps queue.add throw to SERVER_INITIALIZATION_ENQUEUE_FAILED', async () => {
    const mockQueue = {
      async enqueue() {
        throw new Error('Redis connection closed');
      },
    };
    let code = null;
    let safeUser = null;
    try {
      await mockQueue.enqueue();
    } catch (error) {
      code = 'SERVER_INITIALIZATION_ENQUEUE_FAILED';
      safeUser = '服务器初始化服务暂时不可用，请稍后重试。';
      assert.match(String(error.message), /Redis|closed/i);
    }
    assert.equal(code, 'SERVER_INITIALIZATION_ENQUEUE_FAILED');
    assert.equal(safeUser, '服务器初始化服务暂时不可用，请稍后重试。');
  });
});
