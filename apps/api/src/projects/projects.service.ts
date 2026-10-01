import { ConflictException, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import {
  ApplicationDomainType,
  ApplicationPurpose,
  CloudResourceType,
  CodeUpdateStatus,
  DeploymentStatus,
  HealthStatus,
  ProjectType,
  RemoteDeploymentStatus,
  ServiceStatus,
  SourceType,
} from '@launchos/database';
import { isOrdinaryUserProject, toVisitUrls, readSystemDomainZone } from '@launchos/domain';
import { GitService, isPlaceholderGitUrl } from '@launchos/git';
import { PrismaService } from '../database/prisma.service';
import {
  DEFAULT_PROJECT_ENVIRONMENT_NAME,
  DEFAULT_PROJECT_ENVIRONMENT_TYPE,
} from '../environments/environments.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import { EntitlementGovernanceService } from '../billing/entitlement-governance.service';
import type { CreateProjectDto } from './dto/create-project.dto';
import type { UpdateProjectDto } from './dto/update-project.dto';
import { deriveApplicationStatus } from '../apps/application-status';
import {
  AGGREGATE_PRODUCT_STATUS_LABELS,
  deriveAggregateProductStatus,
  deriveUnitProductStatus,
  mapAggregateToApplicationStatus,
  type UnitProductStatus,
} from '../deployable-units/unit-product';
import { extractOnboardingZip, persistZipUpload } from '../onboarding/zip-intake.util';
import { randomUUID } from 'node:crypto';

const projectSelect = {
  id: true,
  workspaceId: true,
  name: true,
  slug: true,
  description: true,
  sourceType: true,
  sourceUrl: true,
  projectType: true,
  applicationPurpose: true,
  status: true,
  framework: true,
  repositoryUrl: true,
  defaultBranch: true,
  isDemo: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class ProjectsService {
  private readonly git = new GitService();

  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaceAccess: WorkspaceAccessService,
    private readonly entitlements: EntitlementGovernanceService,
  ) {}

  async create(userId: string, dto: CreateProjectDto) {
    const membership = await this.workspaceAccess.requireCurrentWorkspace(userId);
    this.workspaceAccess.requireWriteAccess(membership.role);
    await this.workspaceAccess.assertWorkspaceMutable(membership.workspace.id);
    await this.entitlements.assertCanCreateProject(userId, membership.workspace.id);

    const slug = await this.allocateSlug(membership.workspace.id, dto.name);
    const source = await this.normalizeCreateSource(dto, membership.workspace.id);
    const sourceUrl = source?.url ?? dto.sourceUrl?.trim() ?? null;
    const defaultBranch =
      source?.branch ?? dto.defaultBranch?.trim() ?? (await this.detectDefaultBranch(sourceUrl));

    return this.prisma.$transaction(async (tx) => {
      const project = await tx.project.create({
        data: {
          workspaceId: membership.workspace.id,
          name: dto.name.trim(),
          slug,
          description: dto.description?.trim() || null,
          sourceType: source?.type ?? dto.sourceType?.trim() ?? SourceType.GITHUB,
          sourceUrl,
          projectType: dto.type ?? ProjectType.WEB,
          applicationPurpose: dto.applicationPurpose ?? ApplicationPurpose.WEBSITE,
          status: 'ACTIVE',
          framework: dto.framework?.trim() || null,
          defaultBranch,
        },
        select: projectSelect,
      });

      if (source) {
        await tx.sourceRepository.create({
          data: {
            projectId: project.id,
            type: source.type,
            url: source.url,
            branch: source.branch,
            connectionId: source.connectionId,
            providerRepositoryId: source.providerRepositoryId,
            fullName: source.fullName,
            isPrivate: source.isPrivate,
            authStatus: 'OK',
          },
        });
        // Source bound → ensure control-plane default environment (no cloud resources).
        await tx.projectEnvironment.create({
          data: {
            projectId: project.id,
            name: DEFAULT_PROJECT_ENVIRONMENT_NAME,
            type: DEFAULT_PROJECT_ENVIRONMENT_TYPE,
            variables: {},
          },
        });
      }

      return project;
    });
  }

  async createFromZip(
    userId: string,
    file: { buffer: Buffer; originalname?: string; size?: number } | undefined,
  ) {
    if (!file?.buffer?.byteLength) {
      throw new BadRequestException('请选择 ZIP 文件');
    }
    if (!/\.zip$/i.test(file.originalname || 'upload.zip')) {
      throw new BadRequestException('仅支持 .zip 文件');
    }

    const draftName = (file.originalname || 'upload.zip')
      .replace(/\.zip$/i, '')
      .replace(/[^\w\u4e00-\u9fa5.-]+/g, '-')
      .slice(0, 60) || 'uploaded-app';

    const project = await this.create(userId, {
      name: draftName,
      source: {
        type: SourceType.UPLOAD,
        url: `local://${draftName}`,
        branch: 'local',
        fullName: draftName,
        isPrivate: false,
      },
    });

    try {
      const uploadId = randomUUID();
      await persistZipUpload(uploadId, file.buffer);
      const workspaceDir = this.git.workspaceDir(project.id);
      const extracted = await extractOnboardingZip({
        projectId: project.id,
        zipBuffer: file.buffer,
        originalName: file.originalname,
        workspaceDir,
      });
      if (extracted.appName && extracted.appName !== draftName) {
        await this.prisma.project.update({
          where: { id: project.id },
          data: { name: extracted.appName.slice(0, 80) },
        });
        await this.prisma.sourceRepository.updateMany({
          where: { projectId: project.id },
          data: {
            fullName: extracted.appName.slice(0, 80),
            url: `local://${extracted.appName}`,
          },
        });
        return this.getById(userId, project.id);
      }
      return project;
    } catch (error) {
      const code = error instanceof Error ? error.message : 'ZIP_FAILED';
      const message =
        code === 'ZIP_TOO_LARGE'
          ? 'ZIP 文件过大，请压缩后再试。'
          : code === 'ZIP_TOO_MANY_FILES' || code === 'ZIP_EXTRACTED_TOO_LARGE'
            ? '项目文件过多或过大，请精简后再上传。'
            : code === 'ZIP_EMPTY' || code === 'ZIP_EMPTY_CONTENT'
              ? 'ZIP 内容为空。'
              : code === 'ZIP_INVALID'
                ? 'ZIP 文件无法读取。'
                : '上传失败，请重新尝试。';
      throw new BadRequestException(message);
    }
  }

  async list(userId: string) {
    const membership = await this.workspaceAccess.requireCurrentWorkspace(userId);
    return this.prisma.project.findMany({
      where: { workspaceId: membership.workspace.id },
      orderBy: { createdAt: 'desc' },
      select: projectSelect,
    });
  }

  async getById(userId: string, projectId: string) {
    const { project } = await this.workspaceAccess.requireProjectAccess(userId, projectId);

    const [detail, environments, deployments, sources] = await Promise.all([
      this.prisma.project.findUniqueOrThrow({
        where: { id: project.id },
        select: projectSelect,
      }),
      this.prisma.projectEnvironment.findMany({
        where: { projectId: project.id },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.deployment.findMany({
        where: { projectId: project.id },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          status: true,
          version: true,
          environmentId: true,
          createdAt: true,
        },
      }),
      this.prisma.sourceRepository.findMany({
        where: { projectId: project.id },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          projectId: true,
          type: true,
          url: true,
          branch: true,
          connectionId: true,
          providerRepositoryId: true,
          fullName: true,
          isPrivate: true,
          authStatus: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    ]);

    return {
      ...detail,
      environments,
      deployments,
      sources: sources.length > 0 ? sources : legacySourcesFromProject(detail),
    };
  }

  async update(userId: string, projectId: string, dto: UpdateProjectDto) {
    const { membership, project } = await this.workspaceAccess.requireProjectAccess(
      userId,
      projectId,
    );
    this.workspaceAccess.requireWriteAccess(membership.role);

    return this.prisma.project.update({
      where: { id: project.id },
      data: {
        applicationPurpose: dto.applicationPurpose,
      },
      select: projectSelect,
    });
  }

  async listApps(userId: string) {
    const membership = await this.workspaceAccess.requireCurrentWorkspace(userId);
    const projects = (
      await this.prisma.project.findMany({
      where: { workspaceId: membership.workspace.id },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        name: true,
        slug: true,
        isDemo: true,
        applicationPurpose: true,
        pendingCodeUpdates: {
          where: { status: CodeUpdateStatus.PENDING },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true,
            commitSha: true,
            commitMessage: true,
            createdAt: true,
          },
        },
        domains: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { domain: true, status: true },
        },
        applicationDomains: {
          where: { type: ApplicationDomainType.SYSTEM },
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            domain: true,
            status: true,
            sslStatus: true,
            dnsStatus: true,
            deployableUnitId: true,
          },
        },
        cloudResources: {
          where: { type: CloudResourceType.SERVER },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { status: true, publicIp: true },
        },
        deployableUnits: {
          where: { status: { not: 'IGNORED' } },
          orderBy: [{ deployable: 'desc' }, { rootPath: 'asc' }],
          select: {
            id: true,
            name: true,
            type: true,
            deployable: true,
            framework: true,
          },
        },
        serviceInstances: {
          orderBy: { createdAt: 'desc' },
          select: {
            status: true,
            port: true,
            externalPort: true,
            healthStatus: true,
            lastHealthCheckAt: true,
            responseTimeMs: true,
            healthMessage: true,
            serverInstanceId: true,
            deployableUnitId: true,
            server: { select: { name: true, host: true, scope: true } },
          },
        },
        deployments: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            id: true,
            status: true,
            finishedAt: true,
            createdAt: true,
            deployableUnitId: true,
            remoteDeployments: {
              orderBy: { startedAt: 'desc' },
              take: 1,
              select: {
                status: true,
                cloudResource: { select: { publicIp: true } },
              },
            },
          },
        },
      },
    })
    ).filter((project) => isOrdinaryUserProject(project));

    return projects.map((project) => toAppSummary(project));
  }

  async getApp(userId: string, projectId: string) {
    await this.workspaceAccess.requireProjectAccess(userId, projectId);
    const apps = await this.listApps(userId);
    const app = apps.find((item) => item.id === projectId);
    if (!app) {
      throw new NotFoundException('应用不存在');
    }
    return app;
  }

  private async allocateSlug(workspaceId: string, name: string): Promise<string> {
    const base = toSlug(name);
    for (let index = 0; index < 20; index += 1) {
      const slug = index === 0 ? base : `${base}-${index + 1}`;
      const existing = await this.prisma.project.findUnique({
        where: {
          workspaceId_slug: { workspaceId, slug },
        },
        select: { id: true },
      });
      if (!existing) {
        return slug;
      }
    }

    throw new ConflictException('Unable to allocate project slug');
  }

  private async normalizeCreateSource(
    dto: CreateProjectDto,
    workspaceId: string,
  ): Promise<{
    type: SourceType;
    url: string;
    branch: string;
    connectionId: string | null;
    providerRepositoryId: string | null;
    fullName: string | null;
    isPrivate: boolean;
  } | null> {
    const url = dto.source?.url.trim() || '';
    if (!url) {
      return null;
    }

    const explicit = dto.source?.branch?.trim() || dto.defaultBranch?.trim() || '';
    const branch = explicit || (await this.detectDefaultBranch(url));
    const connectionId = dto.source?.connectionId?.trim() || null;

    if (connectionId) {
      const connection = await this.prisma.gitProviderConnection.findFirst({
        where: {
          id: connectionId,
          workspaceId,
          status: 'ACTIVE',
        },
        select: { id: true },
      });
      if (!connection) {
        throw new ConflictException('GitHub 连接无效，请重新连接。');
      }
    }

    return {
      type: dto.source?.type ?? inferSourceType(url),
      url,
      branch,
      connectionId,
      providerRepositoryId: dto.source?.providerRepositoryId?.trim() || null,
      fullName: dto.source?.fullName?.trim() || null,
      isPrivate: Boolean(dto.source?.isPrivate),
    };
  }

  private async detectDefaultBranch(url: string | null): Promise<string> {
    if (!url) {
      return 'main';
    }
    if (url.startsWith('local://') || isPlaceholderGitUrl(url)) {
      return 'main';
    }
    try {
      const detected = await this.git.detectRepository(url);
      return detected.defaultBranch?.trim() || 'main';
    } catch {
      return 'main';
    }
  }
}

