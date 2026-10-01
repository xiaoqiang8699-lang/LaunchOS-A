import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AlibabaCloudCapabilityService,
  classifyEcsImageReadProbeError,
  probeEcsImageRead,
} from './alibaba-cloud-capability-service';

const redisActions = {
  read: 'READY' as const,
  resource: 'READY' as const,
  create: 'READY' as const,
  delete: 'READY' as const,
  networkManage: 'READY' as const,
  accountManage: 'READY' as const,
  price: 'READY' as const,
};

const billingReady = {
  status: 'READY' as const,
  actions: { order: 'READY' as const, accountBalance: 'UNKNOWN' as const },
};

describe('AlibabaCloudCapabilityService.isRdsCreateBlocked', () => {
  const service = new AlibabaCloudCapabilityService();

  it('blocks when credentials missing', () => {
    assert.equal(
      service.isRdsCreateBlocked({
        provider: 'ALIYUN',
        credentialsConfigured: false,
        region: 'cn-hangzhou',
        BILLING_ORDER_PERMISSION: 'NOT_CONFIGURED',
        capabilities: {
          dns: { status: 'NOT_CONFIGURED' },
          ecs: { status: 'NOT_CONFIGURED' },
          rds: {
            status: 'NOT_CONFIGURED',
            actions: {
              read: 'NOT_CONFIGURED',
              create: 'NOT_CONFIGURED',
              databaseManage: 'NOT_CONFIGURED',
              accountManage: 'NOT_CONFIGURED',
              networkManage: 'NOT_CONFIGURED',
              delete: 'NOT_CONFIGURED',
            },
          },
          redis: {
            status: 'NOT_CONFIGURED',
            actions: {
              read: 'NOT_CONFIGURED',
              resource: 'NOT_CONFIGURED',
              create: 'NOT_CONFIGURED',
              delete: 'NOT_CONFIGURED',
              networkManage: 'NOT_CONFIGURED',
              accountManage: 'NOT_CONFIGURED',
              price: 'NOT_CONFIGURED',
            },
          },
          billing: { status: 'NOT_CONFIGURED', actions: { order: 'NOT_CONFIGURED' } },
          vpc: { status: 'NOT_CONFIGURED' },
        },
        labels: [],
      }),
      true,
    );
  });

  it('blocks when create is MISSING_PERMISSION', () => {
    assert.equal(
      service.isRdsCreateBlocked({
        provider: 'ALIYUN',
        credentialsConfigured: true,
        region: 'cn-hangzhou',
        BILLING_ORDER_PERMISSION: 'READY',
        capabilities: {
          dns: { status: 'UNKNOWN' },
          ecs: { status: 'READY' },
          rds: {
            status: 'MISSING_PERMISSION',
            actions: {
              read: 'READY',
              create: 'MISSING_PERMISSION',
              databaseManage: 'READY',
              accountManage: 'READY',
              networkManage: 'READY',
              delete: 'MISSING_PERMISSION',
            },
          },
          redis: { status: 'READY', actions: redisActions },
          billing: billingReady,
          vpc: { status: 'READY' },
        },
        labels: [],
      }),
      true,
    );
  });

  it('does not block UNKNOWN create (allow try)', () => {
    assert.equal(
      service.isRdsCreateBlocked({
        provider: 'ALIYUN',
        credentialsConfigured: true,
        region: 'cn-hangzhou',
        BILLING_ORDER_PERMISSION: 'UNKNOWN',
        capabilities: {
          dns: { status: 'UNKNOWN' },
          ecs: { status: 'UNKNOWN' },
          rds: {
            status: 'UNKNOWN',
            actions: {
              read: 'READY',
              create: 'UNKNOWN',
              databaseManage: 'READY',
              accountManage: 'READY',
              networkManage: 'READY',
              delete: 'UNKNOWN',
            },
          },
          redis: {
            status: 'UNKNOWN',
            actions: { ...redisActions, create: 'UNKNOWN', delete: 'UNKNOWN' },
          },
          billing: { status: 'UNKNOWN', actions: { order: 'UNKNOWN' } },
          vpc: { status: 'UNKNOWN' },
        },
        labels: [],
      }),
      false,
    );
  });

  it('allows READY create', () => {
    assert.equal(
      service.isRdsCreateBlocked({
        provider: 'ALIYUN',
        credentialsConfigured: true,
        region: 'cn-hangzhou',
        BILLING_ORDER_PERMISSION: 'READY',
        capabilities: {
          dns: { status: 'UNKNOWN' },
          ecs: { status: 'READY' },
          rds: {
            status: 'READY',
            actions: {
              read: 'READY',
              create: 'READY',
              databaseManage: 'READY',
              accountManage: 'READY',
              networkManage: 'READY',
              delete: 'READY',
            },
          },
          redis: { status: 'READY', actions: redisActions },
          billing: billingReady,
          vpc: { status: 'READY' },
        },
        labels: [],
      }),
      false,
    );
  });
});

