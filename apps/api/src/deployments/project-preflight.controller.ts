import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { AIDeploymentPreflightService } from '../ai-growth/ai-deployment-preflight.service';

@Controller('projects')
@UseGuards(JwtAuthGuard)
export class ProjectPreflightController {
  constructor(private readonly preflight: AIDeploymentPreflightService) {}

  @Get(':id/preflight')
  getLatest(
    @CurrentUser() user: AuthUser,
    @Param('id') projectId: string,
    @Query('unitId') unitId?: string,
  ) {
    return this.preflight.getLatest(user.id, projectId, unitId || null);
  }

  @Post(':id/preflight')
  run(
    @CurrentUser() user: AuthUser,
    @Param('id') projectId: string,
    @Body() body?: { unitId?: string },
    @Query('unitId') unitId?: string,
  ) {
    return this.preflight.runPreflight(user.id, projectId, {
      unitId: body?.unitId || unitId || null,
      force: true,
    });
  }
}