function legacySourcesFromProject(project: {
  id: string;
  repositoryUrl: string | null;
  sourceUrl: string | null;
  defaultBranch: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  const url = project.repositoryUrl?.trim() || project.sourceUrl?.trim() || '';
  if (!url) {
    return [];
  }

  return [
    {
      id: `legacy-${project.id}`,
      projectId: project.id,
      type: inferSourceType(url),
      url,
      branch: project.defaultBranch?.trim() || 'main',
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    },
  ];
}

function toAppSummary(project: {
  id: string;
  name: string;
  slug: string;
  isDemo: boolean;
  applicationPurpose: ApplicationPurpose;
  deployments: {
    id: string;
    status: DeploymentStatus;
    finishedAt: Date | null;
    createdAt: Date;
    deployableUnitId?: string | null;
    remoteDeployments: { status: RemoteDeploymentStatus; cloudResource: { publicIp: string | null } }[];
  }[];
  serviceInstances: {
    status: ServiceStatus;
    port: number | null;
    externalPort: number | null;
    healthStatus: 'HEALTHY' | 'UNHEALTHY' | 'UNKNOWN';
    lastHealthCheckAt: Date | null;
    responseTimeMs: number | null;
    healthMessage: string | null;
    serverInstanceId: string | null;
    deployableUnitId?: string | null;
    server: { name: string; host: string; scope?: string } | null;
  }[];
  pendingCodeUpdates: {
    id: string;
    commitSha: string;
    commitMessage: string;
    createdAt: Date;
  }[];
  domains: { domain: string; status: string }[];
  applicationDomains: {
    domain: string;
    status: string;
    sslStatus: string;
    dnsStatus: string;
    deployableUnitId?: string | null;
  }[];
  cloudResources: { status: string; publicIp: string | null }[];
  deployableUnits?: {
    id: string;
    name: string;
    type: string;
    deployable: boolean;
    framework: string | null;
  }[];
}) {
  const latest = project.deployments[0];
  const service = project.serviceInstances[0];
  const domain = project.domains[0];
  const units = project.deployableUnits ?? [];
  const applicationDomain = pickCurrentSystemDomain(project.applicationDomains);
  const server = project.cloudResources[0];
  const remote = latest?.remoteDeployments[0];
  const publicIp = remote?.cloudResource.publicIp || server?.publicIp || null;
  const branded = applicationDomain
    ? toVisitUrls(applicationDomain)
    : { visitUrl: null, localVisitUrl: null, dnsReady: false, gatewayReady: false };
  const hostingMode =
    service?.server?.scope === 'WORKSPACE_OWNED' ? 'my-server' : 'launchos';
  const hostingLabel =
    hostingMode === 'my-server'
      ? service?.server?.name ?? '我的服务器'
      : 'LaunchOS 自动托管';

  const visitUrl = branded.visitUrl
    ? branded.visitUrl
    : hostingMode === 'my-server'
      ? null
      : publicIp
        ? `http://${publicIp}/`
        : domain?.domain
          ? `http://${domain.domain}/`
          : null;

  const unitStatuses: UnitProductStatus[] =
    units.length > 0
      ? units.map((unit) => {
          const unitDeployment = project.deployments.find((d) => d.deployableUnitId === unit.id);
          const unitService = project.serviceInstances.find((s) => s.deployableUnitId === unit.id);
          return deriveUnitProductStatus({
            deployable: unit.deployable,
            deploymentStatus: unitDeployment?.status ?? (units.length === 1 ? latest?.status : null),
            serviceStatus: unitService?.status ?? (units.length === 1 ? service?.status : null),
            healthStatus: unitService?.healthStatus ?? (units.length === 1 ? service?.healthStatus : null),
          });
        })
      : [
          deriveUnitProductStatus({
            deployable: true,
            deploymentStatus: latest?.status,
            serviceStatus: service?.status,
            healthStatus: service?.healthStatus,
          }),
        ];

  const aggregate = deriveAggregateProductStatus(unitStatuses);
  const applicationStatus =
    units.length > 0
      ? mapAggregateToApplicationStatus(aggregate)
      : deriveApplicationStatus({
          deploymentStatus: latest?.status,
          serviceStatus: service?.status,
          healthStatus: service?.healthStatus,
        });

  const launchable = units.filter((u) => u.deployable).length;
  const mobile = units.filter((u) =>
    ['IOS', 'ANDROID', 'MOBILE_CROSS_PLATFORM', 'MINI_PROGRAM'].includes(u.type),
  ).length;

  const visitEntries =
    units.length > 1
      ? units
          .map((unit) => {
            const unitDomain = project.applicationDomains.find((d) => d.deployableUnitId === unit.id);
            if (!unitDomain) {
              return null;
            }
            const urls = toVisitUrls(unitDomain);
            return {
              unitId: unit.id,
              name: unit.name,
              visitUrl: urls.visitUrl,
              visitUrlReady: Boolean(urls.dnsReady && urls.visitUrl),
            };
          })
          .filter(Boolean)
      : [];

  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    isDemo: project.isDemo,
    applicationPurpose: project.applicationPurpose,
    applicationStatus,
    aggregateStatus: aggregate,
    aggregateLabel: AGGREGATE_PRODUCT_STATUS_LABELS[aggregate],
    visitUrl: units.length > 1 && visitEntries.length > 1 ? null : visitUrl,
    localVisitUrl: branded.dnsReady ? null : branded.localVisitUrl,
    visitUrlReady: Boolean(branded.dnsReady && visitUrl) && !(units.length > 1 && visitEntries.length > 1),
    visitUrlPreparing: Boolean(branded.gatewayReady && !branded.dnsReady),
    visitEntries,
    systemDomain: applicationDomain?.domain ?? null,
    dnsStatus: applicationDomain?.dnsStatus ?? null,
    gatewayDomainStatus: applicationDomain?.status ?? null,
    hostingMode,
    hostingLabel,
    serverStatus: server?.status ?? 'NONE',
    lastDeployedAt: latest?.finishedAt ?? latest?.createdAt ?? null,
    latestDeploymentId: latest?.id ?? null,
    canManage: Boolean(service),
    healthStatus: service?.healthStatus ?? HealthStatus.UNKNOWN,
    lastHealthCheckAt: service?.lastHealthCheckAt ?? null,
    responseTimeMs: service?.responseTimeMs ?? null,
    healthMessage: service?.healthMessage ?? null,
    pendingUpdate: project.pendingCodeUpdates[0] ?? null,
    composition: {
      total: units.length,
      launchable,
      mobile,
      unsupported: units.length - launchable,
    },
  };
}

function inferSourceType(url: string): SourceType {
  const lower = url.toLowerCase();
  if (lower.includes('gitlab')) {
    return SourceType.GITLAB;
  }
  return SourceType.GITHUB;
}

function pickCurrentSystemDomain<T extends { domain: string }>(domains: T[]): T | undefined {
  if (!domains.length) return undefined;
  const zone = readSystemDomainZone();
  const suffix = `.${zone}`;
  return domains.find((item) => item.domain === zone || item.domain.endsWith(suffix)) ?? domains[0];
}

function toSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  return slug || 'project';
}
