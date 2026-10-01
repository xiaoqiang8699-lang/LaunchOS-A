import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  MANAGED_CONTAINER_RESTART_POLICY,
  RUNTIME_RECOVERY_POLICY,
  reconcileServiceInstanceRuntimeState,
} from './runtime-recovery';

test('running container maps to RUNNING', () => {
  const next = reconcileServiceInstanceRuntimeState({
    observation: { exists: true, running: true },
    healthProbe: 'skipped',
  });
  assert.equal(next.status, 'RUNNING');
});

test('exit 0 maps to STOPPED and not RUNNING', () => {
  const next = reconcileServiceInstanceRuntimeState({
    observation: { exists: true, running: false, exitCode: 0 },
  });
  assert.equal(next.status, 'STOPPED');
  assert.notEqual(next.status, 'RUNNING');
});

test('non-zero exit maps to FAILED and not RUNNING', () => {
  const next = reconcileServiceInstanceRuntimeState({
    observation: { exists: true, running: false, exitCode: 1 },
  });
  assert.equal(next.status, 'FAILED');
  assert.notEqual(next.status, 'RUNNING');
});

test('missing container is not RUNNING', () => {
  const next = reconcileServiceInstanceRuntimeState({
    observation: { exists: false },
  });
  assert.equal(next.status, 'FAILED');
  assert.equal(next.healthStatus, 'UNHEALTHY');
});

test('health fail keeps RUNNING and marks UNHEALTHY', () => {
  const next = reconcileServiceInstanceRuntimeState({
    observation: { exists: true, running: true },
    healthProbe: 'fail',
  });
  assert.equal(next.status, 'RUNNING');
  assert.equal(next.healthStatus, 'UNHEALTHY');
});

test('health recover marks HEALTHY', () => {
  const next = reconcileServiceInstanceRuntimeState({
    observation: { exists: true, running: true },
    healthProbe: 'success',
  });
  assert.equal(next.status, 'RUNNING');
  assert.equal(next.healthStatus, 'HEALTHY');
});

test('new managed deployments use unless-stopped', () => {
  assert.equal(MANAGED_CONTAINER_RESTART_POLICY, 'unless-stopped');
  assert.equal(RUNTIME_RECOVERY_POLICY.restartPolicy, 'unless-stopped');
  assert.equal(RUNTIME_RECOVERY_POLICY.healthReconcile, true);
  const runtimeSource = readFileSync(
    resolve(__dirname, '../../runtime/src/remote-docker-runtime.ts'),
    'utf8',
  );
  assert.match(runtimeSource, /--restart=unless-stopped/);
});

test('explicit stop stays down; crash and reboot are covered by policy', () => {
  assert.equal(RUNTIME_RECOVERY_POLICY.failureClassification.exitZero, 'STOPPED');
  assert.equal(RUNTIME_RECOVERY_POLICY.bootRecovery, 'systemd-oneshot-podman-start-unless-stopped');
  assert.equal(
    RUNTIME_RECOVERY_POLICY.existingContainerRecovery,
    'podman-generate-systemd-on-failure-no-new',
  );
  assert.equal(RUNTIME_RECOVERY_POLICY.maxRestartObservation, 3);
});
