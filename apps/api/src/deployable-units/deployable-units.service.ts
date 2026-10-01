import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ApplicationDomainType,
  ApplicationVersionStatus,
  CodeUpdateStatus,
  DeployableUnitStatus,
  HealthStatus,
} from '@launchos/database';
import { toVisitUrls } from '@launchos/domain';
import { AnalysesService } from '../analyses/analyses.service';
import { PrismaService } from '../database/prisma.service';
import { RuntimeConfigService } from '../runtime-config/runtime-config.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import {
  AGGREGATE_PRODUCT_STATUS_LABELS,
  UNIT_PRODUCT_STATUS_LABELS,
  deriveAggregateProductStatus,
  deriveUnitProductStatus,
  ensureUniqueDisplayNames,
  mapAggregateToApplicationStatus,
  typeLabel,
  type AggregateProductStatus,
  type UnitProductStatus,
} from './unit-product';

@Injectable()
export class DeployableUnitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaceAccess: WorkspaceAccessService,
    private readonly analyses: AnalysesService,
    private readonly runtimeConfig: RuntimeConfigService,
  ) {}

  async list(userId: string, projectId: string) {
    await this.workspaceAccess.requireProjectAccess(userId, projectId);
    const enriched = await this.buildEnrichedUnits(projectId);
    const aggregate = deriveAggregateProductStatus(
      enriched.map((unit) => unit.productStatus as UnitProductStatus),
    );
    return {
      units: enriched,
      scanned: true,
      aggregateStatus: aggregate,
      aggregateLabel: AGGREGATE_PRODUCT_STATUS_LABELS[aggregate],
      applicationStatus: mapAggregateToApplicationStatus(aggregate),
      composition: this.summarizeComposition(enriched),
    };
  }

  async scan(userId: string, projectId: string) {
    const analysis = await this.analyses.analyzeCode(userId, projectId);
    const units = await this.prisma.deployableUnit.findMany({
      where: { projectId, status: { not: DeployableUnitStatus.IGNORED } },
      select: { id: true, rootPath: true },
    });
    for (const unit of units) {
      await this.runtimeConfig.scanAndPersist(projectId, unit.id, unit.rootPath).catch(() => null);
    }
    const listed = await this.list(userId, projectId);
    return {
      ...analysis,
      ...listed,
    };
  }

  async patch(
    userId: string,
    projectId: string,
    unitId: string,
    body: { name?: string; status?: 'CONFIRMED' | 'IGNORED' | 'DETECTED'; select?: boolean },
  ) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    this.workspaceAccess.requireWriteAccess(membership.role);

    const unit = await this.prisma.deployableUnit.findFirst({
      where: { id: unitId, projectId },
    });
    if (!unit) {
      throw new NotFoundException('未找到该可上线内容');
    }

    const updated = await this.prisma.deployableUnit.update({
      where: { id: unit.id },
      data: {
        name: body.name?.trim() || undefined,
        status: body.status ? (body.status as DeployableUnitStatus) : undefined,
      },
    });

    if (body.select) {
      await this.prisma.project.update({
        where: { id: projectId },
        data: { selectedDeployableUnitId: unit.id },
      });
    }

    const listed = await this.buildEnrichedUnits(projectId);
    return { unit: listed.find((item) => item.id === updated.id) ?? toPublicUnit(updated) };
  }

  async requireDeployableUnit(projectId: string, unitId: string) {
    const unit = await this.prisma.deployableUnit.findFirst({
      where: { id: unitId, projectId },
    });
    if (!unit) {
      throw new NotFoundException('未找到该可上线内容');
    }
    if (!unit.deployable || unit.status === DeployableUnitStatus.UNSUPPORTED) {
      throw new BadRequestException('当前版本暂不支持上线这一部分。');
    }
    if (unit.status === DeployableUnitStatus.IGNORED) {
      throw new BadRequestException('该内容已被忽略，无法上线。');
    }
    return unit;
  }

  async buildEnrichedUnits(projectId: string) {
    const units = await this.prisma.deployableUnit.findMany({
      where: {
        projectId,
        status: { not: DeployableUnitStatus.IGNORED },
      },
      orderBy: [{ deployable: 'desc' }, { rootPath: 'asc' }],
      include: {
        sourceRepository: {
          select: {
            id: true,
            type: true,
            url: true,
            fullName: true,
          },
        },
      },
    });

    const [deployments, services, versions, domains, pending] = await Promise.all([
      this.prisma.deployment.findMany({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          deployableUnitId: true,
          status: true,
          version: true,
          createdAt: true,
          finishedAt: true,
        },
      }),
      this.prisma.serviceInstance.findMany({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          deployableUnitId: true,
          status: true,
          healthStatus: true,
          lastHealthCheckAt: true,
          responseTimeMs: true,
          healthMessage: true,
          containerId: true,
        },
      }),
      this.prisma.applicationVersion.findMany({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          deployableUnitId: true,
          version: true,
          status: true,
        },
      }),
      this.prisma.applicationDomain.findMany({
        where: { projectId, type: ApplicationDomainType.SYSTEM },
        orderBy: { createdAt: 'desc' },
        select: {
          domain: true,
          status: true,
          sslStatus: true,
          dnsStatus: true,
          deployableUnitId: true,
        },
      }),
      this.prisma.pendingCodeUpdate.findFirst({
        where: { projectId, status: CodeUpdateStatus.PENDING },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          commitSha: true,
          commitMessage: true,
          createdAt: true,
        },
      }),
    ]);

    const names = ensureUniqueDisplayNames(units);

    const configSummaries = await Promise.all(
      units.map(async (unit) => ({
        unitId: unit.id,
        summary: await this.runtimeConfig.summarizeUnit(projectId, unit.id),
      })),
    );
    const configByUnit = new Map(configSummaries.map((item) => [item.unitId, item.summary]));

    return units.map((unit) => {
      const latestDeployment =
        deployments.find((item) => item.deployableUnitId === unit.id) ||
        (units.length <= 1
          ? deployments.find((item) => item.deployableUnitId == null)
          : undefined);
      const service =
        services.find((item) => item.deployableUnitId === unit.id) ||
        (units.length <= 1
          ? services.find((item) => item.deployableUnitId == null)
          : undefined);
      const currentVersion =
        versions.find(
          (item) =>
            item.deployableUnitId === unit.id && item.status === ApplicationVersionStatus.ACTIVE,
        ) ||
        versions.find((item) => item.deployableUnitId === unit.id) ||
        (units.length <= 1
          ? versions.find((item) => item.deployableUnitId == null)
          : undefined);
      const domain =
        domains.find((item) => item.deployableUnitId === unit.id) ||
        (units.length <= 1
          ? domains.find((item) => item.deployableUnitId == null)
          : undefined);
      const visit = domain
        ? toVisitUrls(domain)
        : { visitUrl: null, localVisitUrl: null, dnsReady: false };

      const productStatus = deriveUnitProductStatus({
        deployable: unit.deployable,
        deploymentStatus: latestDeployment?.status ?? null,
        serviceStatus: service?.status ?? null,
        healthStatus: service?.healthStatus ?? null,
      });

      const displayName = names.get(unit.id) || unit.name;
      const source = unit.sourceRepository;
      const sourceLabel = source
        ? `${source.type === 'GITHUB' ? 'GitHub' : source.type} · ${source.fullName || shortRepo(source.url)}`
        : null;

      return {
        id: unit.id,
        name: unit.name,
        displayName,
        type: unit.type,
        typeLabel: typeLabel(unit.type),
        framework: unit.framework,
        deployable: unit.deployable,
        canLaunch: unit.deployable,
        canManage: Boolean(unit.deployable && service?.containerId),
        productStatus,
        productStatusLabel: UNIT_PRODUCT_STATUS_LABELS[productStatus],
        visitUrl: visit.visitUrl,
        visitUrlReady: Boolean(visit.dnsReady && visit.visitUrl),
        visitUrlPreparing: Boolean(domain && !visit.dnsReady),
        currentVersion: currentVersion?.version ?? null,
        currentVersionId: currentVersion?.id ?? null,
        healthStatus: service?.healthStatus ?? HealthStatus.UNKNOWN,
        lastHealthCheckAt: service?.lastHealthCheckAt ?? null,
        healthLabel:
          productStatus === 'UNSUPPORTED'
            ? null
            : service?.healthStatus === HealthStatus.HEALTHY
              ? '正常'
              : service?.healthStatus === HealthStatus.UNHEALTHY
                ? '访问异常'
                : '等待检测',
        codeUpdatePending: Boolean(pending),
        pendingUpdate: pending,
        sourceLabel,
        sourceRepositoryId: source?.id ?? null,
        unsupportedHint: unit.deployable ? null : '当前版本暂不支持直接发布',
        latestDeploymentId: latestDeployment?.id ?? null,
        latestDeploymentStatus: latestDeployment?.status ?? null,
        serviceStatus: service?.status ?? null,
        rootPath: unit.rootPath,
        packageManager: unit.packageManager,
        buildCommand: unit.buildCommand,
        startCommand: unit.startCommand,
        outputPath: unit.outputPath,
        port: unit.port,
        confidence: unit.confidence,
        status: unit.status,
        runtimeConfig: configByUnit.get(unit.id) ?? {
          total: 0,
          completed: 0,
          missingRequired: 0,
          missingLabels: [],
        },
      };
    });
  }

  summarizeComposition(units: Awaited<ReturnType<DeployableUnitsService['buildEnrichedUnits']>>) {
    const launchable = units.filter((u) => u.deployable).length;
    const mobile = units.filter(
      (u) =>
        u.type === 'IOS' ||
        u.type === 'ANDROID' ||
        u.type === 'MOBILE_CROSS_PLATFORM' ||
        u.type === 'MINI_PROGRAM',
    ).length;
    const aggregate = deriveAggregateProductStatus(
      units.map((u) => u.productStatus as UnitProductStatus),
    );
    return {
      total: units.length,
      launchable,
      mobile,
      unsupported: units.length - launchable,
      aggregateStatus: aggregate as AggregateProductStatus,
      aggregateLabel: AGGREGATE_PRODUCT_STATUS_LABELS[aggregate],
      applicationStatus: mapAggregateToApplicationStatus(aggregate),
    };
  }
}

function shortRepo(url: string): string {
  return url
    .replace(/^https?:\/\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^github\.com\//i, '');
}

function toPublicUnit(unit: {
  id: string;
  name: string;
  type: string;
  rootPath: string;
  framework: string | null;
  packageManager: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  outputPath: string | null;
  port: number | null;
  deployable: boolean;
  confidence: number;
  status: string;
}) {
  return {
    id: unit.id,
    name: unit.name,
    displayName: unit.name,
    type: unit.type,
    typeLabel: typeLabel(unit.type),
    rootPath: unit.rootPath,
    framework: unit.framework,
    packageManager: unit.packageManager,
    buildCommand: unit.buildCommand,
    startCommand: unit.startCommand,
    outputPath: unit.outputPath,
    port: unit.port,
    deployable: unit.deployable,
    confidence: unit.confidence,
    status: unit.status,
    canLaunch: unit.deployable,
    unsupportedHint: unit.deployable ? null : '当前版本暂不支持直接发布',
  };
}
