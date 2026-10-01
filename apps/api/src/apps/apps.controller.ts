import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { ProjectsService } from '../projects/projects.service';
import { AppsService } from './apps.service';
import { UpdateAppSettingsDto } from './dto/update-app-settings.dto';

@Controller('apps')
@UseGuards(JwtAuthGuard)
export class AppsController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly appsService: AppsService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.projectsService.listApps(user.id);
  }

  @Get(':id/logs')
  logs(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('tail') tail?: string) {
    const parsed = Number(tail);
    return this.appsService.logs(user.id, id, Number.isInteger(parsed) ? parsed : undefined);
  }

  @Get(':id/health')
  health(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('refreshPublic') refreshPublic?: string,
  ) {
    return this.appsService.health(user.id, id, {
      refreshPublic: refreshPublic === '1' || refreshPublic === 'true',
    });
  }

  @Get(':id/runtime')
  runtime(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('refreshPublic') refreshPublic?: string,
  ) {
    return this.appsService.runtimeHealth(user.id, id, {
      refreshPublic: refreshPublic === '1' || refreshPublic === 'true',
    });
  }

  @Get(':id/issues')
  issues(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.appsService.issues(user.id, id);
  }

  @Get(':id/versions')
  versions(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.appsService.versions(user.id, id);
  }

  @Get(':id/settings')
  settings(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.appsService.getSettings(user.id, id);
  }

  @Get(':id')
  getById(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.projectsService.getApp(user.id, id);
  }

  @Post(':id/start')
  start(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('deployableUnitId') deployableUnitId?: string,
  ) {
    return this.appsService.start(user.id, id, deployableUnitId);
  }

  @Post(':id/stop')
  stop(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('deployableUnitId') deployableUnitId?: string,
  ) {
    return this.appsService.stop(user.id, id, deployableUnitId);
  }

  @Post(':id/restart')
  restart(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('deployableUnitId') deployableUnitId?: string,
  ) {
    return this.appsService.restart(user.id, id, deployableUnitId);
  }

  @Post(':id/redeploy')
  redeploy(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.appsService.redeploy(user.id, id);
  }

  @Post(':id/rollback/:versionId')
  rollback(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
  ) {
    return this.appsService.rollback(user.id, id, versionId);
  }

  @Post(':id/environments/:environmentId/rollback')
  rollbackEnvironment(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('environmentId') environmentId: string,
  ) {
    return this.appsService.rollbackEnvironment(user.id, id, environmentId);
  }

  @Post(':id/settings')
  updateSettings(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateAppSettingsDto,
  ) {
    return this.appsService.updateSettings(user.id, id, dto);
  }
}
