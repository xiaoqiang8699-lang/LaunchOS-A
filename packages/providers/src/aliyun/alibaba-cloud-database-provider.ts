import { setTimeout as delay } from 'node:timers/promises';
import { $OpenApiUtil } from '@alicloud/openapi-core';
import RdsClient, {
  AllocateInstancePublicConnectionRequest,
  CreateAccountRequest,
  CreateDatabaseRequest,
  CreateDBInstanceRequest,
  DeleteDBInstanceRequest,
  DescribeAccountsRequest,
  DescribeAvailableClassesRequest,
  DescribeDatabasesRequest,
  DescribeDBInstanceAttributeRequest,
  DescribeDBInstanceNetInfoRequest,
  DescribeDBInstancesRequest,
  GrantAccountPrivilegeRequest,
  ModifySecurityIpsRequest,
} from '@alicloud/rds20140815';
import EcsClient, {
  CreateVpcRequest,
  CreateVSwitchRequest,
  DescribeInstancesRequest,
  DescribeVpcsRequest,
  DescribeVSwitchesRequest,
  DescribeZonesRequest,
} from '@alicloud/ecs20140526';
import type {
  AvailableSpec,
  CreateAccountInput,
  CreateDatabaseInput,
  CreatePostgresInstanceInput,
  DatabaseInstanceStatus,
  DatabaseProvider,
  DatabaseTier,
  GrantPrivilegeInput,
  NetworkPlacement,
  PostgresConnectionInfo,
  SetWhitelistInput,
} from '../core/database-provider.interface';
import {
  extractRdsNetEndpoints,
  normalizeRdsConnectionInfo,
  pickRdsName,
} from './rds-response-normalize';

export type AlibabaCloudDatabaseProviderOptions = {
  accessKey: string;
  secretKey: string;
  region?: string;
};

const DEFAULT_REGION = 'cn-hangzhou';
const POLL_INTERVAL_MS = 8_000;
const DEFAULT_WAIT_MS = 20 * 60_000;

const TIER_CANDIDATES: Record<
  DatabaseTier,
  { label: string; classes: string[]; storageGb: number; engineVersions: string[] }
> = {
  DEV: {
    label: '开发测试',
    classes: ['pg.n2.2c.1m', 'pg.n2e.2c.1m', 'pg.x2.large.2c', 'rds.pg.s1.small'],
    storageGb: 20,
    engineVersions: ['16.0', '15.0', '14.0', '13.0'],
  },
  SMALL: {
    label: '小型生产',
    classes: ['pg.n2.2c.2m', 'pg.n2e.2c.2m', 'pg.x2.large.2c', 'rds.pg.s2.large'],
    storageGb: 50,
    engineVersions: ['16.0', '15.0', '14.0'],
  },
  STANDARD: {
    label: '标准生产',
    classes: ['pg.n2.4c.4m', 'pg.n2e.4c.4m', 'pg.x2.xlarge.4c', 'rds.pg.s3.large'],
    storageGb: 100,
    engineVersions: ['16.0', '15.0', '14.0'],
  },
};

export class AlibabaCloudDatabaseProvider implements DatabaseProvider {
  readonly name = 'ALIYUN_RDS';
  private readonly region: string;
  private readonly rds: RdsClient;
  private readonly ecs: EcsClient;

  constructor(options: AlibabaCloudDatabaseProviderOptions) {
    this.region = options.region?.trim() || DEFAULT_REGION;
    const config = new $OpenApiUtil.Config({
      accessKeyId: options.accessKey,
      accessKeySecret: options.secretKey,
    });
    config.endpoint = `rds.aliyuncs.com`;
    this.rds = new RdsClient(config);

    const ecsConfig = new $OpenApiUtil.Config({
      accessKeyId: options.accessKey,
      accessKeySecret: options.secretKey,
    });
    ecsConfig.endpoint = `ecs.${this.region}.aliyuncs.com`;
    this.ecs = new EcsClient(ecsConfig);
  }

  async listAvailableSpecs(region: string, tier?: DatabaseTier): Promise<AvailableSpec[]> {
    const tiers = tier ? [tier] : (['DEV', 'SMALL', 'STANDARD'] as DatabaseTier[]);
    const results: AvailableSpec[] = [];
    for (const item of tiers) {
      const picked = await this.pickSpec(region || this.region, item);
      results.push(picked);
    }
    return results;
  }

