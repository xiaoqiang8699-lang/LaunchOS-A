import EcsClient, {
  AuthorizeSecurityGroupRequest,
  CreateSecurityGroupRequest,
  DescribeAvailableResourceRequest,
  DescribeImagesRequest,
  DescribeInstancesRequest,
  DescribePriceRequest as DescribeEcsPriceRequest,
  DescribePriceRequestSystemDisk,
  DescribeSecurityGroupsRequest,
  DescribeVpcsRequest,
  RunInstancesRequest,
} from '@alicloud/ecs20140526';
import { $OpenApiUtil } from '@alicloud/openapi-core';
import RdsClient, {
  CreateDBInstanceRequest,
  DescribeAvailableClassesRequest,
  DescribeDBInstancesRequest,
} from '@alicloud/rds20140815';
import KvstoreClient, {
  CreateInstanceRequest,
  DescribeInstancesRequest as DescribeRedisInstancesRequest,
  DescribePriceRequest,
} from '@alicloud/r-kvstore20150101';
import BssOpenApiClient, {
  QueryOrdersRequest,
} from '@alicloud/bssopenapi20171214';

export type CapabilityStatus =
  | 'READY'
  | 'MISSING_PERMISSION'
  | 'ERROR'
  | 'UNKNOWN'
  | 'NOT_CONFIGURED';

export type CapabilityProbeResult = {
  status: CapabilityStatus;
  /** Product-facing capability keys that are missing (not RAM action names). */
  missingCapabilities?: string[];
  detail?: string;
};

export type AliyunCapabilityReport = {
  provider: 'ALIYUN';
  credentialsConfigured: boolean;
  region: string;
  /** Explicit BSS order/pay permission for RAM users (AliyunBSSOrderAccess scope). */
  BILLING_ORDER_PERMISSION?: CapabilityStatus;
  capabilities: {
    dns: CapabilityProbeResult;
    ecs: CapabilityProbeResult & {
      actions?: {
        read: CapabilityStatus;
        create: CapabilityStatus;
        delete: CapabilityStatus;
        network: CapabilityStatus;
        price: CapabilityStatus;
        /** ecs:RunInstances DryRun */
        instanceCreate: CapabilityStatus;
        /** ecs:DescribeSecurityGroups */
        securityGroupRead: CapabilityStatus;
        /** ecs:CreateSecurityGroup (auth probe via invalid VPC) */
        securityGroupCreate: CapabilityStatus;
        /** ecs:AuthorizeSecurityGroup (auth probe via invalid SG) */
        securityGroupAuthorize: CapabilityStatus;
        /** ecs:DescribeImages — must not infer READY from cached imageId */
        imageRead: CapabilityStatus;
      };
    };
    rds: CapabilityProbeResult & {
      actions?: {
        read: CapabilityStatus;
        create: CapabilityStatus;
        databaseManage: CapabilityStatus;
        accountManage: CapabilityStatus;
        networkManage: CapabilityStatus;
        delete: CapabilityStatus;
      };
    };
    vpc: CapabilityProbeResult;
    redis: CapabilityProbeResult & {
      actions?: {
        read: CapabilityStatus;
        create: CapabilityStatus;
        delete: CapabilityStatus;
        networkManage: CapabilityStatus;
        accountManage: CapabilityStatus;
        /** kvstore:DescribePrice */
        price: CapabilityStatus;
        /** Redis resource APIs (list/read) — separate from BSS order. */
        resource: CapabilityStatus;
      };
    };
    billing: CapabilityProbeResult & {
      actions?: {
        /** BSS QueryOrders — AliyunBSSOrderAccess, not FullAccess. */
        order: CapabilityStatus;
        /**
         * BSS QueryAccountBalance when permitted.
         * READY = readable & appears funded; INSUFFICIENT when clearly empty;
         * UNKNOWN = cannot reliably pre-check (do not pretend = creatable).
         */
        accountBalance?: CapabilityStatus | 'INSUFFICIENT';
      };
    };
  };
  /** Product labels for UI first layer. */
  labels: Array<{
    key: string;
    label: string;
    status: CapabilityStatus;
    statusLabel: string;
  }>;
};

export type CapabilityCredentials = {
  accessKey: string;
  secretKey: string;
  region?: string;
};

