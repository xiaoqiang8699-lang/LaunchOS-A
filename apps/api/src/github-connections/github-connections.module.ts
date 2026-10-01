import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { GitHubConnectionsController } from './github-connections.controller';
import { GitHubConnectionsService } from './github-connections.service';

@Module({
  imports: [AuthModule, WorkspacesModule],
  controllers: [GitHubConnectionsController],
  providers: [GitHubConnectionsService],
  exports: [GitHubConnectionsService],
})
export class GitHubConnectionsModule {}