  async createPostgresInstance(
    input: CreatePostgresInstanceInput,
  ): Promise<{ dbInstanceId: string }> {
    const region = input.region || this.region;
    const tier = input.tier || 'DEV';
    const spec = await this.pickSpec(region, tier, input.instanceClass, input.engineVersion);
    const storage = Math.max(input.storageGb ?? spec.storageGb, 20);
    const securityIpList = sanitizeWhitelist(input.securityIpList);
    if (!securityIpList) {
      throw wrapRdsError(new Error('security IP list is required'));
    }

    const requestFields = {
      regionId: region,
      engine: 'PostgreSQL',
      engineVersion: spec.engineVersion,
      DBInstanceClass: spec.instanceClass,
      DBInstanceStorage: storage,
      DBInstanceNetType: 'Intranet',
      DBInstanceStorageType: 'cloud_essd',
      payType: 'Postpaid',
      securityIPList: securityIpList,
      DBInstanceDescription: input.instanceName.slice(0, 64),
      clientToken: input.clientToken,
      VPCId: input.vpcId,
      vSwitchId: input.vSwitchId,
      zoneId: input.zoneId,
      category: 'Basic',
      instanceNetworkType: input.vpcId ? 'VPC' : undefined,
    };

    try {
      const response = await this.rds.createDBInstance(new CreateDBInstanceRequest(requestFields));
      const dbInstanceId = response.body?.DBInstanceId?.trim();
      if (!dbInstanceId) {
        throw new Error('CreateDBInstance did not return DBInstanceId');
      }
      return { dbInstanceId };
    } catch (error) {
      if (!isSpecUnavailable(error) || input.instanceClass) {
        throw wrapRdsError(error);
      }
      const alternates = TIER_CANDIDATES[tier].classes.filter((c) => c !== spec.instanceClass);
      let last = error;
      for (const instanceClass of alternates) {
        try {
          // Different class must use a distinct ClientToken — Aliyun idempotency is
          // parameter-sensitive; reusing the same token with a new class can create duplicates.
          const retryToken = input.clientToken
            ? `${input.clientToken}-${instanceClass}`.slice(0, 64)
            : undefined;
          const retry = await this.rds.createDBInstance(
            new CreateDBInstanceRequest({
              ...requestFields,
              DBInstanceClass: instanceClass,
              clientToken: retryToken,
            }),
          );
          const dbInstanceId = retry.body?.DBInstanceId?.trim();
          if (dbInstanceId) return { dbInstanceId };
        } catch (err) {
          last = err;
          if (!isSpecUnavailable(err)) throw wrapRdsError(err);
        }
      }
      throw wrapRdsError(last);
    }
  }

  async getInstanceStatus(
    dbInstanceId: string,
  ): Promise<{ status: DatabaseInstanceStatus; rawStatus?: string }> {
    try {
      const response = await this.rds.describeDBInstanceAttribute(
        new DescribeDBInstanceAttributeRequest({ DBInstanceId: dbInstanceId }),
      );
      const raw = response.body?.items?.DBInstanceAttribute?.[0]?.DBInstanceStatus;
      return { status: mapRdsStatus(raw), rawStatus: raw };
    } catch (error) {
      if (isNotFound(error)) {
        return { status: 'DELETED' };
      }
      throw wrapRdsError(error);
    }
  }