export type CapabilityProbeOptions = {
  /**
   * Skip CreateInstance / CreateDBInstance DryRun probes.
   * Use for billing/RAM readiness that must never call Create*.
   */
  skipCreateDryRuns?: boolean;
};

const STATUS_LABEL: Record<CapabilityStatus, string> = {
  READY: '已就绪',
  MISSING_PERMISSION: '权限不足',
  ERROR: '探测失败',
  UNKNOWN: '无法确认',
  NOT_CONFIGURED: '未配置',
};

/**
 * Probe Aliyun OpenAPI capabilities without creating billable resources.
 * RDS create uses CreateDBInstance DryRun only (unless skipCreateDryRuns).
 */
export class AlibabaCloudCapabilityService {
  async probe(
    input: CapabilityCredentials,
    options: CapabilityProbeOptions = {},
  ): Promise<AliyunCapabilityReport> {
    const region = input.region?.trim() || 'cn-hangzhou';
    if (!input.accessKey?.trim() || !input.secretKey?.trim()) {
      return emptyReport(region, false);
    }

    const ecs = this.ecsClient(input.accessKey, input.secretKey, region);
    const rds = this.rdsClient(input.accessKey, input.secretKey);
    const kv = this.kvClient(input.accessKey, input.secretKey);
    const bss = this.bssClient(input.accessKey, input.secretKey);

    const ecsRead = await this.probeEcsRead(ecs, region);
    const ecsPrice = await this.probeEcsDescribePrice(ecs, region);
    const ecsAvailable = await this.probeEcsAvailableResource(ecs, region);
    const vpcRead = await this.probeVpcRead(ecs, region);
    const securityGroupRead = await this.probeEcsDescribeSecurityGroups(ecs, region);
    // Always probe SG create/authorize + RunInstances DryRun for Step 26.2 gates
    // (even when skipCreateDryRuns skips RDS/Redis create DryRuns).
    const securityGroupCreate = await this.probeEcsCreateSecurityGroupAuth(ecs, region);
    const securityGroupAuthorize = await this.probeEcsAuthorizeSecurityGroupAuth(ecs, region);
    const instanceCreate = await this.probeEcsRunInstancesDryRun(ecs, region);
    const imageRead = await this.probeEcsDescribeImages(ecs, region);

    const rdsRead = await this.probeRdsRead(rds, region);
    const rdsCreate = options.skipCreateDryRuns
      ? ('UNKNOWN' as CapabilityStatus)
      : await this.probeRdsCreateDryRun(rds, region);
    const rdsClasses = await this.probeRdsDescribeClasses(rds, region);
    const redisRead = await this.probeRedisRead(kv, region);
    const redisCreate = options.skipCreateDryRuns
      ? ('UNKNOWN' as CapabilityStatus)
      : await this.probeRedisCreateDryRun(kv, region);
    const redisPrice = await this.probeRedisDescribePrice(kv, region);
    const billingOrder = await this.probeBssQueryOrders(bss);
    const billingAccountBalance = await this.probeBssAccountBalance(bss);

    const rdsOverall = combineStatuses([rdsRead, rdsCreate, rdsClasses]);
    const redisResource = redisRead;
    const redisOverall = combineStatuses([redisRead, redisCreate, redisPrice]);
    const missing: string[] = [];
    if (rdsRead === 'MISSING_PERMISSION') missing.push('查看数据库');
    if (rdsCreate === 'MISSING_PERMISSION') missing.push('创建数据库');
    if (rdsClasses === 'MISSING_PERMISSION') missing.push('查看可用规格');
    const redisMissing: string[] = [];
    if (redisRead === 'MISSING_PERMISSION') redisMissing.push('查看 Redis');
    if (redisCreate === 'MISSING_PERMISSION') redisMissing.push('创建 Redis');
    if (redisPrice === 'MISSING_PERMISSION') redisMissing.push('Redis 询价');
    const billingMissing: string[] = [];
    if (billingOrder === 'MISSING_PERMISSION') billingMissing.push('BSS 订单权限');

    const ecsMissing: string[] = [];
    if (ecsRead === 'MISSING_PERMISSION') ecsMissing.push('查看云服务器');
    if (ecsPrice === 'MISSING_PERMISSION') ecsMissing.push('ECS 询价');
    if (ecsAvailable === 'MISSING_PERMISSION') ecsMissing.push('查看可售规格');
    if (vpcRead === 'MISSING_PERMISSION') ecsMissing.push('网络读取');
    if (securityGroupRead === 'MISSING_PERMISSION') ecsMissing.push('安全组读取');
    if (securityGroupCreate === 'MISSING_PERMISSION') ecsMissing.push('安全组创建');
    if (securityGroupAuthorize === 'MISSING_PERMISSION') ecsMissing.push('安全组授权');
    if (instanceCreate === 'MISSING_PERMISSION') ecsMissing.push('ECS 创建');
    if (imageRead === 'MISSING_PERMISSION') ecsMissing.push('镜像读取');
    // create READY only when RunInstances DryRun + SG create/authorize all READY
    const ecsCreate = combineStatuses([
      instanceCreate,
      securityGroupCreate,
      securityGroupAuthorize,
    ]);
    const ecsNetwork = combineStatuses([vpcRead, securityGroupRead]);
    const ecsOverall = combineStatuses([
      ecsRead,
      ecsPrice,
      ecsAvailable,
      vpcRead,
      securityGroupRead,
      securityGroupCreate,
      securityGroupAuthorize,
      instanceCreate,
      imageRead,
    ]);

    const report: AliyunCapabilityReport = {
      provider: 'ALIYUN',
      credentialsConfigured: true,
      region,
      BILLING_ORDER_PERMISSION: billingOrder,
      capabilities: {
        dns: {
          status: 'UNKNOWN',
          detail: 'DNS 能力请使用独立的 ALIYUN_DNS 账户检测',
        },
        ecs: {
          status: ecsOverall,
          missingCapabilities: ecsMissing.length ? ecsMissing : undefined,
          detail:
            'ECS readiness 分项探测：read/price/available、vpc.read、securityGroup read/create/authorize、imageRead(DescribeImages)、RunInstances DryRun。',
          actions: {
            read: ecsRead,
            create: ecsCreate,
            delete: instanceCreate,
            network: ecsNetwork,
            price: ecsPrice,
            instanceCreate,
            securityGroupRead,
            securityGroupCreate,
            securityGroupAuthorize,
            imageRead,
          },
        },
        rds: {
          status: rdsOverall,
          missingCapabilities: missing.length ? missing : undefined,
          actions: {
            read: rdsRead,
            create: rdsCreate,
            databaseManage: rdsRead === 'READY' ? 'READY' : rdsRead,
            accountManage: rdsRead === 'READY' ? 'READY' : rdsRead,
            networkManage: rdsRead === 'READY' ? 'READY' : rdsRead,
            delete:
              rdsCreate === 'READY'
                ? 'READY'
                : rdsCreate === 'MISSING_PERMISSION'
                  ? 'MISSING_PERMISSION'
                  : 'UNKNOWN',
          },
        },
        redis: {
          status: redisOverall,
          missingCapabilities: redisMissing.length ? redisMissing : undefined,
          detail:
            redisCreate === 'UNKNOWN'
              ? options.skipCreateDryRuns
                ? '已跳过 CreateInstance DryRun；资源/询价/订单权限分项检测。'
                : '首次使用阿里云 Redis 可能需要完成云服务授权。'
              : undefined,
          actions: {
            read: redisRead,
            resource: redisResource,
            create: redisCreate,
            price: redisPrice,
            delete:
              redisCreate === 'READY'
                ? 'READY'
                : redisCreate === 'MISSING_PERMISSION'
                  ? 'MISSING_PERMISSION'
                  : 'UNKNOWN',
            networkManage: redisRead === 'READY' ? 'READY' : redisRead,
            accountManage: redisRead === 'READY' ? 'READY' : redisRead,
          },
        },
        billing: {
          status: billingOrder,
          missingCapabilities: billingMissing.length ? billingMissing : undefined,
          detail:
            billingOrder === 'MISSING_PERMISSION'
              ? '建议授予系统策略 AliyunBSSOrderAccess（不要授予 AliyunBSSFullAccess）。RAM 缺订单权限时 CreateInstance 可能误报 PAY.INSUFFICIENT_BALANCE。'
              : billingOrder === 'READY'
                ? billingAccountBalance === 'UNKNOWN'
                  ? 'BSS 订单查询已通过；账户余额无法可靠预判，RunInstances 仍可能返回 NotEnoughBalance。'
                  : billingAccountBalance === 'INSUFFICIENT'
                    ? 'BSS 订单查询已通过，但账户可用余额不足。'
                    : 'BSS 订单查询已通过（AliyunBSSOrderAccess 范围）。'
                : '无法确认 BSS 订单权限。',
          actions: {
            order: billingOrder,
            /** Alias: billing.permission readiness */
            accountBalance: billingAccountBalance,
          },
        },
        vpc: {
          status: vpcRead,
          missingCapabilities: vpcRead === 'MISSING_PERMISSION' ? ['网络读取'] : undefined,
        },
      },
      labels: [],
    };

    report.labels = [
      {
        key: 'dns',
        label: '域名与 DNS',
        status: 'UNKNOWN',
        statusLabel: '请查看 DNS 账户',
      },
      {
        key: 'ecs',
        label: '云服务器',
        status: report.capabilities.ecs.status,
        statusLabel: STATUS_LABEL[report.capabilities.ecs.status],
      },
      {
        key: 'ecs_price',
        label: '云服务器询价',
        status: ecsPrice,
        statusLabel: STATUS_LABEL[ecsPrice],
      },
      {
        key: 'rds',
        label: 'PostgreSQL 数据库',
        status: report.capabilities.rds.status,
        statusLabel: STATUS_LABEL[report.capabilities.rds.status],
      },
      {
        key: 'redis_resource',
        label: 'Redis 资源权限',
        status: redisResource,
        statusLabel: STATUS_LABEL[redisResource],
      },
      {
        key: 'redis_price',
        label: 'Redis 询价权限',
        status: redisPrice,
        statusLabel: STATUS_LABEL[redisPrice],
      },
      {
        key: 'billing_order',
        label: '订单/支付权限',
        status: billingOrder,
        statusLabel: STATUS_LABEL[billingOrder],
      },
      {
        key: 'billing_account_balance',
        label: '账户余额',
        status:
          billingAccountBalance === 'INSUFFICIENT'
            ? 'MISSING_PERMISSION'
            : billingAccountBalance === 'READY'
              ? 'READY'
              : 'UNKNOWN',
        statusLabel:
          billingAccountBalance === 'INSUFFICIENT'
            ? '余额不足'
            : billingAccountBalance === 'READY'
              ? '已可读'
              : '无法预判',
      },
      {
        key: 'redis',
        label: 'Redis（综合）',
        status: report.capabilities.redis.status,
        statusLabel: STATUS_LABEL[report.capabilities.redis.status],
      },
      {
        key: 'vpc',
        label: '网络读取',
        status: report.capabilities.vpc.status,
        statusLabel: STATUS_LABEL[report.capabilities.vpc.status],
      },
    ];

    return report;
  }

