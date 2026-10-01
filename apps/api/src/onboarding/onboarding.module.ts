import { Module } from '@nestjs/common';
import { AnalysesModule } from '../analyses/analyses.module';
import { AuthModule } from '../auth/auth.module';
import { LaunchModule } from '../launch/launch.module';
import { ProjectsModule } from '../projects/projects.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

@Module({
  imports: [AuthModule, WorkspacesModule, ProjectsModule, AnalysesModule, LaunchModule],
  controllers: [OnboardingController],
  providers: [OnboardingService],
  exports: [OnboardingService],
})
export class OnboardingModule {}
