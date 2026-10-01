import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { CreateDeploymentDto } from './dto/create-deployment.dto';
import { DeploymentsService } from './deployments.service';

@Controller('projects')
@UseGuards(JwtAuthGuard)
export class ProjectDeploymentsController {
  constructor(private readonly deploymentsService: DeploymentsService) {}

  @Post(':id/deployments')
  create(
    @CurrentUser() user: AuthUser,
    @Param('id') projectId: string,
    @Body() dto: CreateDeploymentDto,
  ) {
    return this.deploymentsService.create(user.id, projectId, dto);
  }

  @Get(':id/deployments')
  list(@CurrentUser() user: AuthUser, @Param('id') projectId: string) {
    return this.deploymentsService.listByProject(user.id, projectId);
  }
}
