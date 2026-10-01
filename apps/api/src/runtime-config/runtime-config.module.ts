import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ProjectRuntimeConfigController } from './project-runtime-config.controller';
import { RuntimeConfigController } from './runtime-config.controller';
import { RuntimeConfigService } from './runtime-config.service';

@Module({
  imports: [AuthModule, WorkspacesModule],
  controllers: [RuntimeConfigController, ProjectRuntimeConfigController],
  providers: [RuntimeConfigService],
  exports: [RuntimeConfigService],
})
export class RuntimeConfigModule {}