  async waitUntilRunning(dbInstanceId: string, timeoutMs = DEFAULT_WAIT_MS): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const { status, rawStatus } = await this.getInstanceStatus(dbInstanceId);
      if (status === 'RUNNING') return;
      if (status === 'FAILED' || status === 'DELETED') {
        throw wrapRdsError(new Error(`RDS entered ${rawStatus || status}`));
      }
      await delay(POLL_INTERVAL_MS);
    }
    throw wrapRdsError(new Error(`Timed out waiting for RDS ${dbInstanceId}`));
  }

  async createDatabase(input: CreateDatabaseInput): Promise<void> {
    const existing = await this.listDatabaseNames(input.dbInstanceId);
    if (existing.includes(input.databaseName)) return;
    try {
      await this.rds.createDatabase(
        new CreateDatabaseRequest({
          DBInstanceId: input.dbInstanceId,
          DBName: input.databaseName,
          characterSetName: input.characterSetName || 'UTF8',
        }),
      );
    } catch (error) {
      if (isAlreadyExists(error)) return;
      throw wrapRdsError(error);
    }
  }

  async createAccount(input: CreateAccountInput): Promise<void> {
    const existing = await this.listAccountNames(input.dbInstanceId);
    if (existing.includes(input.accountName)) return;
    try {
      await this.rds.createAccount(
        new CreateAccountRequest({
          DBInstanceId: input.dbInstanceId,
          accountName: input.accountName,
          accountPassword: input.accountPassword,
          accountType: 'Normal',
        }),
      );
    } catch (error) {
      if (isAlreadyExists(error)) return;
      throw wrapRdsError(error);
    }
  }

  async grantAccountPrivilege(input: GrantPrivilegeInput): Promise<void> {
    try {
      await this.rds.grantAccountPrivilege(
        new GrantAccountPrivilegeRequest({
          DBInstanceId: input.dbInstanceId,
          accountName: input.accountName,
          DBName: input.databaseName,
          accountPrivilege: input.privilege || 'DBOwner',
        }),
      );
    } catch (error) {
      if (isAlreadyExists(error)) return;
      throw wrapRdsError(error);
    }
  }

  async setWhitelist(input: SetWhitelistInput): Promise<void> {
    const securityIpList = sanitizeWhitelist(input.securityIpList);
    if (!securityIpList) {
      throw wrapRdsError(new Error('security IP list is required'));
    }
    try {
      await this.rds.modifySecurityIps(
        new ModifySecurityIpsRequest({
          DBInstanceId: input.dbInstanceId,
          securityIps: securityIpList,
          DBInstanceIPArrayName: input.dbInstanceIpArrayName || 'launchos',
          modifyMode: 'Cover',
        }),
      );
    } catch (error) {
      throw wrapRdsError(error);
    }
  }

  async getConnectionInfo(
    dbInstanceId: string,
    preferPrivate = true,
  ): Promise<PostgresConnectionInfo> {
    const response = await this.rds.describeDBInstanceNetInfo(
      new DescribeDBInstanceNetInfoRequest({ DBInstanceId: dbInstanceId }),
    );
    let normalized = normalizeRdsConnectionInfo({
      netInfoBody: response.body,
      preferPrivate,
    });
    if (!normalized?.connectionString) {
      const attr = await this.rds.describeDBInstanceAttribute(
        new DescribeDBInstanceAttributeRequest({ DBInstanceId: dbInstanceId }),
      );
      normalized = normalizeRdsConnectionInfo({
        attributeBody: attr.body,
        preferPrivate,
      });
    }
    if (!normalized?.connectionString) {
      throw Object.assign(wrapRdsError(new Error('RDS_CONNECTION_ENDPOINT_MISSING')), {
        code: 'RDS_CONNECTION_ENDPOINT_MISSING',
      });
    }
    return {
      host: normalized.connectionString,
      port: normalized.port,
      networkType: normalized.networkType,
    };
  }

  private async listDatabaseNames(dbInstanceId: string): Promise<string[]> {
    try {
      const resp = await this.rds.describeDatabases(
        new DescribeDatabasesRequest({
          DBInstanceId: dbInstanceId,
          pageSize: 100,
          pageNumber: 1,
        }),
      );
      const root = resp.body as Record<string, unknown> | undefined;
      const databases = (root?.databases || root?.Databases) as
        | Record<string, unknown>
        | undefined;
      const list = (databases?.database ||
        databases?.Database ||
        []) as unknown[];
      return list
        .map((item) => pickRdsName(item, 'DBName', 'dbName', 'dBName') || '')
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  private async listAccountNames(dbInstanceId: string): Promise<string[]> {
    try {
      const resp = await this.rds.describeAccounts(
        new DescribeAccountsRequest({
          DBInstanceId: dbInstanceId,
          pageSize: 100,
          pageNumber: 1,
        }),
      );
      const root = resp.body as Record<string, unknown> | undefined;
      const accounts = (root?.accounts || root?.Accounts) as
        | Record<string, unknown>
        | undefined;
      const list = (accounts?.dBInstanceAccount ||
        accounts?.DBInstanceAccount ||
        accounts?.dbInstanceAccount ||
        []) as unknown[];
      return list
        .map((item) => pickRdsName(item, 'accountName', 'AccountName') || '')
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Ensure private VPC clients can reach RDS even when ECS lookup failed. */
  async ensurePrivateWhitelist(
    dbInstanceId: string,
    extraIps: string[] = [],
  ): Promise<void> {
    const net = await this.rds.describeDBInstanceNetInfo(
      new DescribeDBInstanceNetInfoRequest({ DBInstanceId: dbInstanceId }),
    );
    const endpoints = extractRdsNetEndpoints(net.body);
    const vpcId = endpoints.find((e) => e.vpcId)?.vpcId;
    const ips = [...extraIps];
    if (vpcId) {
      try {
        const vpcs = await this.ecs.describeVpcs(
          new DescribeVpcsRequest({ regionId: this.region, vpcId }),
        );
        const vpc = vpcs.body?.vpcs?.vpc?.[0] as
          | { cidrBlock?: string; CidrBlock?: string }
          | undefined;
        const cidr = vpc?.cidrBlock || vpc?.CidrBlock;
        if (cidr) ips.push(cidr);
      } catch {
        // ignore — still apply extras
      }
    }
    const merged = uniqueIps(ips);
    if (merged.length === 0) return;
    await this.setWhitelist({
      dbInstanceId,
      securityIpList: merged.join(','),
    });
  }

  async allocatePublicConnection(
    dbInstanceId: string,
    port = 5432,
  ): Promise<PostgresConnectionInfo> {
    try {
      const prefix = `pg${dbInstanceId.replace(/[^a-zA-Z0-9]/g, '').slice(-8).toLowerCase()}`;
      await this.rds.allocateInstancePublicConnection(
        new AllocateInstancePublicConnectionRequest({
          DBInstanceId: dbInstanceId,
          connectionStringPrefix: prefix.slice(0, 30) || 'launchospg',
          port: String(port),
        }),
      );
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw wrapRdsError(error);
      }
    }
    return this.getConnectionInfo(dbInstanceId, false);
  }

  async deleteInstance(dbInstanceId: string): Promise<void> {
    try {
      await this.rds.deleteDBInstance(new DeleteDBInstanceRequest({ DBInstanceId: dbInstanceId }));
    } catch (error) {
      if (isNotFound(error)) return;
      throw wrapRdsError(error);
    }
  }

  async resolveNetworkPlacement(input: {
    region?: string;
    ecsInstanceId?: string;
    serverPublicIp?: string;
  }): Promise<NetworkPlacement> {
    const region = input.region?.trim() || this.region;
    let vpcId: string | undefined;
    let vSwitchId: string | undefined;
    let zoneId: string | undefined;
    const whitelist: string[] = [];
    let matchedEcs = false;

    if (input.ecsInstanceId) {
      const net = await this.describeEcsNetwork(input.ecsInstanceId, region);
      if (net?.vpcId && net.vSwitchId) {
        matchedEcs = true;
        vpcId = net.vpcId;
        vSwitchId = net.vSwitchId;
        zoneId = net.zoneId;
        if (net.vpcCidr) whitelist.push(net.vpcCidr);
        if (net.privateIp) whitelist.push(net.privateIp);
      }
    }

    if (!matchedEcs && input.serverPublicIp) {
      const matched = await this.findEcsByPublicIp(input.serverPublicIp, region);
      if (matched?.vpcId && matched.vSwitchId) {
        matchedEcs = true;
        vpcId = matched.vpcId;
        vSwitchId = matched.vSwitchId;
        zoneId = matched.zoneId;
        if (matched.vpcCidr) whitelist.push(matched.vpcCidr);
        if (matched.privateIp) whitelist.push(matched.privateIp);
      }
    }

    if (matchedEcs && vpcId && vSwitchId) {
      return {
        region,
        zoneId,
        vpcId,
        vSwitchId,
        preferPrivate: true,
        whitelist: uniqueIps(whitelist.length > 0 ? whitelist : ['127.0.0.1']),
        networkMode: 'VPC_PRIVATE',
      };
    }

    const network = await this.ensureLaunchosNetwork(region);
    if (input.serverPublicIp) whitelist.push(input.serverPublicIp);
    const cleaned = uniqueIps(whitelist);
    if (cleaned.length === 0) {
      throw wrapRdsError(new Error('Unable to determine source IP for RDS whitelist'));
    }
    return {
      region,
      zoneId: network.zoneId,
      vpcId: network.vpcId,
      vSwitchId: network.vSwitchId,
      preferPrivate: false,
      whitelist: cleaned,
      networkMode: 'PUBLIC_LIMITED',
    };
  }

  private async ensureLaunchosNetwork(region: string): Promise<{
    vpcId: string;
    vSwitchId: string;
    zoneId?: string;
  }> {
    const listed = await this.ecs.describeVpcs(
      new DescribeVpcsRequest({ regionId: region, pageSize: 50 }),
    );
    const vpcs = listed.body?.vpcs?.vpc ?? [];
    let vpcId =
      vpcs.find((vpc) => vpc.status === 'Available' && vpc.vpcName === 'launchos-vpc')?.vpcId ||
      vpcs.find((vpc) => vpc.status === 'Available' && vpc.isDefault)?.vpcId ||
      vpcs.find((vpc) => vpc.status === 'Available')?.vpcId;
    if (!vpcId) {
      const created = await this.ecs.createVpc(
        new CreateVpcRequest({
          regionId: region,
          cidrBlock: '172.16.0.0/16',
          vpcName: 'launchos-vpc',
        }),
      );
      vpcId = created.body?.vpcId;
      if (!vpcId) throw wrapRdsError(new Error('CreateVpc failed'));
      for (let i = 0; i < 20; i += 1) {
        const ready = await this.ecs.describeVpcs(new DescribeVpcsRequest({ regionId: region, vpcId }));
        if (ready.body?.vpcs?.vpc?.[0]?.status === 'Available') break;
        await delay(2000);
      }
    }

    const switches = await this.ecs.describeVSwitches(
      new DescribeVSwitchesRequest({ regionId: region, vpcId, pageSize: 50 }),
    );
    let vSwitchId = switches.body?.vSwitches?.vSwitch?.find((item) => item.status === 'Available')
      ?.vSwitchId;
    let zoneId = switches.body?.vSwitches?.vSwitch?.find((item) => item.vSwitchId === vSwitchId)
      ?.zoneId;
    if (!vSwitchId) {
      const zones = await this.ecs.describeZones(new DescribeZonesRequest({ regionId: region }));
      zoneId = zones.body?.zones?.zone?.[0]?.zoneId;
      if (!zoneId) throw wrapRdsError(new Error('No zone available'));
      const created = await this.ecs.createVSwitch(
        new CreateVSwitchRequest({
          regionId: region,
          vpcId,
          zoneId,
          cidrBlock: '172.16.0.0/24',
          vSwitchName: 'launchos-vsw',
        }),
      );
      vSwitchId = created.body?.vSwitchId;
      if (!vSwitchId) throw wrapRdsError(new Error('CreateVSwitch failed'));
    }
    return { vpcId, vSwitchId, zoneId: zoneId || undefined };
  }

  private async pickSpec(
    region: string,
    tier: DatabaseTier,
    preferredClass?: string,
    preferredVersion?: string,
  ): Promise<AvailableSpec> {
    const candidates = TIER_CANDIDATES[tier];
    const classes = preferredClass
      ? [preferredClass, ...candidates.classes.filter((c) => c !== preferredClass)]
      : candidates.classes;
    const versions = preferredVersion
      ? [preferredVersion, ...candidates.engineVersions.filter((v) => v !== preferredVersion)]
      : candidates.engineVersions;

    for (const engineVersion of versions) {
      try {
        const available = await this.rds.describeAvailableClasses(
          new DescribeAvailableClassesRequest({
            regionId: region,
            engine: 'PostgreSQL',
            engineVersion,
            category: 'Basic',
            DBInstanceStorageType: 'cloud_essd',
          }),
        );
        const listed =
          available.body?.DBInstanceClasses?.map((item) => item.DBInstanceClass).filter(Boolean) ??
          [];
        for (const instanceClass of classes) {
          if (listed.length === 0 || listed.includes(instanceClass)) {
            return {
              tier,
              label: candidates.label,
              instanceClass,
              storageGb: candidates.storageGb,
              engineVersion,
            };
          }
        }
        if (listed[0]) {
          return {
            tier,
            label: candidates.label,
            instanceClass: listed[0],
            storageGb: candidates.storageGb,
            engineVersion,
          };
        }
      } catch {
        // Fall through to static candidates when describe is unavailable.
      }
    }

    return {
      tier,
      label: candidates.label,
      instanceClass: classes[0] ?? candidates.classes[0] ?? 'pg.n2.2c.1m',
      storageGb: candidates.storageGb,
      engineVersion: versions[0] ?? candidates.engineVersions[0] ?? '16.0',
    };
  }

  private async describeEcsNetwork(
    instanceId: string,
    region: string,
  ): Promise<{
    vpcId?: string;
    vSwitchId?: string;
    zoneId?: string;
    privateIp?: string;
    vpcCidr?: string;
  } | null> {
    const response = await this.ecs.describeInstances(
      new DescribeInstancesRequest({
        regionId: region,
        instanceIds: JSON.stringify([instanceId]),
      }),
    );
    const instance = response.body?.instances?.instance?.[0];
    if (!instance) return null;
    const vpcId = instance.vpcAttributes?.vpcId || undefined;
    const vSwitchId = instance.vpcAttributes?.vSwitchId || undefined;
    const privateIp = instance.vpcAttributes?.privateIpAddress?.ipAddress?.[0];
    let vpcCidr: string | undefined;
    if (vpcId && vSwitchId) {
      try {
        const switches = await this.ecs.describeVSwitches(
          new DescribeVSwitchesRequest({ regionId: region, vpcId, vSwitchId }),
        );
        vpcCidr = switches.body?.vSwitches?.vSwitch?.[0]?.cidrBlock || undefined;
      } catch {
        // optional
      }
    }
    return {
      vpcId,
      vSwitchId,
      zoneId: instance.zoneId || undefined,
      privateIp,
      vpcCidr,
    };
  }

  private async findEcsByPublicIp(
    publicIp: string,
    region: string,
  ): Promise<{
    vpcId?: string;
    vSwitchId?: string;
    zoneId?: string;
    privateIp?: string;
    vpcCidr?: string;
  } | null> {
    const response = await this.ecs.describeInstances(
      new DescribeInstancesRequest({
        regionId: region,
        publicIpAddresses: JSON.stringify([publicIp]),
        pageSize: 10,
      }),
    );
    const instance = response.body?.instances?.instance?.[0];
    if (!instance?.instanceId) return null;
    return this.describeEcsNetwork(instance.instanceId, region);
  }
}

function mapRdsStatus(raw?: string): DatabaseInstanceStatus {
  switch ((raw || '').toLowerCase()) {
    case 'running':
      return 'RUNNING';
    case 'creating':
    case 'rebooting':
    case 'restoring':
    case 'modifying':
      return 'CREATING';
    case 'deleting':
      return 'DELETING';
    case 'deleted':
      return 'DELETED';
    default:
      return raw ? 'UNKNOWN' : 'FAILED';
  }
}

function sanitizeWhitelist(list: string): string {
  return list
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter((item) => item && item !== '0.0.0.0/0' && item !== '::/0')
    .join(',');
}

function uniqueIps(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function wrapRdsError(error: unknown): Error {
  const message = readErrorMessage(error);
  return new Error(`Aliyun RDS: ${message}`);
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'object' && error !== null) {
    const record = error as { message?: string; data?: { Message?: string; Code?: string } };
    return [record.data?.Code, record.data?.Message, record.message].filter(Boolean).join(' ') || 'request failed';
  }
  return 'request failed';
}

function isSpecUnavailable(error: unknown): boolean {
  const message = readErrorMessage(error).toLowerCase();
  return (
    message.includes('invaliddbinstanceclass') ||
    message.includes('instance class') ||
    message.includes('notavailable') ||
    message.includes('not supported')
  );
}

function isNotFound(error: unknown): boolean {
  const message = readErrorMessage(error).toLowerCase();
  return message.includes('invaliddbinstanceid') || message.includes('not found');
}

function isAlreadyExists(error: unknown): boolean {
  const message = readErrorMessage(error).toLowerCase();
  return (
    message.includes('already') ||
    message.includes('exists') ||
    message.includes('duplicat') ||
    message.includes('invaliddbname.duplicate') ||
    message.includes('invalidaccountname.duplicate') ||
    message.includes('otherendpoint.exist')
  );
}

/** Keep a lightweight existence probe for recovery. */
export async function listRdsInstancesByDescription(
  provider: AlibabaCloudDatabaseProvider,
  region: string,
  descriptionPrefix: string,
): Promise<Array<{ dbInstanceId: string; status?: string; createTime?: string; description?: string }>> {
  const client = (provider as unknown as { rds: RdsClient }).rds;
  const response = await client.describeDBInstances(
    new DescribeDBInstancesRequest({
      regionId: region,
      searchKey: descriptionPrefix,
      pageSize: 20,
    }),
  );
  return (response.body?.items?.DBInstance ?? [])
    .map((item) => {
      const raw = item as {
        DBInstanceId?: string;
        DBInstanceStatus?: string;
        DBInstanceDescription?: string;
        createTime?: string;
        CreateTime?: string;
      };
      return {
        dbInstanceId: raw.DBInstanceId || '',
        status: raw.DBInstanceStatus,
        createTime: raw.createTime || raw.CreateTime,
        description: raw.DBInstanceDescription,
      };
    })
    .filter((item) => Boolean(item.dbInstanceId));
}
