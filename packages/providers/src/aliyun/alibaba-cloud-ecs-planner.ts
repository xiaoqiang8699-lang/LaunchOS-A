/**
 * Step 26.1 — Aliyun ECS planning (SKU discovery + price). Never calls RunInstances.
 */
import EcsClient, {
  DescribeAvailableResourceRequest,
  DescribeImagesRequest,
  DescribeInstanceTypesRequest,
  DescribeInstancesRequest,
  DescribePriceRequest,
  DescribePriceRequestSystemDisk,
  DescribeVpcsRequest,
  DescribeVSwitchesRequest,
  DescribeZonesRequest,
} from '@alicloud/ecs20140526';
import { $OpenApiUtil } from '@alicloud/openapi-core';

export type ServerProfile = 'DEV' | 'STANDARD' | 'PRODUCTION';

const PROFILE_NEED: Record<ServerProfile, { label: string; vcpu: number; memoryGb: number; systemDiskGb: number }> = {
  DEV: { label: '开发测试', vcpu: 1, memoryGb: 2, systemDiskGb: 40 },
  STANDARD: { label: '标准', vcpu: 2, memoryGb: 4, systemDiskGb: 60 },
  PRODUCTION: { label: '生产', vcpu: 4, memoryGb: 8, systemDiskGb: 80 },
};

function selectLowestMatchingSku<T extends { cpu: number; memoryGb: number; instanceType: string }>(
  candidates: T[],
  profile: ServerProfile,
): T | null {
  const need = PROFILE_NEED[profile];
  const ok = candidates
    .filter((c) => c.cpu >= need.vcpu && c.memoryGb >= need.memoryGb)
    .sort(
      (a, b) =>
        a.cpu - b.cpu || a.memoryGb - b.memoryGb || a.instanceType.localeCompare(b.instanceType),
    );
  return ok[0] || null;
}

export type EcsPlannerOptions = {
  accessKey: string;
  secretKey: string;
  region?: string;
};

export type EcsAvailableSpec = {
  instanceType: string;
  cpu: number;
  memoryGb: number;
  architecture: string;
  zoneId: string | null;
  available: boolean;
  chargeType: 'PostPaid';
};

export type EcsResolvedSku = {
  profile: ServerProfile;
  instanceType: string;
  cpu: number;
  memoryGb: number;
  systemDiskGb: number;
  architecture: string;
  zoneId: string | null;
  chargeType: 'PostPaid';
  selectionReason: string;
};

export type EcsPriceEstimate = {
  available: boolean;
  currency: string | null;
  originalPrice: string | null;
  tradePrice: string | null;
  discountPrice: string | null;
  billingCycle: 'Hour' | 'Month' | 'UNKNOWN';
  hourlyPrice: string | null;
  monthlyEquivalent: string | null;
  chargeType: 'PostPaid';
  instanceType: string | null;
  checkedAt: string;
  providerRequestId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
};

export type EcsImageRecommendation = {
  imageId: string;
  imageName: string;
  osName: string;
  productLabel: string;
};

export type EcsPlacementHint = {
  regionId: string;
  zoneId: string | null;
  vpcId: string | null;
  vSwitchId: string | null;
  reason: string;
};

export class AlibabaCloudEcsPlanner {
  private readonly region: string;
  private readonly client: EcsClient;

  constructor(options: EcsPlannerOptions) {
    this.region = options.region?.trim() || 'cn-hangzhou';
    const config = new $OpenApiUtil.Config({
      accessKeyId: options.accessKey,
      accessKeySecret: options.secretKey,
    });
    config.endpoint = `ecs.${this.region}.aliyuncs.com`;
    this.client = new EcsClient(config);
  }

  /**
   * Discover purchasable PostPaid x86 instance types in region via real OpenAPI.
   * Does not hardcode permanent instanceType lists as the only source.
   */
  async listAvailableServerSpecs(region?: string): Promise<EcsAvailableSpec[]> {
    const regionId = region?.trim() || this.region;
    const availableTypes = await this.describeAvailableInstanceTypes(regionId);
    if (availableTypes.size === 0) return [];

    const details = await this.describeInstanceTypeDetails([...availableTypes.keys()]);
    const out: EcsAvailableSpec[] = [];
    for (const [instanceType, zoneId] of availableTypes) {
      const detail = details.get(instanceType);
      if (!detail) continue;
      // Prefer x86_64 for LaunchOS runtime images
      if (detail.architecture && !/x86/i.test(detail.architecture)) continue;
      out.push({
        instanceType,
        cpu: detail.cpu,
        memoryGb: detail.memoryGb,
        architecture: detail.architecture || 'X86',
        zoneId,
        available: true,
        chargeType: 'PostPaid',
      });
    }
    return out.sort((a, b) => a.cpu - b.cpu || a.memoryGb - b.memoryGb);
  }

