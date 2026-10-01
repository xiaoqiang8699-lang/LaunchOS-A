import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decideCapacityAdmission,
  evaluateDiskWatermark,
  parseCapacityProbeText,
  selectArtifactsForRetention,
  BETA_CAPACITY_DEFAULTS,
} from './capacity-governance.js';

describe('capacity governance', () => {
  it('admits healthy capacity', () => {
    const d = decideCapacityAdmission({
      workerOnline: true,
      queueReady: true,
      snapshot: {
        serverInstanceId: 's1',
        cpuCores: 2,
        memoryTotalMb: 3500,
        memoryAvailableMb: 2000,
        diskTotalMb: 59 * 1024,
        diskFreeMb: 8 * 1024,
        diskUsedPercent: 87,
        runningRuntimeCount: 3,
        activeDeploymentCount: 0,
        activeBuildCount: 0,
        allocatedPortCount: 5,
        probedAt: new Date().toISOString(),
      },
    });
    assert.equal(d.result, 'ADMITTED');
    assert.equal(d.diskWarning, true);
    assert.equal(d.diskCritical, false);
  });

  it('rejects disk critical without leaking internals', () => {
    const d = decideCapacityAdmission({
      workerOnline: true,
      queueReady: true,
      snapshot: {
        serverInstanceId: 's1',
        cpuCores: 2,
        memoryTotalMb: 3500,
        memoryAvailableMb: 2000,
        diskTotalMb: 59 * 1024,
        diskFreeMb: 2 * 1024,
        diskUsedPercent: 95,
        runningRuntimeCount: 1,
        activeDeploymentCount: 0,
        activeBuildCount: 0,
        allocatedPortCount: 1,
        probedAt: new Date().toISOString(),
      },
    });
    assert.equal(d.result, 'REJECTED_CAPACITY');
    assert.equal(d.code, 'CAPACITY_DISK_CRITICAL');
    assert.match(d.userMessage || '', /繁忙|稍后/);
    assert.equal(/OOM|df |loadavg/i.test(d.userMessage || ''), false);
  });

  it('waits when build slots full', () => {
    const d = decideCapacityAdmission({
      workerOnline: true,
      queueReady: true,
      allowWait: true,
      snapshot: {
        serverInstanceId: 's1',
        cpuCores: 2,
        memoryTotalMb: 3500,
        memoryAvailableMb: 2000,
        diskTotalMb: 59 * 1024,
        diskFreeMb: 10 * 1024,
        diskUsedPercent: 80,
        runningRuntimeCount: 2,
        activeDeploymentCount: 1,
        activeBuildCount: BETA_CAPACITY_DEFAULTS.maxConcurrentBuilds,
        allocatedPortCount: 2,
        probedAt: new Date().toISOString(),
      },
    });
    assert.equal(d.result, 'WAITING_CAPACITY');
    assert.equal(d.code, 'CAPACITY_BUILD_SLOTS_FULL');
  });

  it('marks worker unavailable', () => {
    const d = decideCapacityAdmission({
      workerOnline: false,
      queueReady: false,
      snapshot: null,
    });
    assert.equal(d.result, 'WORKER_UNAVAILABLE');
  });

  it('parses free/df probe text', () => {
    const parsed = parseCapacityProbeText(`2
               total        used        free      shared  buff/cache   available
Mem:            3516        1295         927          55        1682        2221
/dev/vda3        59G   49G  7.5G  87% /
`);
    assert.equal(parsed.cpuCores, 2);
    assert.equal(parsed.memoryTotalMb, 3516);
    assert.equal(parsed.memoryAvailableMb, 2221);
    assert.equal(parsed.diskUsedPercent, 87);
    assert.ok((parsed.diskFreeMb || 0) > 7000);
  });

  it('selects artifacts for retention', () => {
    const now = Date.now();
    const rows = [
      { id: 'c', deploymentId: 'd0', type: 'DOCKER_IMAGE', status: 'READY', createdAt: new Date(now), isCurrent: true, deploymentStatus: 'SUCCESS' },
      { id: 's1', deploymentId: 'd1', type: 'DOCKER_IMAGE', status: 'READY', createdAt: new Date(now - 1), deploymentStatus: 'SUCCESS' },
      { id: 's2', deploymentId: 'd2', type: 'DOCKER_IMAGE', status: 'READY', createdAt: new Date(now - 2), deploymentStatus: 'SUCCESS' },
      { id: 's3', deploymentId: 'd3', type: 'DOCKER_IMAGE', status: 'READY', createdAt: new Date(now - 3), deploymentStatus: 'SUCCESS' },
      { id: 's4', deploymentId: 'd4', type: 'DOCKER_IMAGE', status: 'READY', createdAt: new Date(now - 4), deploymentStatus: 'SUCCESS' },
      { id: 'f1', deploymentId: 'd5', type: 'DOCKER_IMAGE', status: 'READY', createdAt: new Date(now - 5), deploymentStatus: 'FAILED' },
      { id: 'f2', deploymentId: 'd6', type: 'DOCKER_IMAGE', status: 'READY', createdAt: new Date(now - 6), deploymentStatus: 'FAILED' },
      { id: 'f3', deploymentId: 'd7', type: 'DOCKER_IMAGE', status: 'READY', createdAt: new Date(now - 7), deploymentStatus: 'FAILED' },
    ];
    const { keepIds, gcIds } = selectArtifactsForRetention({ artifacts: rows, retainSuccess: 3, retainFailed: 2 });
    assert.ok(keepIds.includes('c'));
    assert.ok(keepIds.includes('s1'));
    assert.ok(gcIds.includes('s4'));
    assert.ok(gcIds.includes('f3'));
    assert.ok(!gcIds.includes('f1'));
  });

  it('evaluates disk watermark', () => {
    assert.equal(evaluateDiskWatermark({ diskFreeMb: 5000, diskUsedPercent: 90 }).critical, false);
    assert.equal(evaluateDiskWatermark({ diskFreeMb: 3000, diskUsedPercent: 94 }).critical, true);
  });
});
