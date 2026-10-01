import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DATABASE_PROVISION_QUEUE,
  DEPLOYMENT_QUEUE,
  REDIS_PROVISION_QUEUE,
  SERVER_PROVISION_QUEUE,
  WORKER_ONLINE_THRESHOLD_MS,
} from './queue';
import {
  isDeploymentCapableWorker,
  isWorkerHeartbeatFresh,
  queuesForWorkerProfile,
  resolveWorkerProfile,
  workerProfileConsumes,
} from './worker-profile';

describe('worker profiles', () => {
  it('defaults to all so the existing dev script keeps every consumer', () => {
    assert.equal(resolveWorkerProfile(undefined), 'all');
    assert.equal(resolveWorkerProfile(''), 'all');
    assert.equal(workerProfileConsumes('all', DEPLOYMENT_QUEUE), true);
    assert.equal(workerProfileConsumes('all', SERVER_PROVISION_QUEUE), true);
    assert.equal(workerProfileConsumes('all', DATABASE_PROVISION_QUEUE), true);
    assert.equal(workerProfileConsumes('all', REDIS_PROVISION_QUEUE), true);
  });

  it('deployment profile consumes deployment and not billable provision queues', () => {
    assert.equal(resolveWorkerProfile('deployment'), 'deployment');
    const queues = queuesForWorkerProfile('deployment');
    assert.ok(queues.includes(DEPLOYMENT_QUEUE));
    assert.equal(queues.includes(SERVER_PROVISION_QUEUE), false);
    assert.equal(queues.includes(DATABASE_PROVISION_QUEUE), false);
    assert.equal(queues.includes(REDIS_PROVISION_QUEUE), false);
  });

  it('provisioning profile is not deployment-capable', () => {
    const queues = queuesForWorkerProfile('provisioning');
    assert.equal(queues.includes(DEPLOYMENT_QUEUE), false);
    assert.equal(workerProfileConsumes('provisioning', SERVER_PROVISION_QUEUE), true);
  });

  it('rejects unknown profiles instead of guessing from NODE_ENV', () => {
    assert.throws(() => resolveWorkerProfile('production'), /WORKER_PROFILE_INVALID/);
  });
});

describe('deployment capability heartbeat', () => {
  const now = Date.parse('2026-09-29T04:00:00.000Z');

  it('treats a fresh ONLINE deployment consumer as capable', () => {
    assert.equal(
      isDeploymentCapableWorker({
        status: 'ONLINE',
        lastSeenAt: new Date(now - 1_000),
        queueReady: { deployment: true },
        now,
      }),
      true,
    );
  });

  it('does not treat a provisioning worker as deployment-capable', () => {
    assert.equal(
      isDeploymentCapableWorker({
        status: 'ONLINE',
        lastSeenAt: new Date(now - 1_000),
        queueReady: { deployment: false },
        now,
      }),
      false,
    );
  });

  it('does not trust a stale ONLINE row past the threshold', () => {
    assert.equal(WORKER_ONLINE_THRESHOLD_MS, 45_000);
    assert.equal(
      isWorkerHeartbeatFresh({
        status: 'ONLINE',
        lastSeenAt: new Date(now - 46_000),
        now,
      }),
      false,
    );
  });

  it('treats an explicit OFFLINE beat as unavailable immediately', () => {
    assert.equal(
      isWorkerHeartbeatFresh({
        status: 'OFFLINE',
        lastSeenAt: new Date(now),
        now,
      }),
      false,
    );
  });
});
