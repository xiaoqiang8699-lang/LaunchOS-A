import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { DeploymentsService } from './deployments.service';

@Controller('deployments')
@UseGuards(JwtAuthGuard)
export class DeploymentsController {
  constructor(private readonly deploymentsService: DeploymentsService) {}

  @Get(':id/diagnosis')
  getDiagnosis(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.deploymentsService.getDiagnosis(user.id, id);
  }

  @Get(':id/artifacts')
  listArtifacts(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.deploymentsService.listArtifacts(user.id, id);
  }

  @Post(':id/cloud-deploy')
  cloudDeploy(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.deploymentsService.cloudDeploy(user.id, id);
  }

  @Get(':id/remote-status')
  getRemoteStatus(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.deploymentsService.getRemoteStatus(user.id, id);
  }

  @Get(':id/experience')
  getExperience(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.deploymentsService.getExperience(user.id, id);
  }

  @Post(':id/requeue')
  requeue(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.deploymentsService.requeue(user.id, id);
  }

  @Get(':id/advanced-logs')
  getAdvancedLogs(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.deploymentsService.getAdvancedLogs(user.id, id);
  }

  @Get(':id')
  getById(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.deploymentsService.getById(user.id, id);
  }
}
