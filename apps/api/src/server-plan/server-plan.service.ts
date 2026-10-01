import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import {
  CloudResourceStatus,
  CloudResourceType,
  WorkspaceRole,
} from '@launchos/database';
import {
  ALIYUN_PROVIDER_TYPE,
  AlibabaCloudCapabilityService,
  AlibabaCloudEcsPlanner,
} from '@launchos/providers';
import {
  EXISTING_SERVER_FIT_LABELS,
  SERVER_PROFILE_LABELS,
  SERVER_READINESS_LABELS,
  SERVER_RESOURCE_PROFILES,
  analyzeServerRequirement,
  buildNetworkPlanDraft,
  buildServerInitPlan,
  evaluateExistingServer,
  pickRegionFromHints,
  type ExistingServerFit,
  type ServerProfile,
  type ServerReadiness,
  type ServerSource,
} from '@launchos/shared';
import { PrismaService } from '../database/prisma.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import { decryptProviderSecrets } from '../security/credential-cipher';

const WRITE_ROLES: WorkspaceRole[] = [WorkspaceRole.OWNER, WorkspaceRole.ADMIN, WorkspaceRole.MEMBER];

type PlanOverrides = {
  profile?: ServerProfile;
  region?: string;
  zoneId?: string;
  source?: ServerSource;
  existingServerId?: string;
  /** When true, ignore workspace ServerInstance rows (demo dry-run). Never deletes. */
  simulateNoServer?: boolean;
};

