import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { AIOnboardingOptimizerService } from './ai-onboarding-optimizer.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';

@Controller()
@UseGuards(JwtAuthGuard)
export class ActivationController {
  constructor(
    private readonly onboarding: AIOnboardingOptimizerService,
    private readonly access: WorkspaceAccessService,
  ) {}

  @Get('activation')
  async myActivation(@CurrentUser() user: AuthUser) {
    return this.onboarding.getCurrentUserActivation(user.id);
  }

  @Get('projects/:id/activation')
  async projectActivation(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.access.requireProjectAccess(user.id, id);
    return this.onboarding.getProjectActivation(user.id, id);
  }
}
