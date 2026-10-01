import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { AppsService } from '../apps/apps.service';
import { DeployableUnitsService } from './deployable-units.service';

@Controller('projects/:projectId/deployable-units')
@UseGuards(JwtAuthGuard)
export class DeployableUnitsController {
  constructor(
    private readonly units: DeployableUnitsService,
    private readonly apps: AppsService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Param('projectId') projectId: string) {
    return this.units.list(user.id, projectId);
  }

  @Post('scan')
  scan(@CurrentUser() user: AuthUser, @Param('projectId') projectId: string) {
    return this.units.scan(user.id, projectId);
  }

  @Patch(':unitId')
  patch(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('unitId') unitId: string,
    @Body()
    body: { name?: string; status?: 'CONFIRMED' | 'IGNORED' | 'DETECTED'; select?: boolean },
  ) {
    return this.units.patch(user.id, projectId, unitId, body);
  }

  @Post(':unitId/redeploy')
  redeploy(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('unitId') unitId: string,
  ) {
    return this.apps.redeploy(user.id, projectId, unitId);
  }

  @Post(':unitId/start')
  start(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('unitId') unitId: string,
  ) {
    return this.apps.start(user.id, projectId, unitId);
  }

  @Post(':unitId/stop')
  stop(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('unitId') unitId: string,
  ) {
    return this.apps.stop(user.id, projectId, unitId);
  }
}
