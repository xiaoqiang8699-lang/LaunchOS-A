/**
 * Step 26.2 — Aliyun ECS create path (RunInstances + reconcile).
 * Planning/price remain in AlibabaCloudEcsPlanner; this module may create billable resources.
 */
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import EcsClient, {
  AllocatePublicIpAddressRequest,
  AuthorizeSecurityGroupRequest,
  CreateSecurityGroupRequest,
  CreateVpcRequest,
  CreateVSwitchRequest,
  DeleteInstanceRequest,
  DescribeImagesRequest,
  DescribeInstancesRequest,
  DescribeSecurityGroupsRequest,
  DescribeVpcsRequest,
  DescribeVSwitchesRequest,
  DescribeZonesRequest,
  RunInstancesRequest,
  TagResourcesRequest,
} from '@alicloud/ecs20140526';
import { $OpenApiUtil } from '@alicloud/openapi-core';

export type EcsResolvedPlan = {
  profile: string;
  regionId: string;
  zoneId: string | null;
  instanceType: string;
  cpu: number;
  memoryGb: number;
  systemDiskGb: number;
  systemDiskCategory: string;
  imageId: string;
  vpcId: string | null;
  vSwitchId: string | null;
  securityGroupId: string | null;
  chargeType: 'PostPaid';
};

export type EcsRunInstancesPreview = {
  regionId: string;
  zoneId: string | null;
  instanceType: string;
  imageId: string;
  systemDisk: { category: string; size: number };
  internetChargeType: string;
  internetMaxBandwidthOut: number;
  vpcId: string | null;
  vSwitchId: string | null;
  securityGroupId: string | null;
  chargeType: 'PostPaid';
  instanceName: string;
  hostName: string | null;
  loginMode: 'PASSWORD' | 'KEY_PAIR';
  keyPairName: string | null;
  clientToken: string;
  tags: Array<{ key: string; value: string }>;
};

export type EcsProvisionerOptions = {
  accessKey: string;
  secretKey: string;
  region?: string;
};

const SECURITY_GROUP_NAME = 'launchos-sg';
const VPC_NAME = 'launchos-vpc';
const POLL_INTERVAL_MS = 5000;
const POLL_ATTEMPTS = 60;

export class AlibabaCloudEcsProvisioner {
  private readonly region: string;
  readonly client: EcsClient;

  constructor(options: EcsProvisionerOptions) {
    this.region = options.region?.trim() || 'cn-hangzhou';
    const config = new $OpenApiUtil.Config({
      accessKeyId: options.accessKey,
      accessKeySecret: options.secretKey,
    });
    config.endpoint = `ecs.${this.region}.aliyuncs.com`;
    this.client = new EcsClient(config);
  }

  buildPreview(input: {
    plan: EcsResolvedPlan;
    instanceName: string;
    clientToken: string;
    securityGroupId: string | null;
    tags: Array<{ key: string; value: string }>;
  }): EcsRunInstancesPreview {
    return {
      regionId: input.plan.regionId,
      zoneId: input.plan.zoneId,
      instanceType: input.plan.instanceType,
      imageId: input.plan.imageId,
      systemDisk: {
        category: input.plan.systemDiskCategory,
        size: input.plan.systemDiskGb,
      },
      internetChargeType: 'PayByTraffic',
      internetMaxBandwidthOut: 5,
      vpcId: input.plan.vpcId,
      vSwitchId: input.plan.vSwitchId,
      securityGroupId: input.securityGroupId || input.plan.securityGroupId,
      chargeType: 'PostPaid',
      instanceName: input.instanceName,
      hostName: null,
      loginMode: 'PASSWORD',
      keyPairName: null,
      clientToken: input.clientToken.slice(0, 64),
      tags: input.tags,
    };
  }

