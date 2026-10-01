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
} from '@alicloud/ecs20140526';
import { $OpenApiUtil } from '@alicloud/openapi-core';
import type {
  BindDomainInput,
  CloudProvider,
  CreateServerInput,
  DomainBinding,
  NetworkInstance,
  ServerInstance,
  ServerStatus,
} from '../core/provider.interface';

export type RealCloudProviderOptions = {
  accessKey: string;
  secretKey: string;
  region?: string;
};

const DEFAULT_REGION = 'cn-hangzhou';
const SECURITY_GROUP_NAME = 'launchos-sg';
const VPC_NAME = 'launchos-vpc';
const POLL_INTERVAL_MS = 4000;
const POLL_ATTEMPTS = 45;

export class RealCloudProvider implements CloudProvider {
  readonly name = 'ALIYUN';
  private readonly region: string;
  private readonly client: EcsClient;

  constructor(options: RealCloudProviderOptions) {
    this.region = options.region?.trim() || DEFAULT_REGION;
    const config = new $OpenApiUtil.Config({
      accessKeyId: options.accessKey,
      accessKeySecret: options.secretKey,
    });
    config.endpoint = `ecs.${this.region}.aliyuncs.com`;
    this.client = new EcsClient(config);
  }

  async createServer(input: CreateServerInput = {}): Promise<ServerInstance> {
    const region = input.region?.trim() || this.region;
    const network = await this.ensureNetwork(region);
    const imageId = await this.pickImageId(region);
    const instanceTypes = instanceTypeCandidates(input.instanceType);
    const diskSize = String(Math.max(input.diskSizeGb ?? 40, 40));
    const password = randomInstancePassword();
    const name = input.name?.trim() || `launchos-${Date.now().toString(36)}`;

    let lastError: unknown;
    for (const instanceType of instanceTypes) {
      try {
        const instanceId = await this.runInstance({
          region,
          imageId,
          instanceType,
          securityGroupId: network.securityGroupId,
          vSwitchId: network.vSwitchId,
          name,
          password,
          diskSize,
        });
        const ready = await this.waitUntilRunning(instanceId, region);
        return {
          externalId: instanceId,
          ip: ready.ip,
          status: 'RUNNING',
          region,
          instanceType: ready.instanceType || instanceType,
          username: 'root',
          loginPassword: password,
        };
      } catch (error) {
        lastError = error;
        if (!isRetryableInstanceTypeError(error)) {
          throw wrapAliyunError(error);
        }
      }
    }

    throw wrapAliyunError(lastError);
  }

  async deleteServer(externalId: string): Promise<void> {
    try {
      await this.client.deleteInstance(
        new DeleteInstanceRequest({
          instanceId: externalId,
          force: true,
        }),
      );
    } catch (error) {
      if (isNotFoundError(error)) {
        return;
      }
      throw wrapAliyunError(error);
    }
  }

  async getServerStatus(externalId: string): Promise<ServerStatus> {
    const instance = await this.describeInstance(externalId, this.region);
    if (!instance) {
      return { externalId, status: 'FAILED', ip: '' };
    }
    return {
      externalId,
      status: mapAliyunStatus(instance.status),
      ip: instance.ip,
    };
  }

  async createNetwork(): Promise<NetworkInstance> {
    const network = await this.ensureNetwork(this.region);
    return {
      externalId: network.vpcId,
      status: 'RUNNING',
    };
  }

  async bindDomain(input: BindDomainInput): Promise<DomainBinding> {
    return {
      domain: input.domain,
      serverExternalId: input.serverExternalId,
      status: 'SKIPPED',
    };
  }

  private async runInstance(input: {
    region: string;
    imageId: string;
    instanceType: string;
    securityGroupId: string;
    vSwitchId: string;
    name: string;
    password: string;
    diskSize: string;
  }): Promise<string> {
    const response = await this.client.runInstances(
      new RunInstancesRequest({
        regionId: input.region,
        imageId: input.imageId,
        instanceType: input.instanceType,
        securityGroupId: input.securityGroupId,
        vSwitchId: input.vSwitchId,
        instanceName: input.name,
        instanceChargeType: 'PostPaid',
        internetChargeType: 'PayByTraffic',
        internetMaxBandwidthOut: 5,
        amount: 1,
        password: input.password,
        systemDisk: {
          category: 'cloud_essd',
          size: input.diskSize,
        },
      }),
    );
    const instanceId = response.body?.instanceIdSets?.instanceIdSet?.[0];
    if (!instanceId) {
      throw new Error('RunInstances did not return an instance id');
    }
    return instanceId;
  }

