import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { WorkspaceRole } from '@launchos/database';
import { assertWorkspaceMutable } from '@launchos/domain';
import { PrismaService } from '../database/prisma.service';

const WRITE_ROLES: WorkspaceRole[] = [
  WorkspaceRole.OWNER,
  WorkspaceRole.ADMIN,
  WorkspaceRole.MEMBER,
];

@Injectable()
export class WorkspaceAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async requireCurrentWorkspace(userId: string) {
    const membership = await this.prisma.workspaceMember.findFirst({
      where: { userId },
      include: { workspace: true },
      orderBy: { createdAt: 'asc' },
    });

    if (!membership) {
      throw new ForbiddenException('No workspace available');
    }

    return membership;
  }

  async requireWorkspaceMembership(userId: string, workspaceId: string) {
    const membership = await this.prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId, userId },
      },
      include: { workspace: true },
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

    return membership;
  }

  async requireProjectAccess(userId: string, projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const membership = await this.requireWorkspaceMembership(userId, project.workspaceId);
    return { project, membership };
  }

  async requireDeploymentAccess(userId: string, deploymentId: string) {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: { project: true },
    });

    if (!deployment) {
      throw new NotFoundException('Deployment not found');
    }

    const membership = await this.requireWorkspaceMembership(userId, deployment.project.workspaceId);
    return { deployment, membership };
  }

  requireWriteAccess(role: WorkspaceRole): void {
    if (!WRITE_ROLES.includes(role)) {
      throw new ForbiddenException();
    }
  }

  async assertWorkspaceMutable(workspaceId: string): Promise<void> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { status: true },
    });
    const decision = assertWorkspaceMutable(workspace?.status ?? 'ACTIVE');
    if (!decision.allowed) throw new ForbiddenException(decision.message);
  }
}