  async ensureNetwork(input: {
    regionId: string;
    preferredVpcId?: string | null;
    preferredVSwitchId?: string | null;
  }): Promise<{ vpcId: string; vSwitchId: string; zoneId: string | null }> {
    const regionId = input.regionId || this.region;
    let vpcId = input.preferredVpcId?.trim() || '';
    if (!vpcId) {
      vpcId = await this.ensureVpc(regionId);
    }
    let vSwitchId = input.preferredVSwitchId?.trim() || '';
    let zoneId: string | null = null;
    if (vSwitchId) {
      const listed = await this.client.describeVSwitches(
        new DescribeVSwitchesRequest({ regionId, vpcId, pageSize: 50 }),
      );
      const hit = (listed.body?.vSwitches?.vSwitch || []).find((s) => s.vSwitchId === vSwitchId);
      zoneId = hit?.zoneId || null;
    } else {
      const ensured = await this.ensureVSwitch(regionId, vpcId);
      vSwitchId = ensured.vSwitchId;
      zoneId = ensured.zoneId;
    }
    return { vpcId, vSwitchId, zoneId };
  }

  /**
   * Read-only. Does not CreateSecurityGroup or AuthorizeSecurityGroup.
   * Real create calls ensureSecurityGroup() in PREPARING_SECURITY_GROUP.
   */
  async previewSecurityGroup(
    regionId: string,
    vpcId: string | null,
  ): Promise<{ mode: 'REUSE' | 'CREATE'; securityGroupId: string | null }> {
    if (!vpcId?.trim()) {
      return { mode: 'CREATE', securityGroupId: null };
    }
    const listed = await this.client.describeSecurityGroups(
      new DescribeSecurityGroupsRequest({ regionId, vpcId, pageSize: 50 }),
    );
    const existing = (listed.body?.securityGroups?.securityGroup || []).find(
      (g) => g.securityGroupName === SECURITY_GROUP_NAME && g.securityGroupId,
    );
    if (existing?.securityGroupId) {
      return { mode: 'REUSE', securityGroupId: existing.securityGroupId };
    }
    return { mode: 'CREATE', securityGroupId: null };
  }