  /** True when RDS create is explicitly missing; UNKNOWN is allowed to proceed. */
  isRdsCreateBlocked(report: AliyunCapabilityReport): boolean {
    if (!report.credentialsConfigured) return true;
    const create = report.capabilities.rds.actions?.create;
    return create === 'MISSING_PERMISSION' || report.capabilities.rds.status === 'MISSING_PERMISSION';
  }

  /** True when Redis create is explicitly missing; UNKNOWN is allowed to proceed. */
  isRedisCreateBlocked(report: AliyunCapabilityReport): boolean {
    if (!report.credentialsConfigured) return true;
    const create = report.capabilities.redis?.actions?.create;
    return (
      create === 'MISSING_PERMISSION' || report.capabilities.redis?.status === 'MISSING_PERMISSION'
    );
  }

  /** True when BSS order permission is missing (not FullAccess — OrderAccess only). */
  isBillingOrderBlocked(report: AliyunCapabilityReport): boolean {
    if (!report.credentialsConfigured) return true;
    return (
      report.BILLING_ORDER_PERMISSION === 'MISSING_PERMISSION' ||
      report.capabilities.billing?.actions?.order === 'MISSING_PERMISSION'
    );
  }

  private ecsClient(accessKey: string, secretKey: string, region: string) {
    const config = new $OpenApiUtil.Config({
      accessKeyId: accessKey,
      accessKeySecret: secretKey,
    });
    config.endpoint = `ecs.${region}.aliyuncs.com`;
    return new EcsClient(config);
  }

