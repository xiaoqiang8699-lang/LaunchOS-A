import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';

const serviceSelect = {
  id: true,
  projectId: true,
  environmentId: true,
  artifactId: true,
  runtime: true,
  status: true,
  containerId: true,
  port: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class ServicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaceAccess: WorkspaceAccessService,
  ) {}

  async list(userId: string, projectId: string) {
    await this.workspaceAccess.requireProjectAccess(userId, projectId);

    return this.prisma.serviceInstance.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: serviceSelect,
    });
  }
}
