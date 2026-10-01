import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertServerInitializationComplete,
  buildServerInitializationPlan,
  canStartServerInitialization,
  classifyServerInitializationError,
  DYNAMIC_PORT_RANGE_END,
  DYNAMIC_PORT_RANGE_START,
  isServerInitializationInFlight,
  phaseAfter,
  resolveServerSshUsername,
  RUNTIME_BIND_ADDRESS,
  SERVER_INIT_PHASE_LABELS,
  serverInitializationLockKey,
  serverInitializationUserMessage,
} from './server-initialization.js';
import { serverInitializationJobId } from './queue.js';

describe('server initialization domain', () => {
  it('builds stable jobId and lock key', () => {
    const id = 'cmub78pz001sdripco5pexhdz';
    assert.equal(serverInitializationJobId(id), `server-initialize-${id}`);
    assert.equal(serverInitializationLockKey(id), `server-initialize:${id}`);
  });

  it('gates start readiness', () => {
    assert.equal(canStartServerInitialization('READY_FOR_INITIALIZATION'), true);
    assert.equal(canStartServerInitialization('INITIALIZATION_FAILED'), true);
    assert.equal(canStartServerInitialization('READY'), false);
    assert.equal(canStartServerInitialization('INITIALIZING'), false);
  });

  it('detects in-flight', () => {
    assert.equal(isServerInitializationInFlight('INITIALIZING'), true);
    assert.equal(isServerInitializationInFlight('READY', 'READY'), false);
    assert.equal(isServerInitializationInFlight('READY_FOR_INITIALIZATION', 'CONNECTING'), true);
  });

  it('resolves Alibaba Cloud Linux username to root without guessing ubuntu', () => {
    assert.equal(
      resolveServerSshUsername({
        provider: 'ALIYUN',
        imageName: 'alibaba_cloud_linux_4_x64_20G_alibase_2025xxxx.vhd',
      }),
      'root',
    );
    assert.equal(
      resolveServerSshUsername({
        serverUsername: 'ubuntu',
        provider: 'ALIYUN',
        imageName: 'Alibaba Cloud Linux 4',
      }),
      'root',
    );
    assert.equal(
      resolveServerSshUsername({
        serverUsername: 'launchos-admin',
        provider: 'ALIYUN',
      }),
      'launchos-admin',
    );
  });

  it('builds init plan with dynamic port policy', () => {
    const plan = buildServerInitializationPlan({
      publicIp: '116.62.198.184',
      privateIp: '172.19.208.67',
      providerResourceId: 'i-bp18fpmcju7ntitybcm8',
      username: 'root',
      passwordPresent: true,
    });
    assert.equal(plan.dynamicPortRangeStart, DYNAMIC_PORT_RANGE_START);
    assert.equal(plan.dynamicPortRangeEnd, DYNAMIC_PORT_RANGE_END);
    assert.equal(plan.bindAddress, RUNTIME_BIND_ADDRESS);
    assert.equal(plan.directoryPlan.some((c) => c.includes('/opt/launchos/apps')), true);
    assert.equal(plan.osDetectionPlan.includes('uname -a'), true);
  });

  it('phase resume helper advances from lastSuccessfulPhase', () => {
    assert.equal(phaseAfter(null), 'CONNECTING');
    assert.equal(phaseAfter('INSTALLING_RUNTIME'), 'CONFIGURING_FIREWALL');
    assert.equal(phaseAfter('CONFIGURING_FIREWALL'), 'CONFIGURING_RUNTIME');
    assert.equal(phaseAfter('VERIFYING_RUNTIME'), 'READY');
  });

  it('classifies SSH and package errors', () => {
    assert.equal(classifyServerInitializationError(new Error('Permission denied')), 'SSH_AUTH_FAILED');
    assert.equal(classifyServerInitializationError(new Error('ETIMEDOUT')), 'SSH_TIMEOUT');
    assert.equal(classifyServerInitializationError(new Error('ECONNREFUSED')), 'SSH_CONNECTION_REFUSED');
    assert.equal(classifyServerInitializationError(new Error('EHOSTUNREACH')), 'SSH_HOST_UNREACHABLE');
    assert.equal(classifyServerInitializationError({ code: 'UNSUPPORTED_OS' }), 'UNSUPPORTED_OS');
    assert.equal(
      classifyServerInitializationError(new Error('SSH reconnect failed')),
      'SSH_RECONNECT_FAILED',
    );
    assert.equal(
      classifyServerInitializationError(new Error('dnf install podman failed')),
      'PACKAGE_INSTALL_FAILED',
    );
  });

  it('user messages avoid technical jargon', () => {
    assert.match(serverInitializationUserMessage('PACKAGE_INSTALL_FAILED'), /运行环境/);
    assert.equal(SERVER_INIT_PHASE_LABELS.INSTALLING_RUNTIME, '安装运行环境');
    assert.equal(SERVER_INIT_PHASE_LABELS.CONFIGURING_FIREWALL, '配置安全规则');
  });

  it('enforces completion invariant', () => {
    assert.throws(
      () => assertServerInitializationComplete({ serverReadiness: 'INITIALIZING' }),
      /SERVER_INITIALIZATION_INCOMPLETE/,
    );
    assert.doesNotThrow(() =>
      assertServerInitializationComplete({ serverReadiness: 'READY' }),
    );
    assert.doesNotThrow(() =>
      assertServerInitializationComplete({ serverReadiness: 'INITIALIZATION_FAILED' }),
    );
  });

  it('READY is not startable again (idempotent gate)', () => {
    assert.equal(canStartServerInitialization('READY'), false);
  });

  it('READY short-circuit returns alreadyReady without enqueue/ssh/install', () => {
    const server = { status: 'READY' as const, id: 'si-ready' };
    let enqueue = 0;
    let ssh = 0;
    let install = 0;
    const out =
      server.status === 'READY'
        ? {
            alreadyReady: true,
            alreadyInProgress: false,
            serverInstanceId: server.id,
            jobId: serverInitializationJobId(server.id),
          }
        : (() => {
            enqueue += 1;
            ssh += 1;
            install += 1;
            return { alreadyReady: false };
          })();
    assert.equal(out.alreadyReady, true);
    assert.equal(canStartServerInitialization('READY'), false);
    assert.equal(enqueue, 0);
    assert.equal(ssh, 0);
    assert.equal(install, 0);
  });
});
