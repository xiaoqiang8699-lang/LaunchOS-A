import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { CloudResourcesService } from './cloud-resources.service';

@Controller('projects')
@UseGuards(JwtAuthGuard)
export class ProjectResourcesController {
  constructor(private readonly cloudResourcesService: CloudResourcesService) {}

  @Post(':id/resources/create')
  createFromRecommendation(@CurrentUser() user: AuthUser, @Param('id') projectId: string) {
    return this.cloudResourcesService.createFromRecommendation(user.id, projectId);
  }

  @Get(':id/resources')
  listByProject(@CurrentUser() user: AuthUser, @Param('id') projectId: string) {
    return this.cloudResourcesService.listByProject(user.id, projectId);
  }
}
