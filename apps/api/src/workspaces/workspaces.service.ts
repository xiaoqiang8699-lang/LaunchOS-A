import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class WorkspacesService {
  constructor(private readonly prisma: PrismaService) {}

  async listForUser(userId: string) {
    const memberships = await this.prisma.workspaceMember.findMany({
      where: { userId },
      include: { workspace: true },
      orderBy: { createdAt: 'asc' },
    });

    return memberships.map((membership) => ({
      id: membership.workspace.id,
      name: membership.workspace.name,
      ownerId: membership.workspace.ownerId,
      role: membership.role,
      createdAt: membership.workspace.createdAt,
      updatedAt: membership.workspace.updatedAt,
    }));
  }

  async listProjects(userId: string, workspaceId: string) {
    const membership = await this.prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId,
          userId,
        },
      },
    });

    if (!membership) {
      const workspace = await this.prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { id: true },
      });
      if (!workspace) {
        throw new NotFoundException('Workspace not found');
      }
      throw new ForbiddenException();
    }

    return this.prisma.project.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        workspaceId: true,
        name: true,
        slug: true,
        description: true,
        sourceType: true,
        sourceUrl: true,
        projectType: true,
        status: true,
        framework: true,
        repositoryUrl: true,
        defaultBranch: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }
}