  private rdsClient(accessKey: string, secretKey: string) {
    const config = new $OpenApiUtil.Config({
      accessKeyId: accessKey,
      accessKeySecret: secretKey,
    });
    config.endpoint = 'rds.aliyuncs.com';
    return new RdsClient(config);
  }

  private kvClient(accessKey: string, secretKey: string) {
    const config = new $OpenApiUtil.Config({
      accessKeyId: accessKey,
      accessKeySecret: secretKey,
    });
    config.endpoint = 'r-kvstore.aliyuncs.com';
    return new KvstoreClient(config);
  }

  private bssClient(accessKey: string, secretKey: string) {
    const config = new $OpenApiUtil.Config({
      accessKeyId: accessKey,
      accessKeySecret: secretKey,
    });
    config.endpoint = 'business.aliyuncs.com';
    return new BssOpenApiClient(config);
  }

  private async probeEcsRead(ecs: EcsClient, region: string): Promise<CapabilityStatus> {
    try {
      await ecs.describeInstances(
        new DescribeInstancesRequest({ regionId: region, pageSize: 1 }),
      );
      return 'READY';
    } catch (error) {
      return mapProbeError(error);
    }
  }

  private async probeEcsDescribePrice(ecs: EcsClient, region: string): Promise<CapabilityStatus> {
    try {
      await ecs.describePrice(
        new DescribeEcsPriceRequest({
          regionId: region,
          resourceType: 'instance',
          instanceType: 'ecs.e-c1m2.large',
          instanceNetworkType: 'vpc',
          internetChargeType: 'PayByTraffic',
          internetMaxBandwidthOut: 1,
          systemDisk: new DescribePriceRequestSystemDisk({
            category: 'cloud_essd',
            size: 40,
          }),
          instanceAmount: 1,
          priceUnit: 'Hour',
          period: 1,
        }),
      );
      return 'READY';
    } catch (error) {
      return mapProbeError(error);
    }
  }

