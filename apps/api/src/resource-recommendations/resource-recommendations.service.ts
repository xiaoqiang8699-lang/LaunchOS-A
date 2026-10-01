import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@launchos/database';
import { CloudPlanner, MOCK_CLOUD_PLANS } from '@launchos/providers';
import { PrismaService } from '../database/prisma.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';

const planSelect = {
  id: true,
  name: true,
  cpu: true,
  memory: true,
  storage: true,
  database: true,
  description: true,
  createdAt: true,
} as const;

const recommendationSelect = {
  id: true,
  projectId: true,
  planId: true,
  reason: true,
  createdAt: true,
  plan: { select: planSelect },
} as const;

const deploymentPlanSelect = {
  id: true,
  projectId: true,
  runtime: true,
  buildCommand: true,
  startCommand: true,
  port: true,
  config: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class ResourceRecommendationsService {
  private readonly planner = new CloudPlanner();

  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaceAccess: WorkspaceAccessService,
  ) {}

  async getForProject(userId: string, projectId: string) {
    await this.workspaceAccess.requireProjectAccess(userId, projectId);

    const deploymentPlan = await this.prisma.deploymentPlan.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: deploymentPlanSelect,
    });
    if (!deploymentPlan) {
      throw new BadRequestException('Deployment plan is required');
    }

    await this.ensureMockPlans();

    const suggested = this.planner.recommendPlan({
      runtime: deploymentPlan.runtime,
      buildCommand: deploymentPlan.buildCommand,
      startCommand: deploymentPlan.startCommand,
      port: deploymentPlan.port,
      config: asConfig(deploymentPlan.config),
    });

    const cloudPlan = await this.prisma.cloudPlan.findUniqueOrThrow({
      where: { name: suggested.name },
      select: { id: true },
    });

    const latest = await this.prisma.resourceRecommendation.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: recommendationSelect,
    });
    if (latest && latest.planId === cloudPlan.id && latest.reason === suggested.reason) {
      return { recommendation: latest, deploymentPlan };
    }

    const recommendation = await this.prisma.resourceRecommendation.create({
      data: {
        projectId,
        planId: cloudPlan.id,
        reason: suggested.reason,
      },
      select: recommendationSelect,
    });

    return { recommendation, deploymentPlan };
  }

  private async ensureMockPlans(): Promise<void> {
    for (const plan of MOCK_CLOUD_PLANS) {
      await this.prisma.cloudPlan.upsert({
        where: { name: plan.name },
        update: {
          cpu: plan.cpu,
          memory: plan.memory,
          storage: plan.storage,
          database: plan.database,
          description: plan.description,
        },
        create: {
          name: plan.name,
          cpu: plan.cpu,
          memory: plan.memory,
          storage: plan.storage,
          database: plan.database,
          description: plan.description,
        },
      });
    }
  }
}

function asConfig(value: Prisma.JsonValue): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}
