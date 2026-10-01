import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProviderAccountsModule } from '../provider-accounts/provider-accounts.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { CloudResourcesController } from './cloud-resources.controller';
import { CloudResourcesService } from './cloud-resources.service';
import { ProjectResourcesController } from './project-resources.controller';

@Module({
  imports: [AuthModule, WorkspacesModule, ProviderAccountsModule],
  controllers: [CloudResourcesController, ProjectResourcesController],
  providers: [CloudResourcesService],
})
export class CloudResourcesModule {}