  private async probeEcsAvailableResource(
    ecs: EcsClient,
    region: string,
  ): Promise<CapabilityStatus> {
    try {
      await ecs.describeAvailableResource(
        new DescribeAvailableResourceRequest({
          regionId: region,
          destinationResource: 'InstanceType',
          instanceChargeType: 'PostPaid',
        }),
      );
      return 'READY';
    } catch (error) {
      return mapProbeError(error);
    }
  }

  private async probeVpcRead(ecs: EcsClient, region: string): Promise<CapabilityStatus> {
    try {
      await ecs.describeVpcs(new DescribeVpcsRequest({ regionId: region, pageSize: 1 }));
      return 'READY';
    } catch (error) {
      return mapProbeError(error);
    }
  }

  private async probeEcsDescribeSecurityGroups(
    ecs: EcsClient,
    region: string,
  ): Promise<CapabilityStatus> {
    try {
      await ecs.describeSecurityGroups(
        new DescribeSecurityGroupsRequest({ regionId: region, pageSize: 1 }),
      );
      return 'READY';
    } catch (error) {
      return mapProbeError(error);
    }
  }

  /**
   * ecs:DescribeImages — independent of whether planner already has an imageId.
   * Forbidden.RAM → MISSING_PERMISSION; other failures → ERROR (not READY).
   */
  private async probeEcsDescribeImages(
    ecs: EcsClient,
    region: string,
  ): Promise<CapabilityStatus> {
    try {
      await ecs.describeImages(
        new DescribeImagesRequest({
          regionId: region,
          status: 'Available',
          pageSize: 1,
        }),
      );
      return 'READY';
    } catch (error) {
      return classifyEcsImageReadProbeError(error);
    }
  }

  /**
   * Auth probe for ecs:CreateSecurityGroup without creating a real group:
   * use a non-existent VPC. Forbidden.RAM = missing; InvalidVpc* = authorized.
   */
  private async probeEcsCreateSecurityGroupAuth(
    ecs: EcsClient,
    region: string,
  ): Promise<CapabilityStatus> {
    try {
      await ecs.createSecurityGroup(
        new CreateSecurityGroupRequest({
          regionId: region,
          vpcId: 'vpc-launchos-capability-probe-invalid',
          securityGroupName: 'launchos-capability-probe',
          description: 'LaunchOS capability probe — must not succeed',
        }),
      );
      // Unexpected success would create a SG in a real VPC only; invalid VPC should not succeed.
      return 'READY';
    } catch (error) {
      const message = readErrorMessage(error).toLowerCase();
      if (mapProbeError(error) === 'MISSING_PERMISSION') return 'MISSING_PERMISSION';
      if (
        message.includes('invalidvpc') ||
        message.includes('invalid.vpc') ||
        message.includes('vpcid') ||
        message.includes('vpc not found') ||
        message.includes('invalidparameter') ||
        message.includes('notfound')
      ) {
        return 'READY';
      }
      return 'UNKNOWN';
    }
  }

