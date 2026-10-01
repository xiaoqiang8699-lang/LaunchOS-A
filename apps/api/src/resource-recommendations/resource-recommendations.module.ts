import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ResourceRecommendationsController } from './resource-recommendations.controller';
import { ResourceRecommendationsService } from './resource-recommendations.service';

@Module({
  imports: [AuthModule, WorkspacesModule],
  controllers: [ResourceRecommendationsController],
  providers: [ResourceRecommendationsService],
})
export class ResourceRecommendationsModule {}
