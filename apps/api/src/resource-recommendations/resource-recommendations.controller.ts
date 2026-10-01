import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { ResourceRecommendationsService } from './resource-recommendations.service';

@Controller('projects')
@UseGuards(JwtAuthGuard)
export class ResourceRecommendationsController {
  constructor(private readonly recommendations: ResourceRecommendationsService) {}

  @Get(':id/resource-recommendation')
  getForProject(@CurrentUser() user: AuthUser, @Param('id') projectId: string) {
    return this.recommendations.getForProject(user.id, projectId);
  }
}