  /**
   * Auth probe for ecs:AuthorizeSecurityGroup without mutating a real SG.
   */
  private async probeEcsAuthorizeSecurityGroupAuth(
    ecs: EcsClient,
    region: string,
  ): Promise<CapabilityStatus> {
    try {
      await ecs.authorizeSecurityGroup(
        new AuthorizeSecurityGroupRequest({
          regionId: region,
          securityGroupId: 'sg-launchos-capability-probe-invalid',
          ipProtocol: 'tcp',
          portRange: '22/22',
          sourceCidrIp: '127.0.0.1/32',
          policy: 'accept',
          priority: '100',
        }),
      );
      return 'READY';
    } catch (error) {
      const message = readErrorMessage(error).toLowerCase();
      if (mapProbeError(error) === 'MISSING_PERMISSION') return 'MISSING_PERMISSION';
      if (
        message.includes('invalidsecuritygroup') ||
        message.includes('securitygroup') ||
        message.includes('notfound') ||
        message.includes('invalidparameter') ||
        message.includes('invalid.security')
      ) {
        return 'READY';
      }
      return 'UNKNOWN';
    }
  }

  /**
   * ecs:RunInstances DryRun — never creates an instance.
   */
  private async probeEcsRunInstancesDryRun(
    ecs: EcsClient,
    region: string,
  ): Promise<CapabilityStatus> {
    try {
      await ecs.runInstances(
        new RunInstancesRequest({
          regionId: region,
          imageId: 'm-launchos-capability-probe-invalid',
          instanceType: 'ecs.e-c1m2.large',
          securityGroupId: 'sg-launchos-capability-probe-invalid',
          vSwitchId: 'vsw-launchos-capability-probe-invalid',
          amount: 1,
          instanceChargeType: 'PostPaid',
          internetChargeType: 'PayByTraffic',
          internetMaxBandwidthOut: 1,
          dryRun: true,
          systemDisk: {
            category: 'cloud_essd',
            size: '40',
          },
        }),
      );
      return 'READY';
    } catch (error) {
      const message = readErrorMessage(error).toLowerCase();
      if (
        message.includes('dryrun') ||
        message.includes('dry run') ||
        message.includes('dryrunoperation')
      ) {
        return 'READY';
      }
      if (mapProbeError(error) === 'MISSING_PERMISSION') return 'MISSING_PERMISSION';
      // Parameter/image/SG invalid after RAM check means create action is authorized.
      if (
        message.includes('invalid') ||
        message.includes('notfound') ||
        message.includes('not found') ||
        message.includes('missing') ||
        message.includes('parameter')
      ) {
        return 'READY';
      }
      return 'UNKNOWN';
    }
  }

  private async probeRdsRead(rds: RdsClient, region: string): Promise<CapabilityStatus> {
    try {
      await rds.describeDBInstances(
        new DescribeDBInstancesRequest({ regionId: region, pageSize: 1 }),
      );
      return 'READY';
    } catch (error) {
      return mapProbeError(error);
    }
  }

  private async probeRdsDescribeClasses(
    rds: RdsClient,
    region: string,
  ): Promise<CapabilityStatus> {
    try {
      await rds.describeAvailableClasses(
        new DescribeAvailableClassesRequest({
          regionId: region,
          engine: 'PostgreSQL',
          engineVersion: '16.0',
          category: 'Basic',
          dbInstanceStorageType: 'cloud_essd',
          zoneId: `${region}-i`,
        }),
      );
      return 'READY';
    } catch (error) {
      return mapProbeError(error);
    }
  }

