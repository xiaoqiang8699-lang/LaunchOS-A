import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@launchos/database';
import { PrismaService } from '../database/prisma.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import type { CreateEnvironmentDto } from './dto/create-environment.dto';

/** Control-plane default env name used by LaunchOS launch/plan resolution. */
export const DEFAULT_PROJECT_ENVIRONMENT_NAME = 'production';
export const DEFAULT_PROJECT_ENVIRONMENT_TYPE = 'production';

@Injectable()
export class EnvironmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaceAccess: WorkspaceAccessService,
  ) {}

  async create(userId: string, projectId: string, dto: CreateEnvironmentDto) {
    const { membership } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    this.workspaceAccess.requireWriteAccess(membership.role);

    const name = (dto.name?.trim() || dto.type).toLowerCase();

    const existing = await this.prisma.projectEnvironment.findUnique({
      where: {
        projectId_name: {
          projectId,
          name,
        },
      },
    });

    if (existing) {
      throw new ConflictException('Environment already exists');
    }

    return this.prisma.projectEnvironment.create({
      data: {
        projectId,
        name,
        type: dto.type,
        variables: dto.variables ?? {},
      },
    });
  }

  /**
   * Idempotent control-plane default environment (no cloud resources).
   * Unique on (projectId, name=production). Safe under concurrent callers.
   */
  async ensureDefaultProduction(projectId: string) {
    const existing = await this.prisma.projectEnvironment.findUnique({
      where: {
        projectId_name: {
          projectId,
          name: DEFAULT_PROJECT_ENVIRONMENT_NAME,
        },
      },
    });
    if (existing) {
      return existing;
    }

    try {
      return await this.prisma.projectEnvironment.create({
        data: {
          projectId,
          name: DEFAULT_PROJECT_ENVIRONMENT_NAME,
          type: DEFAULT_PROJECT_ENVIRONMENT_TYPE,
          variables: {},
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const raced = await this.prisma.projectEnvironment.findUnique({
          where: {
            projectId_name: {
              projectId,
              name: DEFAULT_PROJECT_ENVIRONMENT_NAME,
            },
          },
        });
        if (raced) {
          return raced;
        }
      }
      throw error;
    }
  }
}
