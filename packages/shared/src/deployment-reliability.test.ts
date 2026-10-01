import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACTIVE_DEPLOYMENT_STATUSES,
  appendStageHistory,
  beginStageRecord,
  classifyDeploymentFailure,
  decidePostSwitchRollback,
  decideTrafficSwitch,
  deploymentRequestIdempotencyKey,
  deploymentStageIdempotencyKey,
  detectGatewayRouteDrift,
  environmentDeploymentLockKey,
  finishStageRecord,
  formatReadableReleaseLabel,
  isActiveDeploymentStatus,
  isTransientDeploymentFailure,
  planReleasePointers,
  planRollbackTarget,
  reconcileStaleRunningDecision,
  shouldAutoRetryDeploymentFailure,
  shouldCleanupOldRuntime,
  sanitizeDeploymentFailureDetail,
} from './deployment-reliability.js';

describe('deployment reliability', () => {
  it('builds env lock and stage idempotency keys', () => {
    assert.equal(environmentDeploymentLockKey('p1', 'e1'), 'deployment-env:p1:e1');
    assert.equal(
      deploymentStageIdempotencyKey({ deploymentId: 'd1', stage: 'BUILDING', attempt: 2 }),
      'deploy-stage:d1:BUILDING:2',
    );
    assert.equal(
      deploymentRequestIdempotencyKey({ projectId: 'p', environmentId: 'e', clientKey: ' abc ' }),
      'deploy-req:p:e:abc',
    );
  });

  it('rejects duplicate active statuses', () => {
    assert.deepEqual(ACTIVE_DEPLOYMENT_STATUSES, ['CREATED', 'QUEUED', 'RUNNING']);
    assert.equal(isActiveDeploymentStatus('RUNNING'), true);
    assert.equal(isActiveDeploymentStatus('SUCCESS'), false);
  });

  it('records stage timestamps', () => {
    const started = beginStageRecord('BUILDING', new Date('2026-09-29T07:00:00.000Z'));
    const finished = finishStageRecord(started, 'FAILED', {
      errorCode: 'BUILD_FAILED',
      now: new Date('2026-09-29T07:00:05.000Z'),
    });
    assert.equal(finished.durationMs, 5000);
    assert.equal(finished.errorCode, 'BUILD_FAILED');
    const history = appendStageHistory([], finished);
    assert.equal(history.length, 1);
  });

  it('classifies failures and retry policy', () => {
    assert.equal(classifyDeploymentFailure('npm ERR! build failed').code, 'BUILD_FAILED');
    assert.equal(classifyDeploymentFailure('SSH handshake timeout').code, 'SSH_CONNECTION_FAILED');
    assert.equal(classifyDeploymentFailure('health check timeout').code, 'RUNTIME_HEALTHCHECK_FAILED');
    assert.equal(shouldAutoRetryDeploymentFailure('BUILD_FAILED'), false);
    assert.equal(shouldAutoRetryDeploymentFailure('SSH_CONNECTION_FAILED'), true);
    assert.equal(isTransientDeploymentFailure('ARTIFACT_UPLOAD_FAILED'), true);
  });

  it('redacts secrets in failure detail', () => {
    const safe = sanitizeDeploymentFailureDetail('password=super-secret TOKEN=abc DATABASE_URL=postgres://a:b@h/db');
    assert.equal(safe.includes('super-secret'), false);
  });

  it('plans release pointers and rollback target', () => {
    const first = planReleasePointers({
      activeDeploymentId: null,
      previousDeploymentId: null,
      nextSuccessfulDeploymentId: 'A',
    });
    assert.deepEqual(first, { activeDeploymentId: 'A', previousDeploymentId: null });
    const second = planReleasePointers({
      activeDeploymentId: 'A',
      previousDeploymentId: null,
      nextSuccessfulDeploymentId: 'C',
    });
    assert.deepEqual(second, { activeDeploymentId: 'C', previousDeploymentId: 'A' });
    const rb = planRollbackTarget(second);
    assert.equal(rb.ok, true);
    if (rb.ok) assert.equal(rb.toDeploymentId, 'A');
  });

  it('gates traffic switch and post-switch rollback', () => {
    assert.equal(
      decideTrafficSwitch({
        candidateHealthy: true,
        publicEntryReady: true,
        tlsOrDnsReady: true,
      }).canSwitch,
      true,
    );
    assert.equal(
      decideTrafficSwitch({
        candidateHealthy: false,
        publicEntryReady: true,
        tlsOrDnsReady: true,
      }).canSwitch,
      false,
    );
    assert.equal(
      decidePostSwitchRollback({
        publicHealthy: false,
        previousTarget: { host: '127.0.0.1', port: 39001 },
      }).action,
      'rollback_route',
    );
    assert.equal(
      decidePostSwitchRollback({ publicHealthy: true, previousTarget: null }).action,
      'keep',
    );
  });

  it('defers old runtime cleanup during grace window', () => {
    assert.equal(
      shouldCleanupOldRuntime({
        switchedAt: new Date().toISOString(),
        graceMs: 600_000,
      }),
      false,
    );
    assert.equal(
      shouldCleanupOldRuntime({
        switchedAt: new Date(Date.now() - 700_000).toISOString(),
        graceMs: 600_000,
      }),
      true,
    );
  });

  it('detects gateway drift and stale running decisions', () => {
    assert.equal(
      detectGatewayRouteDrift({
        desired: { hostname: 'a.example.com', targetHost: '127.0.0.1', targetPort: 39001 },
        actual: { hostname: 'a.example.com', targetHost: '127.0.0.1', targetPort: 39002 },
      }).drifted,
      true,
    );
    assert.equal(
      reconcileStaleRunningDecision({
        status: 'RUNNING',
        lastActivityAt: new Date(Date.now() - 120_000),
        hasActiveJob: false,
        leaseExpired: true,
        observed: 'missing',
      }).action,
      'fail',
    );
    assert.equal(
      reconcileStaleRunningDecision({
        status: 'RUNNING',
        lastActivityAt: new Date(),
        hasActiveJob: false,
        leaseExpired: true,
        observed: 'unknown',
      }).action,
      'requeue',
    );
  });

  it('formats readable release labels', () => {
    assert.match(
      formatReadableReleaseLabel({
        createdAt: '2026-09-29T07:30:00.000Z',
        sequence: 12,
      }),
      /^v2026\.09\.29-0730 \(#12\)$/,
    );
  });
});