  async ensureSecurityGroup(regionId: string, vpcId: string): Promise<string> {
    let listed;
    try {
      listed = await this.client.describeSecurityGroups(
        new DescribeSecurityGroupsRequest({ regionId, vpcId, pageSize: 50 }),
      );
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        failedOperation: 'DescribeSecurityGroups',
      });
    }
    const existing = (listed.body?.securityGroups?.securityGroup || []).find(
      (g) => g.securityGroupName === SECURITY_GROUP_NAME && g.securityGroupId,
    );
    if (existing?.securityGroupId) {
      await this.ensureIngressRules(regionId, existing.securityGroupId);
      return existing.securityGroupId;
    }
    let securityGroupId: string | undefined;
    try {
      const created = await this.client.createSecurityGroup(
        new CreateSecurityGroupRequest({
          regionId,
          vpcId,
          securityGroupName: SECURITY_GROUP_NAME,
          description: 'LaunchOS managed security group (22/80/443 only)',
        }),
      );
      securityGroupId = created.body?.securityGroupId;
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        failedOperation: 'CreateSecurityGroup',
      });
    }
    if (!securityGroupId) throw new Error('CreateSecurityGroup failed');
    await this.ensureIngressRules(regionId, securityGroupId);
    return securityGroupId;
  }

  async assertImageAvailable(regionId: string, imageId: string): Promise<void> {
    const response = await this.client.describeImages(
      new DescribeImagesRequest({
        regionId,
        imageId,
        status: 'Available',
        pageSize: 10,
      }),
    );
    const image = response.body?.images?.image?.[0];
    if (!image?.imageId) {
      throw Object.assign(new Error(`Image unavailable: ${imageId}`), {
        code: 'IMAGE_UNAVAILABLE',
      });
    }
  }

  /**
   * RunInstances once with ClientToken. Caller must increment attempt counters
   * immediately before this call (not after success).
   */
  async runInstance(input: {
    regionId: string;
    imageId: string;
    instanceType: string;
    securityGroupId: string;
    vSwitchId: string;
    instanceName: string;
    password: string;
    systemDiskGb: number;
    systemDiskCategory: string;
    clientToken: string;
    tags: Array<{ key: string; value: string }>;
  }): Promise<{ instanceId: string; requestId: string | null }> {
    const response = await this.client.runInstances(
      new RunInstancesRequest({
        regionId: input.regionId,
        imageId: input.imageId,
        instanceType: input.instanceType,
        securityGroupId: input.securityGroupId,
        vSwitchId: input.vSwitchId,
        instanceName: input.instanceName,
        instanceChargeType: 'PostPaid',
        internetChargeType: 'PayByTraffic',
        internetMaxBandwidthOut: 5,
        amount: 1,
        password: input.password,
        clientToken: input.clientToken.slice(0, 64),
        systemDisk: {
          category: input.systemDiskCategory || 'cloud_essd',
          size: String(Math.max(input.systemDiskGb, 40)),
        },
        tag: input.tags.map((t) => ({ key: t.key, value: t.value })),
      }),
    );
    const instanceId = response.body?.instanceIdSets?.instanceIdSet?.[0];
    if (!instanceId) {
      throw new Error('RunInstances did not return an instance id');
    }
    // Best-effort tag reinforce (some regions ignore run tags)
    try {
      await this.client.tagResources(
        new TagResourcesRequest({
          regionId: input.regionId,
          resourceType: 'instance',
          resourceId: [instanceId],
          tag: input.tags.map((t) => ({ key: t.key, value: t.value })),
        }),
      );
    } catch {
      // non-fatal
    }
    return {
      instanceId,
      requestId: response.body?.requestId || null,
    };
  }

  async waitUntilRunning(
    instanceId: string,
    regionId: string,
  ): Promise<{
    status: string;
    publicIp: string;
    privateIp: string | null;
    instanceType: string | null;
  }> {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
      const instance = await this.describeInstance(instanceId, regionId);
      if (!instance) {
        await delay(POLL_INTERVAL_MS);
        continue;
      }
      if (instance.status === 'Running') {
        let publicIp = instance.publicIp;
        if (!publicIp) {
          publicIp = await this.allocatePublicIp(instanceId);
        }
        if (!publicIp) {
          await delay(POLL_INTERVAL_MS);
          continue;
        }
        return {
          status: 'Running',
          publicIp,
          privateIp: instance.privateIp,
          instanceType: instance.instanceType,
        };
      }
      if (instance.status === 'Stopped') {
        throw new Error(`ECS instance ${instanceId} is Stopped`);
      }
      await delay(POLL_INTERVAL_MS);
    }
    throw Object.assign(
      new Error(`Timed out waiting for ECS ${instanceId} Running+publicIp`),
      { code: 'PROVIDER_TIMEOUT' },
    );
  }

  async allocatePublicIp(instanceId: string): Promise<string> {
    try {
      const response = await this.client.allocatePublicIpAddress(
        new AllocatePublicIpAddressRequest({ instanceId }),
      );
      return response.body?.ipAddress?.trim() || '';
    } catch (error) {
      const message = String((error as Error)?.message || error).toLowerCase();
      if (message.includes('already') && message.includes('ip')) {
        return '';
      }
      throw error;
    }
  }

  async describeInstance(
    instanceId: string,
    regionId: string,
  ): Promise<{
    status?: string;
    publicIp: string;
    privateIp: string | null;
    instanceType: string | null;
    instanceName: string | null;
  } | null> {
    const response = await this.client.describeInstances(
      new DescribeInstancesRequest({
        regionId,
        instanceIds: JSON.stringify([instanceId]),
      }),
    );
    const instance = response.body?.instances?.instance?.[0];
    if (!instance) return null;
    return {
      status: instance.status,
      publicIp:
        instance.publicIpAddress?.ipAddress?.[0]?.trim() ||
        instance.eipAddress?.ipAddress?.trim() ||
        '',
      privateIp: instance.vpcAttributes?.privateIpAddress?.ipAddress?.[0] || null,
      instanceType: instance.instanceType || null,
      instanceName: instance.instanceName || null,
    };
  }

  /** Reconcile by instanceName + LaunchOS tags. */
  async reconcileManagedInstances(input: {
    regionId: string;
    instanceName: string;
    cloudResourceId: string;
  }): Promise<
    Array<{
      instanceId: string;
      status: string | null;
      publicIp: string;
    }>
  > {
    const response = await this.client.describeInstances(
      new DescribeInstancesRequest({
        regionId: input.regionId,
        instanceName: input.instanceName,
        pageSize: 50,
      }),
    );
    const matches = [];
    for (const instance of response.body?.instances?.instance || []) {
      if (!instance.instanceId) continue;
      const tags = instance.tags?.tag || [];
      const managed = tags.some(
        (t) => t.tagKey === 'launchos:managed' && String(t.tagValue) === 'true',
      );
      const cr = tags.some(
        (t) =>
          t.tagKey === 'launchos:cloudResourceId' &&
          String(t.tagValue) === input.cloudResourceId,
      );
      if (managed || cr || instance.instanceName === input.instanceName) {
        matches.push({
          instanceId: instance.instanceId,
          status: instance.status || null,
          publicIp:
            instance.publicIpAddress?.ipAddress?.[0]?.trim() ||
            instance.eipAddress?.ipAddress?.trim() ||
            '',
        });
      }
    }
    // Prefer exact cloudResourceId tag matches when present; otherwise name matches
    return matches;
  }

  async deleteInstance(instanceId: string): Promise<void> {
    await this.client.deleteInstance(
      new DeleteInstanceRequest({ instanceId, force: true }),
    );
  }

  private async ensureIngressRules(regionId: string, securityGroupId: string): Promise<void> {
    const ports = ['22/22', '80/80', '443/443'];
    for (const portRange of ports) {
      try {
        await this.client.authorizeSecurityGroup(
          new AuthorizeSecurityGroupRequest({
            regionId,
            securityGroupId,
            ipProtocol: 'tcp',
            portRange,
            sourceCidrIp: '0.0.0.0/0',
            policy: 'accept',
            priority: '1',
          }),
        );
      } catch (error) {
        const message = String((error as Error)?.message || error).toLowerCase();
        if (message.includes('invalidpermission.duplicate') || message.includes('already')) {
          continue;
        }
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
          failedOperation: 'AuthorizeSecurityGroup',
        });
      }
    }
  }

  private async ensureVpc(regionId: string): Promise<string> {
    const listed = await this.client.describeVpcs(
      new DescribeVpcsRequest({ regionId, pageSize: 50 }),
    );
    const vpcs = listed.body?.vpcs?.vpc ?? [];
    const available =
      vpcs.find((vpc) => vpc.status === 'Available' && vpc.vpcName === VPC_NAME) ??
      vpcs.find((vpc) => vpc.status === 'Available' && vpc.isDefault) ??
      vpcs.find((vpc) => vpc.status === 'Available');
    if (available?.vpcId) return available.vpcId;
    const created = await this.client.createVpc(
      new CreateVpcRequest({
        regionId,
        cidrBlock: '172.16.0.0/16',
        vpcName: VPC_NAME,
      }),
    );
    const vpcId = created.body?.vpcId;
    if (!vpcId) throw new Error('CreateVpc failed');
    for (let i = 0; i < 20; i += 1) {
      const ready = await this.client.describeVpcs(
        new DescribeVpcsRequest({ regionId, vpcId }),
      );
      if (ready.body?.vpcs?.vpc?.[0]?.status === 'Available') break;
      await delay(2000);
    }
    return vpcId;
  }

  private async ensureVSwitch(
    regionId: string,
    vpcId: string,
  ): Promise<{ vSwitchId: string; zoneId: string | null }> {
    const listed = await this.client.describeVSwitches(
      new DescribeVSwitchesRequest({ regionId, vpcId, pageSize: 50 }),
    );
    const existing = (listed.body?.vSwitches?.vSwitch || []).find((s) => s.vSwitchId);
    if (existing?.vSwitchId) {
      return { vSwitchId: existing.vSwitchId, zoneId: existing.zoneId || null };
    }
    const zones = await this.client.describeZones(new DescribeZonesRequest({ regionId }));
    const zoneId = zones.body?.zones?.zone?.[0]?.zoneId;
    if (!zoneId) throw new Error('No zone available for VSwitch');
    const created = await this.client.createVSwitch(
      new CreateVSwitchRequest({
        regionId,
        vpcId,
        zoneId,
        cidrBlock: '172.16.0.0/24',
        vSwitchName: 'launchos-vswitch',
      }),
    );
    const vSwitchId = created.body?.vSwitchId;
    if (!vSwitchId) throw new Error('CreateVSwitch failed');
    return { vSwitchId, zoneId };
  }
}

export function randomEcsLoginPassword(): string {
  const token = randomBytes(8).toString('base64url');
  return `Launchos!${token}9`;
}
