import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ServerPlanController } from './server-plan.controller';
import { ServerPlanService } from './server-plan.service';

@Module({
  imports: [AuthModule, WorkspacesModule],
  controllers: [ServerPlanController],
  providers: [ServerPlanService],
  exports: [ServerPlanService],
})
export class ServerPlanModule {}