  private async waitUntilRunning(
    instanceId: string,
    region: string,
  ): Promise<{ ip: string; instanceType?: string }> {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
      const instance = await this.describeInstance(instanceId, region);
      if (instance?.status === 'Running') {
        let ip = instance.ip;
        if (!ip) {
          ip = await this.allocatePublicIp(instanceId);
        }
        if (ip) {
          return { ip, instanceType: instance.instanceType };
        }
      }
      await delay(POLL_INTERVAL_MS);
    }
    throw new Error(`Timed out waiting for instance ${instanceId} to become Running with a public IP`);
  }

  private async allocatePublicIp(instanceId: string): Promise<string> {
    try {
      const response = await this.client.allocatePublicIpAddress(
        new AllocatePublicIpAddressRequest({ instanceId }),
      );
      return response.body?.ipAddress?.trim() || '';
    } catch (error) {
      if (isAlreadyHasPublicIpError(error)) {
        const instance = await this.describeInstance(instanceId, this.region);
        return instance?.ip ?? '';
      }
      throw error;
    }
  }

  private async describeInstance(
    instanceId: string,
    region: string,
  ): Promise<{ status?: string; ip: string; instanceType?: string } | null> {
    const response = await this.client.describeInstances(
      new DescribeInstancesRequest({
        regionId: region,
        instanceIds: JSON.stringify([instanceId]),
      }),
    );
    const instance = response.body?.instances?.instance?.[0];
    if (!instance) {
      return null;
    }
    const ip =
      instance.publicIpAddress?.ipAddress?.[0]?.trim() ||
      instance.eipAddress?.ipAddress?.trim() ||
      '';
    return {
      status: instance.status,
      ip,
      instanceType: instance.instanceType,
    };
  }

  private async pickImageId(region: string): Promise<string> {
    const response = await this.client.describeImages(
      new DescribeImagesRequest({
        regionId: region,
        imageOwnerAlias: 'system',
        OSType: 'linux',
        architecture: 'x86_64',
        status: 'Available',
        pageSize: 50,
      }),
    );
    const images = response.body?.images?.image ?? [];
    const ubuntu = images.find((image) => image.imageName?.toLowerCase().includes('ubuntu'));
    const imageId = ubuntu?.imageId ?? images[0]?.imageId;
    if (!imageId) {
      throw new Error(`No available Linux image in ${region}`);
    }
    return imageId;
  }

  private async ensureNetwork(region: string): Promise<{
    vpcId: string;
    vSwitchId: string;
    securityGroupId: string;
  }> {
    const vpcId = await this.ensureVpc(region);
    const vSwitchId = await this.ensureVSwitch(region, vpcId);
    const securityGroupId = await this.ensureSecurityGroup(region, vpcId);
    return { vpcId, vSwitchId, securityGroupId };
  }

  private async ensureVpc(region: string): Promise<string> {
    const listed = await this.client.describeVpcs(
      new DescribeVpcsRequest({ regionId: region, pageSize: 50 }),
    );
    const vpcs = listed.body?.vpcs?.vpc ?? [];
    const available =
      vpcs.find((vpc) => vpc.status === 'Available' && vpc.isDefault) ??
      vpcs.find((vpc) => vpc.status === 'Available' && vpc.vpcName === VPC_NAME) ??
      vpcs.find((vpc) => vpc.status === 'Available');
    if (available?.vpcId) {
      return available.vpcId;
    }

    const created = await this.client.createVpc(
      new CreateVpcRequest({
        regionId: region,
        cidrBlock: '172.16.0.0/16',
        vpcName: VPC_NAME,
      }),
    );
    const vpcId = created.body?.vpcId;
    if (!vpcId) {
      throw new Error('CreateVpc did not return a vpc id');
    }
    await this.waitForVpc(region, vpcId);
    return vpcId;
  }

  private async waitForVpc(region: string, vpcId: string): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const listed = await this.client.describeVpcs(
        new DescribeVpcsRequest({ regionId: region, vpcId }),
      );
      if (listed.body?.vpcs?.vpc?.[0]?.status === 'Available') {
        return;
      }
      await delay(2000);
    }
    throw new Error(`Timed out waiting for VPC ${vpcId}`);
  }

  private async ensureVSwitch(region: string, vpcId: string): Promise<string> {
    const listed = await this.client.describeVSwitches(
      new DescribeVSwitchesRequest({ regionId: region, vpcId, pageSize: 50 }),
    );
    const existing = listed.body?.vSwitches?.vSwitch?.find(
      (item) => item.status === 'Available' && item.vSwitchId,
    );
    if (existing?.vSwitchId) {
      return existing.vSwitchId;
    }

    const zones = await this.client.describeZones(new DescribeZonesRequest({ regionId: region }));
    const zoneId = zones.body?.zones?.zone?.[0]?.zoneId;
    if (!zoneId) {
      throw new Error(`No zone available in ${region}`);
    }

    const created = await this.client.createVSwitch(
      new CreateVSwitchRequest({
        regionId: region,
        vpcId,
        zoneId,
        cidrBlock: '172.16.0.0/24',
        vSwitchName: 'launchos-vswitch',
      }),
    );
    const vSwitchId = created.body?.vSwitchId;
    if (!vSwitchId) {
      throw new Error('CreateVSwitch did not return a vSwitch id');
    }
    return vSwitchId;
  }

  private async ensureSecurityGroup(region: string, vpcId: string): Promise<string> {
    const listed = await this.client.describeSecurityGroups(
      new DescribeSecurityGroupsRequest({
        regionId: region,
        vpcId,
        securityGroupName: SECURITY_GROUP_NAME,
      }),
    );
    const existing = listed.body?.securityGroups?.securityGroup?.[0]?.securityGroupId;
    if (existing) {
      return existing;
    }

    const created = await this.client.createSecurityGroup(
      new CreateSecurityGroupRequest({
        regionId: region,
        vpcId,
        securityGroupName: SECURITY_GROUP_NAME,
        description: 'LaunchOS server security group',
      }),
    );
    const securityGroupId = created.body?.securityGroupId;
    if (!securityGroupId) {
      throw new Error('CreateSecurityGroup did not return a security group id');
    }

    await this.client.authorizeSecurityGroup(
      new AuthorizeSecurityGroupRequest({
        regionId: region,
        securityGroupId,
        permissions: [
          {
            ipProtocol: 'tcp',
            portRange: '22/22',
            sourceCidrIp: '0.0.0.0/0',
            policy: 'accept',
            priority: '1',
          },
          {
            ipProtocol: 'tcp',
            portRange: '80/80',
            sourceCidrIp: '0.0.0.0/0',
            policy: 'accept',
            priority: '1',
          },
          {
            ipProtocol: 'tcp',
            portRange: '443/443',
            sourceCidrIp: '0.0.0.0/0',
            policy: 'accept',
            priority: '1',
          },
        ],
      }),
    );

    return securityGroupId;
  }
}

