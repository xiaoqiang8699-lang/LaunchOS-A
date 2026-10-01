import { Module } from '@nestjs/common';
import { AppsController } from '../apps/apps.controller';
import { AppsService } from '../apps/apps.service';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { DeploymentsModule } from '../deployments/deployments.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({
  imports: [AuthModule, BillingModule, WorkspacesModule, DeploymentsModule],
  controllers: [ProjectsController, AppsController],
  providers: [ProjectsService, AppsService],
  exports: [ProjectsService, AppsService],
})
export class ProjectsModule {}