describe('AlibabaCloudCapabilityService.isRedisCreateBlocked', () => {
  const service = new AlibabaCloudCapabilityService();

  it('blocks redis MISSING_PERMISSION', () => {
    assert.equal(
      service.isRedisCreateBlocked({
        provider: 'ALIYUN',
        credentialsConfigured: true,
        region: 'cn-hangzhou',
        BILLING_ORDER_PERMISSION: 'READY',
        capabilities: {
          dns: { status: 'UNKNOWN' },
          ecs: { status: 'READY' },
          rds: { status: 'READY' },
          redis: {
            status: 'MISSING_PERMISSION',
            actions: { ...redisActions, create: 'MISSING_PERMISSION' },
          },
          billing: billingReady,
          vpc: { status: 'READY' },
        },
        labels: [],
      }),
      true,
    );
  });

  it('allows redis UNKNOWN', () => {
    assert.equal(
      service.isRedisCreateBlocked({
        provider: 'ALIYUN',
        credentialsConfigured: true,
        region: 'cn-hangzhou',
        BILLING_ORDER_PERMISSION: 'READY',
        capabilities: {
          dns: { status: 'UNKNOWN' },
          ecs: { status: 'READY' },
          rds: { status: 'READY' },
          redis: {
            status: 'UNKNOWN',
            actions: { ...redisActions, create: 'UNKNOWN' },
          },
          billing: billingReady,
          vpc: { status: 'READY' },
        },
        labels: [],
      }),
      false,
    );
  });
});

describe('AlibabaCloudCapabilityService.isBillingOrderBlocked', () => {
  const service = new AlibabaCloudCapabilityService();

  it('blocks when BSS order permission missing', () => {
    assert.equal(
      service.isBillingOrderBlocked({
        provider: 'ALIYUN',
        credentialsConfigured: true,
        region: 'cn-hangzhou',
        BILLING_ORDER_PERMISSION: 'MISSING_PERMISSION',
        capabilities: {
          dns: { status: 'UNKNOWN' },
          ecs: { status: 'READY' },
          rds: { status: 'READY' },
          redis: { status: 'READY', actions: redisActions },
          billing: {
            status: 'MISSING_PERMISSION',
            actions: { order: 'MISSING_PERMISSION' },
          },
          vpc: { status: 'READY' },
        },
        labels: [],
      }),
      true,
    );
  });

  it('does not block when READY', () => {
    assert.equal(
      service.isBillingOrderBlocked({
        provider: 'ALIYUN',
        credentialsConfigured: true,
        region: 'cn-hangzhou',
        BILLING_ORDER_PERMISSION: 'READY',
        capabilities: {
          dns: { status: 'UNKNOWN' },
          ecs: { status: 'READY' },
          rds: { status: 'READY' },
          redis: { status: 'READY', actions: redisActions },
          billing: billingReady,
          vpc: { status: 'READY' },
        },
        labels: [],
      }),
      false,
    );
  });
});

describe('ecs.imageRead (DescribeImages)', () => {
  function gateFromImageRead(
    imageRead: 'READY' | 'MISSING_PERMISSION' | 'ERROR',
    imageIdPresent: boolean,
  ) {
    const blockers: string[] = [];
    if (imageRead !== 'READY') blockers.push('ecs:DescribeImages');
    if (!imageIdPresent) blockers.push('系统镜像未就绪');
    return {
      allReady: blockers.length === 0,
      canCreate: blockers.length === 0,
      blockers,
      runInstances: 0,
    };
  }

  it('DescribeImages Forbidden.RAM → MISSING_PERMISSION → allReady false', async () => {
    const imageRead = await probeEcsImageRead(async () => {
      throw Object.assign(new Error('Forbidden.RAM: This action is forbidden by RAM.'), {
        data: { Code: 'Forbidden.RAM', Message: 'This action is forbidden by RAM.' },
      });
    }, 'cn-hangzhou');
    assert.equal(imageRead, 'MISSING_PERMISSION');
    const gate = gateFromImageRead('MISSING_PERMISSION', true);
    assert.equal(gate.allReady, false);
    assert.equal(gate.canCreate, false);
    assert.deepEqual(gate.blockers, ['ecs:DescribeImages']);
    assert.equal(gate.runInstances, 0);
  });

  it('DescribeImages success → ecs.imageRead READY', async () => {
    const imageRead = await probeEcsImageRead(async () => ({
      body: { images: { image: [{ imageId: 'm-test' }] } },
    }), 'cn-hangzhou');
    assert.equal(imageRead, 'READY');
    const gate = gateFromImageRead('READY', true);
    assert.equal(gate.allReady, true);
  });

  it('non-permission DescribeImages failure → ERROR (not READY)', () => {
    assert.equal(
      classifyEcsImageReadProbeError(new Error('ServiceUnavailable: timeout')),
      'ERROR',
    );
  });
});