@Injectable()
export class ServerPlanService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaceAccess: WorkspaceAccessService,
  ) {}

  async getPlan(userId: string, projectId: string, overrides: PlanOverrides = {}) {
    const { membership, project } = await this.workspaceAccess.requireProjectAccess(
      userId,
      projectId,
    );
    return this.buildPlan(membership.workspaceId, projectId, project.name, overrides, {
      role: membership.role,
      userId,
    });
  }

  async updatePlan(userId: string, projectId: string, body: PlanOverrides) {
    const { membership, project } = await this.workspaceAccess.requireProjectAccess(
      userId,
      projectId,
    );
    if (!WRITE_ROLES.includes(membership.role)) {
      throw new ForbiddenException('当前角色无法调整服务器规划');
    }
    if (body.profile && !SERVER_RESOURCE_PROFILES[body.profile]) {
      throw new BadRequestException('无效的服务器档位');
    }
    const plan = await this.buildPlan(
      membership.workspaceId,
      projectId,
      project.name,
      body,
      { role: membership.role, userId },
    );

    await this.prisma.auditLog.create({
      data: {
        workspaceId: membership.workspaceId,
        userId,
        action:
          body.source === 'EXISTING'
            ? 'server_existing_selected'
            : body.source === 'MANAGED_CREATE'
              ? 'server_managed_create_selected'
              : body.profile
                ? 'server_profile_selected'
                : 'server_plan_viewed',
        metadata: {
          projectId,
          profile: plan.recommendation?.profile || null,
          region: plan.placement?.regionId || null,
          source: body.source || null,
          simulateNoServer: Boolean(body.simulateNoServer),
          readiness: plan.readiness,
        },
      },
    });

    return plan;
  }

  private async buildPlan(
    workspaceId: string,
    projectId: string,
    projectName: string,
    overrides: PlanOverrides,
    ctx: { role: WorkspaceRole; userId: string },
  ) {
    const units = await this.prisma.deployableUnit.findMany({
      where: { projectId },
      select: { id: true, name: true, type: true },
      orderBy: { createdAt: 'asc' },
    });

    const dependencyRegions = await this.collectDependencyRegions(projectId);
    const dependencyCount = await this.countRequiredDependencies(projectId);

    const env = await this.prisma.projectEnvironment.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
      select: { name: true, type: true },
    });

    const requirement = analyzeServerRequirement({
      units,
      environmentType: env?.type || env?.name,
      dependencyCount,
      preferProduction: /prod|生产/i.test(`${env?.type || ''} ${env?.name || ''}`),
    });

    const existingServers = overrides.simulateNoServer
      ? []
      : await this.prisma.serverInstance.findMany({
          where: { workspaceId, scope: 'WORKSPACE_OWNED' },
          orderBy: { updatedAt: 'desc' },
          select: {
            id: true,
            name: true,
            host: true,
            port: true,
            status: true,
            dockerStatus: true,
            provider: true,
          },
        });

    const selectedExisting =
      overrides.existingServerId
        ? existingServers.find((s) => s.id === overrides.existingServerId) || null
        : existingServers[0] || null;

    const profile: ServerProfile =
      overrides.profile || requirement.recommendedProfile || 'STANDARD';
    const profileDef = SERVER_RESOURCE_PROFILES[profile];

    const account = await this.prisma.providerAccount.findFirst({
      where: {
        workspaceId,
        status: 'ACTIVE',
        provider: { type: ALIYUN_PROVIDER_TYPE },
      },
      include: { provider: true },
      orderBy: { createdAt: 'asc' },
    });

    const cloudServer = await this.prisma.cloudResource.findFirst({
      where: {
        projectId,
        type: CloudResourceType.SERVER,
        status: { notIn: [CloudResourceStatus.DELETED] },
      },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, region: true, publicIp: true, instanceType: true, status: true },
    });

    const regionPick = pickRegionFromHints({
      userSelected: overrides.region,
      dependencyRegions,
      existingCloudServerRegion: cloudServer?.region,
      providerAccountRegion: account?.region,
      defaultRegion: process.env.ALIYUN_REGION || 'cn-hangzhou',
    });

    let planner: AlibabaCloudEcsPlanner | null = null;
    let capability: Awaited<
      ReturnType<AlibabaCloudCapabilityService['probe']>
    > | null = null;
    let secrets: { accessKey: string; secretKey: string } | null = null;

    if (account?.credentialEncrypted) {
      try {
        secrets = decryptProviderSecrets(account.credentialEncrypted);
        const cap = new AlibabaCloudCapabilityService();
        capability = await cap.probe(
          {
            accessKey: secrets.accessKey,
            secretKey: secrets.secretKey,
            region: regionPick.regionId,
          },
          { skipCreateDryRuns: true },
        );
        planner = new AlibabaCloudEcsPlanner({
          accessKey: secrets.accessKey,
          secretKey: secrets.secretKey,
          region: regionPick.regionId,
        });
      } catch {
        planner = null;
      }
    }

    const preferredVpc = await this.findDependencyVpc(projectId, regionPick.regionId);
    let placement = buildNetworkPlanDraft({
      regionId: regionPick.regionId,
      zoneId: overrides.zoneId || null,
      vpcId: preferredVpc.vpcId,
      vSwitchId: preferredVpc.vSwitchId,
      placementReason: preferredVpc.reason || regionPick.reason,
    });

    let image: {
      imageId: string;
      osName: string;
      productLabel: string;
    } | null = null;

    const tiers: Array<{
      profile: ServerProfile;
      label: string;
      vcpu: number;
      memoryGb: number;
      systemDiskGb: number;
      recommended: boolean;
      sku: {
        instanceType: string;
        cpu: number;
        memoryGb: number;
        zoneId: string | null;
        selectionReason: string;
      } | null;
      priceEstimate: {
        available: boolean;
        currency: string | null;
        hourlyPrice: string | null;
        monthlyEquivalent: string | null;
        chargeType: string;
        errorCode?: string | null;
      } | null;
      unavailableReason: string | null;
    }> = [];

    if (planner) {
      try {
        const resolvedPlacement = await planner.resolvePlacement({
          regionId: regionPick.regionId,
          preferredVpcId: preferredVpc.vpcId,
          preferredZoneId: overrides.zoneId || preferredVpc.zoneId,
        });
        placement = buildNetworkPlanDraft({
          regionId: resolvedPlacement.regionId,
          zoneId: resolvedPlacement.zoneId,
          vpcId: resolvedPlacement.vpcId,
          vSwitchId: resolvedPlacement.vSwitchId,
          placementReason: `${regionPick.reason} ${resolvedPlacement.reason}`.trim(),
        });
      } catch {
        // keep draft
      }

      try {
        const img = await planner.recommendImage(regionPick.regionId);
        if (img) {
          image = {
            imageId: img.imageId,
            osName: img.osName,
            productLabel: img.productLabel,
          };
        }
      } catch {
        image = null;
      }

      for (const p of ['DEV', 'STANDARD', 'PRODUCTION'] as ServerProfile[]) {
        const def = SERVER_RESOURCE_PROFILES[p];
        try {
          const sku = await planner.resolveServerSku(p, {
            regionId: regionPick.regionId,
            zoneId: placement.zoneId,
          });
          if (!sku) {
            tiers.push({
              profile: p,
              label: def.label,
              vcpu: def.vcpu,
              memoryGb: def.memoryGb,
              systemDiskGb: def.systemDiskGb,
              recommended: p === profile,
              sku: null,
              priceEstimate: null,
              unavailableReason: '当前地域暂无满足该档位的可售规格',
            });
            continue;
          }
          const price = await planner.getPriceEstimate({
            regionId: regionPick.regionId,
            instanceType: sku.instanceType,
            systemDiskGb: sku.systemDiskGb,
          });
          tiers.push({
            profile: p,
            label: def.label,
            vcpu: def.vcpu,
            memoryGb: def.memoryGb,
            systemDiskGb: def.systemDiskGb,
            recommended: p === profile,
            sku: {
              instanceType: sku.instanceType,
              cpu: sku.cpu,
              memoryGb: sku.memoryGb,
              zoneId: sku.zoneId,
              selectionReason: sku.selectionReason,
            },
            priceEstimate: price.available
              ? {
                  available: true,
                  currency: price.currency,
                  hourlyPrice: price.hourlyPrice,
                  monthlyEquivalent: price.monthlyEquivalent,
                  chargeType: price.chargeType,
                }
              : {
                  available: false,
                  currency: null,
                  hourlyPrice: null,
                  monthlyEquivalent: null,
                  chargeType: 'PostPaid',
                  errorCode: price.errorCode || 'PRICE_UNKNOWN',
                },
            unavailableReason: price.available ? null : '暂无法询价（不以伪价格展示）',
          });
        } catch {
          tiers.push({
            profile: p,
            label: def.label,
            vcpu: def.vcpu,
            memoryGb: def.memoryGb,
            systemDiskGb: def.systemDiskGb,
            recommended: p === profile,
            sku: null,
            priceEstimate: null,
            unavailableReason: '规格发现失败',
          });
        }
      }
    } else {
      for (const p of ['DEV', 'STANDARD', 'PRODUCTION'] as ServerProfile[]) {
        const def = SERVER_RESOURCE_PROFILES[p];
        tiers.push({
          profile: p,
          label: def.label,
          vcpu: def.vcpu,
          memoryGb: def.memoryGb,
          systemDiskGb: def.systemDiskGb,
          recommended: p === profile,
          sku: null,
          priceEstimate: null,
          unavailableReason: account
            ? '云账号凭证不可用，无法发现规格与询价'
            : '请先配置阿里云云资源账户',
        });
      }
    }

    const recommendedTier = tiers.find((t) => t.profile === profile) || tiers[0] || null;

    let existingEvaluation: {
      fit: ExistingServerFit;
      fitLabel: string;
      reason: string;
      knownVcpu: number | null;
      knownMemoryGb: number | null;
      instanceType: string | null;
    } | null = null;

    if (selectedExisting && planner) {
      try {
        const found = await planner.findInstanceByPublicIp(
          selectedExisting.host,
          regionPick.regionId,
        );
        const evalResult = evaluateExistingServer({
          knownVcpu: found?.cpu,
          knownMemoryGb: found?.memoryGb,
          recommended: profile,
        });
        existingEvaluation = {
          fit: evalResult.fit,
          fitLabel: EXISTING_SERVER_FIT_LABELS[evalResult.fit],
          reason: evalResult.reason,
          knownVcpu: found?.cpu ?? null,
          knownMemoryGb: found?.memoryGb ?? null,
          instanceType: found?.instanceType ?? null,
        };
      } catch {
        const evalResult = evaluateExistingServer({
          knownVcpu: null,
          knownMemoryGb: null,
          recommended: profile,
        });
        existingEvaluation = {
          fit: evalResult.fit,
          fitLabel: EXISTING_SERVER_FIT_LABELS[evalResult.fit],
          reason: evalResult.reason,
          knownVcpu: null,
          knownMemoryGb: null,
          instanceType: null,
        };
      }
    } else if (selectedExisting) {
      const evalResult = evaluateExistingServer({
        knownVcpu: null,
        knownMemoryGb: null,
        recommended: profile,
      });
      existingEvaluation = {
        fit: evalResult.fit,
        fitLabel: EXISTING_SERVER_FIT_LABELS[evalResult.fit],
        reason: evalResult.reason,
        knownVcpu: null,
        knownMemoryGb: null,
        instanceType: null,
      };
    }

    const source: ServerSource =
      overrides.source ||
      (selectedExisting && !overrides.simulateNoServer ? 'EXISTING' : 'MANAGED_CREATE');

    let readiness: ServerReadiness = 'NOT_CONFIGURED';
    if (!requirement.required) {
      readiness = 'READY';
    } else if (source === 'EXISTING' && selectedExisting) {
      readiness =
        selectedExisting.status === 'READY' || selectedExisting.dockerStatus === 'READY'
          ? 'READY'
          : selectedExisting.status === 'ERROR'
            ? 'ERROR'
            : 'READY';
    } else if (recommendedTier?.sku) {
      readiness = 'PLANNED';
    }

    const billingReadiness = {
      status:
        capability?.BILLING_ORDER_PERMISSION ||
        capability?.capabilities.billing?.status ||
        'UNKNOWN',
      message: '账户支付状态需由阿里云最终确认。',
      ecsPricePermission: capability?.capabilities.ecs?.actions?.price || 'UNKNOWN',
      ecsReadPermission: capability?.capabilities.ecs?.actions?.read || 'UNKNOWN',
      ecsCreatePermission: capability?.capabilities.ecs?.actions?.create || 'UNKNOWN',
    };

    // Soft analytics for GET views
    if (ctx.userId) {
      await this.prisma.auditLog
        .create({
          data: {
            workspaceId,
            userId: ctx.userId,
            action: 'server_plan_viewed',
            metadata: {
              projectId,
              needServer: requirement.required,
              profile,
              region: regionPick.regionId,
              simulateNoServer: Boolean(overrides.simulateNoServer),
              readiness,
            },
          },
        })
        .catch(() => undefined);
    }

    return {
      projectId,
      projectName,
      needServer: requirement.required,
      reasons: requirement.reasons,
      sharedServer: requirement.sharedServer,
      readiness,
      readinessLabel: SERVER_READINESS_LABELS[readiness],
      source,
      existingServer: selectedExisting
        ? {
            id: selectedExisting.id,
            name: selectedExisting.name,
            host: selectedExisting.host,
            status: selectedExisting.status,
            dockerStatus: selectedExisting.dockerStatus,
            evaluation: existingEvaluation,
          }
        : null,
      existingServers: existingServers.map((s) => ({
        id: s.id,
        name: s.name,
        host: s.host,
        status: s.status,
      })),
      recommendation: {
        profile,
        profileLabel: SERVER_PROFILE_LABELS[profile],
        vcpu: profileDef.vcpu,
        memoryGb: profileDef.memoryGb,
        systemDiskGb: profileDef.systemDiskGb,
        reason: requirement.recommendationReason,
        regionId: regionPick.regionId,
        regionReason: regionPick.reason,
        osLabel: image?.productLabel || '推荐系统',
        osName: image?.osName || 'Alibaba Cloud Linux / Ubuntu LTS',
        chargeType: 'PostPaid',
        chargeTypeLabel: '按量付费',
        deployModeLabel: '共享一台服务器部署 Web / API',
        sku: recommendedTier?.sku || null,
        priceEstimate: recommendedTier?.priceEstimate || null,
      },
      tiers,
      placement: {
        regionId: placement.regionId,
        zoneId: placement.zoneId,
        vpcId: placement.vpcId,
        vSwitchId: placement.vSwitchId,
        publicIpRequired: placement.publicIpRequired,
        securityGroupPlan: placement.securityGroupPlan,
        placementReason: placement.placementReason,
      },
      image: image
        ? {
            productLabel: image.productLabel,
            osName: image.osName,
            // advanced only
            imageId: image.imageId,
          }
        : null,
      serverInitPlan: buildServerInitPlan(),
      billingReadiness,
      capability: capability
        ? {
            ecs: capability.capabilities.ecs.status,
            ecsActions: capability.capabilities.ecs.actions || null,
            billingOrder: capability.BILLING_ORDER_PERMISSION,
          }
        : null,
      dependencyRegions,
      notices: [
        '实际费用以阿里云账单为准。',
        'Step 26.1 仅生成购买前规划，不会创建云服务器。',
      ],
      createBlocked: true,
      createBlockedReason: '服务器自动创建将在 Step 26.2 提供。',
      canEdit: WRITE_ROLES.includes(ctx.role),
      simulatedNoServer: Boolean(overrides.simulateNoServer),
    };
  }

  private async collectDependencyRegions(projectId: string): Promise<string[]> {
    const rows = await this.prisma.cloudResource.findMany({
      where: {
        projectId,
        type: { in: [CloudResourceType.DATABASE, CloudResourceType.CACHE] },
        status: { notIn: [CloudResourceStatus.DELETED] },
        region: { not: null },
      },
      select: { region: true },
    });
    return rows.map((r) => r.region!).filter(Boolean);
  }

  private async countRequiredDependencies(projectId: string): Promise<number> {
    const units = await this.prisma.deployableUnit.findMany({
      where: { projectId },
      select: { id: true },
    });
    if (!units.length) return 0;
    const reqs = await this.prisma.runtimeConfigRequirement.findMany({
      where: {
        deployableUnitId: { in: units.map((u) => u.id) },
        key: { in: ['DATABASE_URL', 'REDIS_URL'] },
        required: true,
      },
      select: { key: true },
    });
    return new Set(reqs.map((r) => r.key)).size;
  }

  private async findDependencyVpc(
    projectId: string,
    regionId: string,
  ): Promise<{
    vpcId: string | null;
    vSwitchId: string | null;
    zoneId: string | null;
    reason: string;
  }> {
    const rows = await this.prisma.cloudResource.findMany({
      where: {
        projectId,
        type: { in: [CloudResourceType.DATABASE, CloudResourceType.CACHE] },
        status: { notIn: [CloudResourceStatus.DELETED] },
        OR: [{ region: regionId }, { region: null }],
      },
      orderBy: { updatedAt: 'desc' },
      take: 10,
    });
    for (const row of rows) {
      const meta =
        row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
          ? (row.metadata as Record<string, unknown>)
          : {};
      const vpcId =
        (typeof meta.vpcId === 'string' && meta.vpcId) ||
        (typeof meta.VpcId === 'string' && meta.VpcId) ||
        null;
      const vSwitchId =
        (typeof meta.vSwitchId === 'string' && meta.vSwitchId) ||
        (typeof meta.VSwitchId === 'string' && meta.VSwitchId) ||
        null;
      const zoneId =
        (typeof meta.zoneId === 'string' && meta.zoneId) ||
        (typeof meta.ZoneId === 'string' && meta.ZoneId) ||
        null;
      if (vpcId) {
        return {
          vpcId,
          vSwitchId,
          zoneId,
          reason: '与数据库 / Redis 优先同 VPC。',
        };
      }
    }
    return {
      vpcId: null,
      vSwitchId: null,
      zoneId: null,
      reason: '依赖尚未提供 VPC 信息，将按地域规划网络。',
    };
  }
}