function instanceTypeCandidates(preferred?: string): string[] {
  const defaults = [
    'ecs.t5-lc1m1.small',
    'ecs.e-c1m1.large',
    'ecs.t6-c1m1.large',
    'ecs.n4.small',
    'ecs.u1-c1m1.large',
  ];
  if (!preferred) {
    return defaults;
  }
  return [preferred, ...defaults.filter((item) => item !== preferred)];
}

function randomInstancePassword(): string {
  const token = randomBytes(8).toString('base64url');
  return `Launchos!${token}9`;
}

function mapAliyunStatus(status?: string): string {
  switch (status) {
    case 'Running':
      return 'RUNNING';
    case 'Stopped':
      return 'STOPPED';
    case 'Pending':
    case 'Starting':
      return 'CREATING';
    default:
      return status ? 'CREATING' : 'FAILED';
  }
}

function wrapAliyunError(error: unknown): Error {
  return new Error(`Aliyun ECS: ${readErrorMessage(error)}`);
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'object' && error !== null) {
    const record = error as { message?: string; data?: { Message?: string } };
    return record.data?.Message || record.message || 'request failed';
  }
  return 'request failed';
}

function isRetryableInstanceTypeError(error: unknown): boolean {
  const message = readErrorMessage(error).toLowerCase();
  return (
    message.includes('invalidinstancetype') ||
    message.includes('instance type') ||
    message.includes('notavailable') ||
    message.includes('not supported') ||
    message.includes('operationdenied')
  );
}

function isNotFoundError(error: unknown): boolean {
  const message = readErrorMessage(error).toLowerCase();
  return message.includes('invalidinstanceid') || message.includes('not found');
}

function isAlreadyHasPublicIpError(error: unknown): boolean {
  const message = readErrorMessage(error).toLowerCase();
  return message.includes('already') && message.includes('ip');
}

export function instanceTypesForPlan(cpu: number, memory: string): string {
  const gb = Number.parseInt(memory, 10);
  if (cpu >= 4 || gb >= 8) {
    return 'ecs.e-c1m2.xlarge';
  }
  if (cpu >= 2 || gb >= 4) {
    return 'ecs.e-c1m2.large';
  }
  return 'ecs.t5-lc1m1.small';
}