  async resolveServerSku(
    profile: ServerProfile,
    placement: { regionId?: string; zoneId?: string | null } = {},
  ): Promise<EcsResolvedSku | null> {
    const regionId = placement.regionId?.trim() || this.region;
    const need = PROFILE_NEED[profile];
    const specs = await this.listAvailableServerSpecs(regionId);
    const filtered = placement.zoneId
      ? specs.filter((s) => !s.zoneId || s.zoneId === placement.zoneId)
      : specs;
    const pick = selectLowestMatchingSku(filtered.length ? filtered : specs, profile);
    if (!pick) return null;
    return {
      profile,
      instanceType: pick.instanceType,
      cpu: pick.cpu,
      memoryGb: pick.memoryGb,
      systemDiskGb: need.systemDiskGb,
      architecture: pick.architecture,
      zoneId: pick.zoneId || placement.zoneId || null,
      chargeType: 'PostPaid',
      selectionReason: `在 ${regionId} 选择满足 ${need.label}（≥${need.vcpu} 核 / ≥${need.memoryGb}GB）且可售的最低规格 ${pick.instanceType}。`,
    };
  }

  async getPriceEstimate(input: {
    regionId?: string;
    instanceType: string;
    systemDiskGb: number;
    internetMaxBandwidthOut?: number;
  }): Promise<EcsPriceEstimate> {
    const regionId = input.regionId?.trim() || this.region;
    const checkedAt = new Date().toISOString();
    try {
      const response = await this.client.describePrice(
        new DescribePriceRequest({
          regionId,
          resourceType: 'instance',
          instanceType: input.instanceType,
          instanceNetworkType: 'vpc',
          internetChargeType: 'PayByTraffic',
          internetMaxBandwidthOut: input.internetMaxBandwidthOut ?? 5,
          systemDisk: new DescribePriceRequestSystemDisk({
            category: 'cloud_essd',
            size: input.systemDiskGb,
          }),
          instanceAmount: 1,
          priceUnit: 'Hour',
          period: 1,
        }),
      );
      const priceInfo = response.body?.priceInfo?.price;
      const currency = priceInfo?.currency ?? null;
      const originalPrice =
        priceInfo?.originalPrice != null ? String(priceInfo.originalPrice) : null;
      const tradePrice = priceInfo?.tradePrice != null ? String(priceInfo.tradePrice) : null;
      const discountPrice =
        priceInfo?.discountPrice != null ? String(priceInfo.discountPrice) : null;
      const hourly = tradePrice || originalPrice;
      const monthly =
        hourly != null && Number.isFinite(Number(hourly))
          ? (Number(hourly) * 30 * 24).toFixed(2)
          : null;
      return {
        available: Boolean(hourly),
        currency,
        originalPrice,
        tradePrice,
        discountPrice,
        billingCycle: 'Hour',
        hourlyPrice: hourly,
        monthlyEquivalent: monthly,
        chargeType: 'PostPaid',
        instanceType: input.instanceType,
        checkedAt,
        providerRequestId: response.body?.requestId || null,
      };
    } catch (error) {
      return {
        available: false,
        currency: null,
        originalPrice: null,
        tradePrice: null,
        discountPrice: null,
        billingCycle: 'UNKNOWN',
        hourlyPrice: null,
        monthlyEquivalent: null,
        chargeType: 'PostPaid',
        instanceType: input.instanceType,
        checkedAt,
        providerRequestId: null,
        errorCode: readErrorCode(error),
        errorMessage: sanitizeErrorMessage(error),
      };
    }
  }

  async recommendImage(region?: string): Promise<EcsImageRecommendation | null> {
    const regionId = region?.trim() || this.region;
    try {
      const preferred = await this.pickImage(regionId, 'alibaba');
      if (preferred) return preferred;
      return this.pickImage(regionId, 'ubuntu');
    } catch {
      return null;
    }
  }

