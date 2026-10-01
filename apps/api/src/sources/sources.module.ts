import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EnvironmentsModule } from '../environments/environments.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { GitDetectController } from './git-detect.controller';
import { SourcesController } from './sources.controller';
import { SourcesService } from './sources.service';

@Module({
  imports: [AuthModule, WorkspacesModule, EnvironmentsModule],
  controllers: [SourcesController, GitDetectController],
  providers: [SourcesService],
})
export class SourcesModule {}
