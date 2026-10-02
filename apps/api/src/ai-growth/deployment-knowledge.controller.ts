import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import {
  DeploymentKnowledgeService,
  KnowledgeExtractionService,
} from './deployment-knowledge.service';

@Controller('deployment-knowledge')
@UseGuards(JwtAuthGuard)
export class DeploymentKnowledgeController {
  constructor(
    private readonly knowledge: DeploymentKnowledgeService,
    private readonly extraction: KnowledgeExtractionService,
    private readonly workspaceAccess: WorkspaceAccessService,
  ) {}

  @Get()
  list(@Query('category') category?: string, @Query('q') q?: string) {
    return this.knowledge.listPublic({ category, q });
  }

  @Post('extract/:deploymentId')
  async extract(@CurrentUser() user: AuthUser, @Param('deploymentId') deploymentId: string) {
    await this.workspaceAccess.requireDeploymentAccess(user.id, deploymentId);
    return this.extraction.extractFromSuccessfulDeployment(deploymentId);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.knowledge.getItem(id);
  }

  @Post(':id/feedback')
  feedback(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: { deploymentId: string; result: 'SUCCESS' | 'FAILED' },
  ) {
    return this.knowledge.submitFeedback(user.id, id, body);
  }
}
