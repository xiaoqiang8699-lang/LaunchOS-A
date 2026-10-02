import { Module } from '@nestjs/common';
import { DeploymentEngineService } from '@launchos/deployment';
import { AnalysesModule } from '../analyses/analyses.module';
import { AuthModule } from '../auth/auth.module';
import { PrismaService } from '../database/prisma.service';
import { QueueModule } from '../queue/queue.module';
import { RuntimeConfigModule } from '../runtime-config/runtime-config.module';
import { DependenciesModule } from '../dependencies/dependencies.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ManagedHostingModule } from '../managed-hosting/managed-hosting.module';
import { CapacityModule } from '../capacity/capacity.module';
import { BillingModule } from '../billing/billing.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { AIGrowthModule } from '../ai-growth/ai-growth.module';
import { DeploymentsController } from './deployments.controller';
import { DeploymentsService } from './deployments.service';
import { ProjectDeploymentsController } from './project-deployments.controller';
import { ProjectPreflightController } from './project-preflight.controller';

@Module({
  imports: [
    AuthModule,
    WorkspacesModule,
    QueueModule,
    AnalysesModule,
    RuntimeConfigModule,
    DependenciesModule,
    ManagedHostingModule,
    CapacityModule,
    BillingModule,
    AnalyticsModule,
    AIGrowthModule,
  ],
  controllers: [ProjectPreflightController, ProjectDeploymentsController, DeploymentsController],
  providers: [
    DeploymentsService,
    {
      provide: DeploymentEngineService,
      useFactory: (prisma: PrismaService) => new DeploymentEngineService(prisma),
      inject: [PrismaService],
    },
  ],
  exports: [DeploymentsService],
})
export class DeploymentsModule {}
