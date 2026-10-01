import { Module } from '@nestjs/common';
import { AnalysesModule } from '../analyses/analyses.module';
import { AuthModule } from '../auth/auth.module';
import { ProjectsModule } from '../projects/projects.module';
import { RuntimeConfigModule } from '../runtime-config/runtime-config.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { DeployableUnitsController } from './deployable-units.controller';
import { DeployableUnitsService } from './deployable-units.service';

@Module({
  imports: [AuthModule, WorkspacesModule, AnalysesModule, ProjectsModule, RuntimeConfigModule],
  controllers: [DeployableUnitsController],
  providers: [DeployableUnitsService],
  exports: [DeployableUnitsService],
})
export class DeployableUnitsModule {}