  private async probeRdsCreateDryRun(
    rds: RdsClient,
    region: string,
  ): Promise<CapabilityStatus> {
    try {
      await rds.createDBInstance(
        new CreateDBInstanceRequest({
          regionId: region,
          engine: 'PostgreSQL',
          engineVersion: '16.0',
          dbInstanceClass: 'pg.n2.2c.1m',
          dbInstanceStorage: 20,
          dbInstanceStorageType: 'cloud_essd',
          payType: 'Postpaid',
          dryRun: true,
        }),
      );
      return 'READY';
    } catch (error) {
      const message = readErrorMessage(error).toLowerCase();
      if (
        message.includes('dryrun') ||
        message.includes('dry run') ||
        message.includes('dryrunoperation')
      ) {
        return 'READY';
      }
      return mapProbeError(error);
    }
  }

  private async probeRedisRead(
    kv: InstanceType<typeof KvstoreClient>,
    region: string,
  ): Promise<CapabilityStatus> {
    try {
      await kv.describeInstances(
        new DescribeRedisInstancesRequest({ regionId: region, pageSize: 1, pageNumber: 1 }),
      );
      return 'READY';
    } catch (error) {
      return mapProbeError(error);
    }
  }

  private async probeRedisDescribePrice(
    kv: InstanceType<typeof KvstoreClient>,
    region: string,
  ): Promise<CapabilityStatus> {
    try {
      await kv.describePrice(
        new DescribePriceRequest({
          regionId: region,
          orderType: 'BUY',
          chargeType: 'PostPaid',
          instanceClass: 'redis.master.small.default',
          engineVersion: '5.0',
          capacity: 1024,
          quantity: 1,
          nodeType: 'MASTER_SLAVE',
        }),
      );
      return 'READY';
    } catch (error) {
      return mapProbeError(error);
    }
  }

  /**
   * Read-only BSS order probe covered by AliyunBSSOrderAccess (QueryOrders).
   * Never creates orders or instances. Does not require AliyunBSSFullAccess.
   */
  private async probeBssQueryOrders(
    bss: InstanceType<typeof BssOpenApiClient>,
  ): Promise<CapabilityStatus> {
    try {
      await bss.queryOrders(
        new QueryOrdersRequest({
          pageNum: 1,
          pageSize: 1,
        }),
      );
      return 'READY';
    } catch (error) {
      return mapProbeError(error);
    }
  }

  /**
   * Optional BSS QueryAccountBalance. Permission READY does not guarantee creatable.
   * Returns INSUFFICIENT only when API clearly reports zero/negative available amount;
   * otherwise UNKNOWN when unreadable (do not pretend balance is OK).
   */
  private async probeBssAccountBalance(
    bss: InstanceType<typeof BssOpenApiClient>,
  ): Promise<CapabilityStatus | 'INSUFFICIENT'> {
    try {
      const resp = await bss.queryAccountBalance();
      const data = (resp as { body?: { data?: Record<string, unknown> } })?.body?.data;
      if (!data) return 'UNKNOWN';
      const availableRaw =
        data.availableAmount ?? data.AvailableAmount ?? data.availableCashAmount ?? null;
      const available = Number(String(availableRaw ?? '').replace(/,/g, ''));
      if (!Number.isFinite(available)) return 'UNKNOWN';
      if (available <= 0) return 'INSUFFICIENT';
      return 'READY';
    } catch (error) {
      if (mapProbeError(error) === 'MISSING_PERMISSION') return 'UNKNOWN';
      return 'UNKNOWN';
    }
  }

  private async probeRedisCreateDryRun(
    kv: InstanceType<typeof KvstoreClient>,
    region: string,
  ): Promise<CapabilityStatus> {
    try {
      await kv.createInstance(
        new CreateInstanceRequest({
          regionId: region,
          instanceClass: 'redis.master.micro.default',
          instanceType: 'Redis',
          engineVersion: '5.0',
          chargeType: 'PostPaid',
          password: 'LaunchosDryRun1!',
          securityIPList: '127.0.0.1',
          dryRun: true,
        }),
      );
      return 'READY';
    } catch (error) {
      const message = readErrorMessage(error).toLowerCase();
      if (
        message.includes('dryrun') ||
        message.includes('dry run') ||
        message.includes('dryrunoperation')
      ) {
        return 'READY';
      }
      if (message.includes('servicelinkedrole') || message.includes('service linked role')) {
        return 'MISSING_PERMISSION';
      }
      // Balance/order failures are not Redis RAM resource permission gaps.
      if (
        message.includes('pay.insufficient_balance') ||
        message.includes('insufficient_balance') ||
        message.includes('order.account_status')
      ) {
        return 'UNKNOWN';
      }
      return mapProbeError(error);
    }
  }
}