  async listZones(region?: string): Promise<string[]> {
    const regionId = region?.trim() || this.region;
    const response = await this.client.describeZones(
      new DescribeZonesRequest({ regionId }),
    );
    return (response.body?.zones?.zone || [])
      .map((z) => z.zoneId)
      .filter((z): z is string => Boolean(z));
  }

  async resolvePlacement(input: {
    regionId?: string;
    preferredVpcId?: string | null;
    preferredZoneId?: string | null;
  }): Promise<EcsPlacementHint> {
    const regionId = input.regionId?.trim() || this.region;
    const vpcs = await this.describeVpcs(regionId);
    let vpcId = input.preferredVpcId || null;
    if (!vpcId) {
      vpcId =
        vpcs.find((v) => v.vpcName === 'launchos-vpc')?.vpcId ||
        vpcs.find((v) => v.isDefault)?.vpcId ||
        vpcs[0]?.vpcId ||
        null;
    }
    let vSwitchId: string | null = null;
    let zoneId = input.preferredZoneId || null;
    if (vpcId) {
      const switches = await this.describeVSwitches(regionId, vpcId);
      const matchZone = zoneId
        ? switches.find((s) => s.zoneId === zoneId)
        : undefined;
      const pick = matchZone || switches[0];
      vSwitchId = pick?.vSwitchId || null;
      zoneId = zoneId || pick?.zoneId || null;
    }
    if (!zoneId) {
      const zones = await this.listZones(regionId);
      zoneId = zones[0] || null;
    }
    return {
      regionId,
      zoneId,
      vpcId,
      vSwitchId,
      reason: vpcId
        ? '优先复用现有 VPC / 交换机，便于访问同地域依赖。'
        : '当前地域尚无 VPC，创建服务器时将一并准备网络。',
    };
  }

