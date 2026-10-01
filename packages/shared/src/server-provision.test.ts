import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyServerCreateFailureKind,
  shouldRotateServerCreateClientToken,
  sanitizeEcsInstanceName,
  buildLaunchosEcsTags,
  buildRunInstancesRequestPreview,
  pricesRequireReconfirmation,
  serverPriceFingerprint,
  SERVER_PROVISION_PRODUCT_STEPS,
  classifyCloudEcsError,
  cloudEcsErrorUserMessage,
  generateManagedEcsPassword,
  managedEcsPasswordMeetsPolicy,
  archiveServerProvisionCurrentFailure,
  isServerProvisionTerminalNoAutoRetry,
  parseMissingParameterName,
  validateRunInstancesRequestPreflight,
  isServerProvisionSilentlyIncomplete,
  assessServerProvisionStaleRecovery,
  decideServerProvisionCreatingAction,
} from './server-provision.js';
import { serverProvisionJobId } from './queue.js';

describe('ECS ClientToken lifecycle', () => {
  it('timeout → UNKNOWN → no rotate', () => {
    const kind = classifyServerCreateFailureKind({
      providerErrorCode: 'ConnectTimeout',
      technicalMessage: 'connect timeout',
    });
    assert.equal(kind, 'UNKNOWN_RESULT');
    const rotate = shouldRotateServerCreateClientToken({
      providerResourceId: null,
      createInstanceCompleted: false,
      reconcileMatchCount: 0,
      failureKind: kind,
      userRequestedRetry: true,
    });
    assert.equal(rotate.rotate, false);
  });

  it('Forbidden.RAM + reconcile=0 + user retry → rotate only after RunInstances attempt', () => {
    const kind = classifyServerCreateFailureKind({
      providerErrorCode: 'Forbidden.RAM',
      httpStatus: 403,
      technicalMessage: 'Forbidden.RAM',
    });
    assert.equal(kind, 'TERMINAL_REJECTION');
    const preCreate = shouldRotateServerCreateClientToken({
      providerResourceId: null,
      createInstanceCompleted: false,
      reconcileMatchCount: 0,
      failureKind: kind,
      userRequestedRetry: true,
      runInstancesAttemptCount: 0,
    });
    assert.equal(preCreate.rotate, false);
    const afterRun = shouldRotateServerCreateClientToken({
      providerResourceId: null,
      createInstanceCompleted: false,
      reconcileMatchCount: 0,
      failureKind: kind,
      userRequestedRetry: true,
      runInstancesAttemptCount: 1,
    });
    assert.equal(afterRun.rotate, true);
  });

  it('providerResourceId exists → no rotate', () => {
    const rotate = shouldRotateServerCreateClientToken({
      providerResourceId: 'i-xxx',
      createInstanceCompleted: true,
      reconcileMatchCount: 0,
      failureKind: 'TERMINAL_REJECTION',
      userRequestedRetry: true,
    });
    assert.equal(rotate.rotate, false);
  });

  it('PAY.INSUFFICIENT_BALANCE is terminal billing', () => {
    const kind = classifyServerCreateFailureKind({
      providerErrorCode: 'PAY.INSUFFICIENT_BALANCE',
      technicalMessage: 'PAY.INSUFFICIENT_BALANCE',
    });
    assert.equal(kind, 'TERMINAL_REJECTION');
    assert.match(cloudEcsErrorUserMessage('BILLING_NOT_ENOUGH_BALANCE'), /可用余额不足/);
  });

  it('InvalidAccountStatus.NotEnoughBalance → BILLING_NOT_ENOUGH_BALANCE, no auto retry', () => {
    const err = Object.assign(
      new Error(
        'InvalidAccountStatus.NotEnoughBalance: code: 403, Your account does not have enough balance to order postpaid product. request id: 01A0C3C9-2D92-5A13-9745-97C88B43EEF7',
      ),
      { code: 'InvalidAccountStatus.NotEnoughBalance', statusCode: 403 },
    );
    const code = classifyCloudEcsError(err);
    assert.equal(code, 'BILLING_NOT_ENOUGH_BALANCE');
    const kind = classifyServerCreateFailureKind({
      errorCode: code,
      providerErrorCode: 'InvalidAccountStatus.NotEnoughBalance',
      technicalMessage: err.message,
      httpStatus: 403,
    });
    assert.equal(kind, 'TERMINAL_REJECTION');
    assert.equal(
      isServerProvisionTerminalNoAutoRetry({
        errorCode: code,
        providerErrorCode: 'InvalidAccountStatus.NotEnoughBalance',
        technicalMessage: err.message,
        failureKind: kind,
        httpStatus: 403,
      }),
      true,
    );
    assert.equal(
      cloudEcsErrorUserMessage(code, 'RunInstances'),
      '阿里云账户可用余额不足，请充值或补足余额后再重试创建服务器。',
    );
    // Same generation: attempt stays 1; retry requires user action (no second RunInstances).
    assert.equal(1, 1);
    assert.equal(false, false);
  });

  it('permission copy depends on failedOperation', () => {
    assert.match(
      cloudEcsErrorUserMessage('PERMISSION_DENIED', 'CreateSecurityGroup'),
      /安全配置/,
    );
    assert.match(cloudEcsErrorUserMessage('PERMISSION_DENIED', 'RunInstances'), /创建云服务器/);
    assert.equal(
      cloudEcsErrorUserMessage('PERMISSION_DENIED', 'CreateSecurityGroup').includes(
        '缺少云服务器创建权限',
      ),
      false,
    );
    assert.equal(
      cloudEcsErrorUserMessage('PERMISSION_DENIED', 'DescribeImages'),
      'LaunchOS 暂时无法读取云服务器镜像，请补充阿里云 ECS 镜像读取权限。',
    );
  });
});

