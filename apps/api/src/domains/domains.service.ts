import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { DomainType, ServiceStatus } from '@launchos/database';
import { DomainService, DomainServiceError } from '@launchos/deployment';
import { PrismaService } from '../database/prisma.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import { EntitlementGovernanceService } from '../billing/entitlement-governance.service';
import { ProductAnalyticsService } from '../analytics/product-analytics.service';
import type { CreateDomainDto } from './dto/create-domain.dto';

const domainSelect = {
  id: true,
  projectId: true,
  serviceInstanceId: true,
  domain: true,
  type: true,
  provider: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  certificates: {
    orderBy: { createdAt: 'desc' as const },
    select: {
      id: true,
      domainId: true,
      issuer: true,
      expiresAt: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
  },
};

@Injectable()
export class DomainsService {
  private readonly domains: DomainService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaceAccess: WorkspaceAccessService,
    private readonly entitlements: EntitlementGovernanceService,
    private readonly analytics: ProductAnalyticsService,
  ) {
    this.domains = new DomainService(prisma);
  }

  async create(userId: string, projectId: string, dto: CreateDomainDto = {}) {
    const { membership, project } = await this.workspaceAccess.requireProjectAccess(
      userId,
      projectId,
    );
    this.workspaceAccess.requireWriteAccess(membership.role);

    const service = await this.resolveService(project.id, dto.serviceInstanceId);
    const type = dto.type ?? (dto.domain ? DomainType.CUSTOM : DomainType.SUBDOMAIN);

    try {
      let result;
      if (type === DomainType.CUSTOM) {
        if (!dto.domain?.trim()) {
          throw new BadRequestException('Custom domain is required');
        }
        await this.entitlements.assertCustomDomain(userId, project.workspaceId);
        result = await this.domains.assignCustomDomain({
          projectId: project.id,
          serviceInstanceId: service.id,
          domain: dto.domain,
          target: '127.0.0.1',
        });
      } else {
        result = await this.domains.assignDefaultSubdomain({
          projectId: project.id,
          projectName: project.name,
          projectSlug: project.slug,
          serviceInstanceId: service.id,
          target: '127.0.0.1',
        });
      }
      void this.analytics
        .track({
          event: 'DOMAIN_CONNECTED',
          userId,
          workspaceId: project.workspaceId,
          projectId: project.id,
          metadata: { type },
        })
        .catch(() => undefined);
      return result;
    } catch (error) {
      if (error instanceof DomainServiceError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  async list(userId: string, projectId: string) {
    await this.workspaceAccess.requireProjectAccess(userId, projectId);
    return this.prisma.domainRecord.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: domainSelect,
    });
  }

  private async resolveService(projectId: string, serviceInstanceId?: string) {
    if (serviceInstanceId) {
      const service = await this.prisma.serviceInstance.findFirst({
        where: { id: serviceInstanceId, projectId },
      });
      if (!service) {
        throw new BadRequestException('Service instance not found');
      }
      return service;
    }

    const service = await this.prisma.serviceInstance.findFirst({
      where: { projectId, status: ServiceStatus.RUNNING },
      orderBy: { createdAt: 'desc' },
    });
    if (!service) {
      throw new BadRequestException('No running service available for this project');
    }
    return service;
  }
}
