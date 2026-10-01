import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GitHubConnectionsModule } from '../github-connections/github-connections.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { AnalysesController } from './analyses.controller';
import { AnalysesService } from './analyses.service';

@Module({
  imports: [AuthModule, WorkspacesModule, GitHubConnectionsModule],
  controllers: [AnalysesController],
  providers: [AnalysesService],
  exports: [AnalysesService],
})
export class AnalysesModule {}