  /** Look up ECS by public IP for existing-server evaluation. Read-only. */
  async findInstanceByPublicIp(
    publicIp: string,
    region?: string,
  ): Promise<{ instanceId: string; cpu: number | null; memoryGb: number | null; instanceType: string | null; status: string | null } | null> {
    const regionId = region?.trim() || this.region;
    const ip = publicIp.trim();
    try {
      const response = await this.client.describeInstances(
        new DescribeInstancesRequest({
          regionId,
          publicIpAddresses: JSON.stringify([ip]),
          pageSize: 10,
        }),
      );
      const instance = response.body?.instances?.instance?.[0];
      if (instance?.instanceId) {
        return this.toInstanceSummary(instance);
      }
    } catch {
      // fall through to scan
    }

    // Fallback: scan recent instances and match public/eip
    try {
      const response = await this.client.describeInstances(
        new DescribeInstancesRequest({
          regionId,
          pageSize: 50,
        }),
      );
      for (const instance of response.body?.instances?.instance || []) {
        const publics = [
          ...(instance.publicIpAddress?.ipAddress || []),
          instance.eipAddress?.ipAddress,
        ].filter(Boolean);
        if (publics.includes(ip) && instance.instanceId) {
          return this.toInstanceSummary(instance);
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  private async toInstanceSummary(instance: {
    instanceId?: string;
    cpu?: number;
    memory?: number;
    instanceType?: string;
    status?: string;
  }) {
    let cpu: number | null = instance.cpu != null ? Number(instance.cpu) : null;
    let memoryGb: number | null =
      instance.memory != null ? Math.round(Number(instance.memory) / 1024) : null;
    if (instance.instanceType && (cpu == null || memoryGb == null)) {
      const details = await this.describeInstanceTypeDetails([instance.instanceType]);
      const d = details.get(instance.instanceType);
      if (d) {
        cpu = cpu ?? d.cpu;
        memoryGb = memoryGb ?? d.memoryGb;
      }
    }
    return {
      instanceId: instance.instanceId!,
      cpu,
      memoryGb,
      instanceType: instance.instanceType || null,
      status: instance.status || null,
    };
  }

  // --- private ---

  private async describeAvailableInstanceTypes(
    regionId: string,
  ): Promise<Map<string, string | null>> {
    const map = new Map<string, string | null>();
    try {
      const response = await this.client.describeAvailableResource(
        new DescribeAvailableResourceRequest({
          regionId,
          destinationResource: 'InstanceType',
          instanceChargeType: 'PostPaid',
        }),
      );
      const zones = response.body?.availableZones?.availableZone || [];
      for (const zone of zones) {
        const zoneId = zone.zoneId || null;
        const resources = zone.availableResources?.availableResource || [];
        for (const resource of resources) {
          const supported = resource.supportedResources?.supportedResource || [];
          for (const item of supported) {
            const status = (item.status || '').toLowerCase();
            if (status && status !== 'available' && status !== 'withstock') continue;
            const value = item.value?.trim();
            if (!value) continue;
            if (!map.has(value)) map.set(value, zoneId);
          }
        }
      }
    } catch {
      // Fall through — caller may still try DescribeInstanceTypes alone (less ideal).
    }
    return map;
  }

  private async describeInstanceTypeDetails(
    instanceTypes: string[],
  ): Promise<Map<string, { cpu: number; memoryGb: number; architecture: string }>> {
    const out = new Map<string, { cpu: number; memoryGb: number; architecture: string }>();
    const chunkSize = 10;
    for (let i = 0; i < instanceTypes.length; i += chunkSize) {
      const chunk = instanceTypes.slice(i, i + chunkSize);
      try {
        const response = await this.client.describeInstanceTypes(
          new DescribeInstanceTypesRequest({
            instanceTypes: chunk,
          }),
        );
        for (const item of response.body?.instanceTypes?.instanceType || []) {
          if (!item.instanceTypeId) continue;
          const cpu = Number(item.cpuCoreCount || 0);
          const memoryGb = Number(item.memorySize || 0);
          if (!cpu || !memoryGb) continue;
          out.set(item.instanceTypeId, {
            cpu,
            memoryGb,
            architecture: item.cpuArchitecture || 'X86',
          });
        }
      } catch {
        // skip chunk
      }
    }
    return out;
  }

  private async pickImage(
    regionId: string,
    kind: 'alibaba' | 'ubuntu',
  ): Promise<EcsImageRecommendation | null> {
    const response = await this.client.describeImages(
      new DescribeImagesRequest({
        regionId,
        status: 'Available',
        imageOwnerAlias: 'system',
        architecture: 'x86_64',
        OSType: 'linux',
        pageSize: 50,
      }),
    );
    const images = response.body?.images?.image || [];
    const scored = images
      .map((img) => {
        const name = `${img.imageName || ''} ${img.oSName || ''}`.toLowerCase();
        let score = 0;
        if (kind === 'alibaba') {
          if (name.includes('almalinux') || name.includes('alma linux')) {
            score -= 20;
          } else if (
            name.includes('alibaba cloud linux') ||
            name.includes('alibaba_cloud_linux') ||
            /(^|[^a-z])alinux([^a-z]|$)/.test(name) ||
            name.includes('alinux3') ||
            name.includes('alinux_3')
          ) {
            score += 10;
            if (name.includes('3.') || name.includes('alinux3') || name.includes('_3_')) score += 2;
          }
        } else {
          if (name.includes('ubuntu')) score += 10;
          if (name.includes('22.04') || name.includes('24.04')) score += 3;
        }
        if (name.includes('deprecated')) score -= 20;
        return { img, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    const best = scored[0]?.img;
    if (!best?.imageId) return null;
    return {
      imageId: best.imageId,
      imageName: best.imageName || best.imageId,
      osName: best.oSName || best.imageName || 'Linux',
      productLabel: '推荐系统',
    };
  }

  private async describeVpcs(regionId: string) {
    const response = await this.client.describeVpcs(
      new DescribeVpcsRequest({ regionId, pageSize: 50 }),
    );
    return (response.body?.vpcs?.vpc || []).map((v) => ({
      vpcId: v.vpcId || '',
      vpcName: v.vpcName || '',
      isDefault: Boolean(v.isDefault),
    }));
  }

  private async describeVSwitches(regionId: string, vpcId: string) {
    const response = await this.client.describeVSwitches(
      new DescribeVSwitchesRequest({ regionId, vpcId, pageSize: 50 }),
    );
    return (response.body?.vSwitches?.vSwitch || []).map((s) => ({
      vSwitchId: s.vSwitchId || '',
      zoneId: s.zoneId || null,
    }));
  }
}

function readErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const e = error as Record<string, unknown>;
  const code = e.code ?? (e.data as Record<string, unknown> | undefined)?.Code;
  return typeof code === 'string' ? code : null;
}

function sanitizeErrorMessage(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const e = error as Record<string, unknown>;
  const message = e.message;
  if (typeof message !== 'string') return null;
  return message.replace(/AccessKey\w*[:=]\S+/gi, '[redacted]').slice(0, 240);
}
