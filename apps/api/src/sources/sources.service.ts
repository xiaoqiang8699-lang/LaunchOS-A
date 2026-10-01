import { Injectable } from '@nestjs/common';
import { GitService, isPlaceholderGitUrl } from '@launchos/git';
import { PrismaService } from '../database/prisma.service';
import { EnvironmentsService } from '../environments/environments.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import type { CreateSourceDto } from './dto/create-source.dto';

const sourceSelect = {
  id: true,
  projectId: true,
  type: true,
  url: true,
  branch: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class SourcesService {
  private readonly git = new GitService();

  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaceAccess: WorkspaceAccessService,
    private readonly environments: EnvironmentsService,
  ) {}

  async create(userId: string, projectId: string, dto: CreateSourceDto) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    this.workspaceAccess.requireWriteAccess(membership.role);

    const url = dto.url.trim();
    const branch = await this.resolveBranch(url, dto.branch);

    const source = await this.prisma.sourceRepository.create({
      data: {
        projectId,
        type: dto.type,
        url,
        branch,
      },
      select: sourceSelect,
    });

    await this.prisma.project.update({
      where: { id: projectId },
      data: {
        defaultBranch: branch,
        sourceUrl: url,
        sourceType: dto.type,
      },
    });

    await this.environments.ensureDefaultProduction(projectId);

    return source;
  }

  async list(userId: string, projectId: string) {
    await this.workspaceAccess.requireProjectAccess(userId, projectId);

    return this.prisma.sourceRepository.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
      select: sourceSelect,
    });
  }

  private async resolveBranch(url: string, requested?: string): Promise<string> {
    const explicit = requested?.trim();
    if (explicit) {
      return explicit;
    }
    if (isPlaceholderGitUrl(url)) {
      return 'main';
    }
    const detected = await this.git.detectRepository(url);
    return detected.defaultBranch?.trim() || 'main';
  }
}