function emptyReport(region: string, configured: boolean): AliyunCapabilityReport {
  const missing: CapabilityProbeResult = {
    status: configured ? 'UNKNOWN' : 'NOT_CONFIGURED',
  };
  return {
    provider: 'ALIYUN',
    credentialsConfigured: configured,
    region,
    BILLING_ORDER_PERMISSION: missing.status,
    capabilities: {
      dns: { ...missing },
      ecs: { ...missing },
      rds: { ...missing },
      redis: { ...missing },
      billing: { ...missing },
      vpc: { ...missing },
    },
    labels: [
      { key: 'dns', label: '域名与 DNS', status: missing.status, statusLabel: STATUS_LABEL[missing.status] },
      { key: 'ecs', label: '云服务器', status: missing.status, statusLabel: STATUS_LABEL[missing.status] },
      {
        key: 'rds',
        label: 'PostgreSQL 数据库',
        status: missing.status,
        statusLabel: STATUS_LABEL[missing.status],
      },
      {
        key: 'redis_resource',
        label: 'Redis 资源权限',
        status: missing.status,
        statusLabel: STATUS_LABEL[missing.status],
      },
      {
        key: 'redis_price',
        label: 'Redis 询价权限',
        status: missing.status,
        statusLabel: STATUS_LABEL[missing.status],
      },
      {
        key: 'billing_order',
        label: '订单/支付权限',
        status: missing.status,
        statusLabel: STATUS_LABEL[missing.status],
      },
      {
        key: 'redis',
        label: 'Redis（综合）',
        status: missing.status,
        statusLabel: STATUS_LABEL[missing.status],
      },
      { key: 'vpc', label: '网络读取', status: missing.status, statusLabel: STATUS_LABEL[missing.status] },
    ],
  };
}

function combineStatuses(statuses: CapabilityStatus[]): CapabilityStatus {
  if (statuses.includes('MISSING_PERMISSION')) return 'MISSING_PERMISSION';
  if (statuses.every((s) => s === 'READY')) return 'READY';
  if (statuses.includes('READY') && statuses.every((s) => s === 'READY' || s === 'UNKNOWN')) {
    return 'UNKNOWN';
  }
  if (statuses.includes('UNKNOWN')) return 'UNKNOWN';
  return 'UNKNOWN';
}

function mapProbeError(error: unknown): CapabilityStatus {
  const message = readErrorMessage(error).toLowerCase();
  if (
    message.includes('forbidden') ||
    message.includes('unauthorized') ||
    message.includes('notauthorized') ||
    message.includes('no permission') ||
    message.includes('accessdenied') ||
    message.includes('forbidden.ram') ||
    message.includes('nopermission') ||
    message.includes('ram.permission') ||
    message.includes('rampermissiondenied') ||
    message.includes('permission denied')
  ) {
    return 'MISSING_PERMISSION';
  }
  return 'UNKNOWN';
}

/** Map DescribeImages probe failures — never treat as READY from cached imageId. */
export function classifyEcsImageReadProbeError(error: unknown): CapabilityStatus {
  if (mapProbeError(error) === 'MISSING_PERMISSION') return 'MISSING_PERMISSION';
  return 'ERROR';
}

/**
 * Probe ecs:DescribeImages against an injectable client (unit tests / dry-run gates).
 * Does not create resources. Never infers READY from an existing imageId.
 */
export async function probeEcsImageRead(
  describeImages: (request: DescribeImagesRequest) => Promise<unknown>,
  region: string,
): Promise<CapabilityStatus> {
  try {
    await describeImages(
      new DescribeImagesRequest({
        regionId: region,
        status: 'Available',
        pageSize: 1,
      }),
    );
    return 'READY';
  } catch (error) {
    return classifyEcsImageReadProbeError(error);
  }
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'object' && error !== null) {
    const record = error as { message?: string; data?: { Message?: string; Code?: string } };
    return [record.data?.Code, record.data?.Message, record.message].filter(Boolean).join(' ');
  }
  return String(error ?? '');
}

export { STATUS_LABEL as CAPABILITY_STATUS_LABEL };