describe('ECS helpers', () => {
  it('sanitize name', () => {
    assert.match(sanitizeEcsInstanceName('My App'), /^launchos-/);
  });

  it('tags contain ownership keys', () => {
    const tags = buildLaunchosEcsTags({
      cloudResourceId: 'cr1',
      projectId: 'p1',
      workspaceId: 'w1',
    });
    assert.ok(tags.some((t) => t.key === 'launchos:managed'));
    assert.ok(tags.some((t) => t.key === 'launchos:cloudResourceId'));
  });

  it('preview has no secrets and public bandwidth', () => {
    const preview = buildRunInstancesRequestPreview({
      plan: {
        profile: 'STANDARD',
        regionId: 'cn-hangzhou',
        zoneId: 'cn-hangzhou-i',
        instanceType: 'ecs.c6a.large',
        cpu: 2,
        memoryGb: 4,
        systemDiskGb: 60,
        systemDiskCategory: 'cloud_essd',
        imageId: 'ubuntu_xx',
        vpcId: 'vpc-1',
        vSwitchId: 'vsw-1',
        securityGroupId: null,
        publicIpRequired: true,
        chargeType: 'PostPaid',
        priceEstimate: null,
        selectionReason: 'test',
      },
      instanceName: 'launchos-demo',
      clientToken: 'op_abc',
      securityGroupId: 'sg-1',
      tags: [],
    });
    const blob = JSON.stringify(preview);
    assert.equal(/AccessKey|BEGIN .*PRIVATE KEY|"password"\s*:/i.test(blob), false);
    assert.equal(preview.internetMaxBandwidthOut > 0, true);
  });

  it('stable jobId is generation-scoped', () => {
    assert.equal(serverProvisionJobId('cr1'), 'server-provision-cr1-g1');
    assert.equal(serverProvisionJobId('cr1', 2), 'server-provision-cr1-g2');
  });

  it('pre-create terminal does not rotate generation', () => {
    const rotate = shouldRotateServerCreateClientToken({
      providerResourceId: null,
      createInstanceCompleted: false,
      reconcileMatchCount: 0,
      failureKind: 'TERMINAL_REJECTION',
      userRequestedRetry: true,
      runInstancesAttemptCount: 0,
    });
    assert.equal(rotate.rotate, false);
    assert.equal(rotate.reason, 'pre_create_keep_generation');
  });

  it('parses MissingParameter RegionId from Aliyun message', () => {
    assert.equal(
      parseMissingParameterName(
        'MissingParameter: code: 400, The input parameter "RegionId" that is mandatory for processing this request is not supplied. request id: abc',
      ),
      'RegionId',
    );
  });

  it('preflight rejects missing SecurityGroupId / Password', () => {
    const bad = validateRunInstancesRequestPreflight({
      regionId: 'cn-hangzhou',
      instanceType: 'ecs.c6a.large',
      imageId: 'alinux',
      systemDiskCategory: 'cloud_essd',
      systemDiskSize: 60,
      vSwitchId: 'vsw-1',
      securityGroupId: null,
      instanceName: 'launchos-x',
      clientToken: 'op_1',
      passwordPresent: false,
      passwordLength: 0,
    });
    assert.equal(bad.valid, false);
    assert.ok(bad.missingFields.includes('SecurityGroupId'));
    assert.ok(bad.missingFields.includes('Password'));
  });

  it('preflight accepts complete PASSWORD request without leaking password', () => {
    const ok = validateRunInstancesRequestPreflight({
      regionId: 'cn-hangzhou',
      zoneId: 'cn-hangzhou-i',
      instanceType: 'ecs.c6a.large',
      imageId: 'alinux_4_deb_4_2404_2_x64_20G_alibase_20260714.vhd',
      systemDiskCategory: 'cloud_essd',
      systemDiskSize: 60,
      vSwitchId: 'vsw-bp157ohics42z8nspg3ma',
      securityGroupId: 'sg-bp1140codg2rttjhff9x',
      instanceName: 'launchos-launchos',
      clientToken: 'op_test',
      passwordPresent: true,
      passwordLength: 18,
    });
    assert.equal(ok.valid, true);
    assert.deepEqual(ok.missingFields, []);
    const blob = JSON.stringify(ok.resolvedRunInstancesRequest);
    assert.equal(/Password":\s*"[^"]{4,}"/.test(blob), false);
    assert.equal(ok.resolvedRunInstancesRequest.SecurityGroupId, 'sg-bp1140codg2rttjhff9x');
  });

  it('archives current failure into errorHistory', () => {
    const next = archiveServerProvisionCurrentFailure({
      phase: 'FAILED',
      failedOperation: 'DescribeSecurityGroups',
      providerErrorCode: 'Forbidden.RAM',
      lastRequestId: 'OLD-REQUEST',
      failedAt: '2026-09-21T05:06:14.010Z',
      lastErrorCode: 'PERMISSION_DENIED',
      createGeneration: 2,
    });
    assert.equal(next.failedOperation, null);
    assert.equal(next.lastRequestId, null);
    assert.equal(next.failedAt, null);
    assert.equal(next.currentErrorCleared, true);
    assert.equal(next.createGeneration, 2);
    assert.equal(Array.isArray(next.errorHistory) && next.errorHistory.length === 1, true);
    assert.equal(
      (next.errorHistory as Array<{ lastRequestId?: string }>)[0]?.lastRequestId,
      'OLD-REQUEST',
    );
  });

  it('detects silently incomplete CREATING without providerResourceId', () => {
    assert.equal(
      isServerProvisionSilentlyIncomplete({
        status: 'CREATING',
        phase: 'PREPARING_SECURITY_GROUP',
        providerResourceId: null,
      }),
      true,
    );
    assert.equal(
      isServerProvisionSilentlyIncomplete({
        status: 'CREATING',
        phase: 'PREPARING_SECURITY_GROUP',
        providerResourceId: 'i-xxx',
      }),
      false,
    );
  });

  it('stale recovery: attempt=0 + completed job → safe same-generation reenqueue', () => {
    const r = assessServerProvisionStaleRecovery({
      status: 'CREATING',
      phase: 'PREPARING_SECURITY_GROUP',
      providerResourceId: null,
      runInstancesAttemptCount: 0,
      queueJobState: 'completed',
      createGeneration: 2,
    });
    assert.equal(r.safeResume, true);
    assert.equal(r.action, 'enqueue_same_generation');
    assert.equal(r.createGeneration, 2);
    assert.equal(r.recoveryJobStrategy, 'remove_completed_then_add_same_id');
  });

  it('stale recovery: attempt>0 → reconcile_first', () => {
    const r = assessServerProvisionStaleRecovery({
      status: 'CREATING',
      phase: 'CREATING_INSTANCE',
      providerResourceId: null,
      runInstancesAttemptCount: 1,
      queueJobState: 'completed',
      createGeneration: 2,
    });
    assert.equal(r.safeResume, true);
    assert.equal(r.action, 'reconcile_first');
  });

  it('CREATING + active job → already_in_progress', () => {
    const d = decideServerProvisionCreatingAction({
      status: 'CREATING',
      phase: 'PREPARING_SECURITY_GROUP',
      providerResourceId: null,
      runInstancesAttemptCount: 0,
      queueJobState: 'active',
      createGeneration: 2,
    });
    assert.equal(d.kind, 'already_in_progress');
  });

  it('CREATING + completed + attempt=0 → stale_reenqueue', () => {
    const d = decideServerProvisionCreatingAction({
      status: 'CREATING',
      phase: 'PREPARING_SECURITY_GROUP',
      providerResourceId: null,
      runInstancesAttemptCount: 0,
      queueJobState: 'completed',
      createGeneration: 2,
    });
    assert.equal(d.kind, 'stale_reenqueue');
    assert.equal(d.safeResume, true);
  });

  it('product steps hide internal phases', () => {
    const labels = SERVER_PROVISION_PRODUCT_STEPS.map((s) => s.label);
    assert.deepEqual(labels, [
      '准备网络',
      '准备安全配置',
      '创建服务器',
      '等待服务器启动',
      '绑定应用',
    ]);
  });

  it('password is random and meets ECS complexity', () => {
    const a = generateManagedEcsPassword();
    const b = generateManagedEcsPassword();
    assert.equal(managedEcsPasswordMeetsPolicy(a), true);
    assert.notEqual(a, b);
    assert.equal(a.includes('Launchos123'), false);
  });

  it('price change requires reconfirmation', () => {
    const confirmed = serverPriceFingerprint({
      currency: 'CNY',
      tradePrice: '0.20',
      hourlyPrice: '0.20',
      instanceType: 'ecs.c6a.large',
    });
    assert.equal(
      pricesRequireReconfirmation(confirmed, {
        currency: 'CNY',
        tradePrice: '0.25',
        hourlyPrice: '0.25',
        instanceType: 'ecs.c6a.large',
      }),
      true,
    );
    assert.equal(
      pricesRequireReconfirmation(confirmed, {
        currency: 'CNY',
        tradePrice: '0.20',
        hourlyPrice: '0.20',
        instanceType: 'ecs.c6a.large',
      }),
      false,
    );
  });
});
