import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import type { DependencyType } from '@launchos/shared';
import { DependenciesService } from './dependencies.service';
import { ConnectDependencyDto, ProvisionDependencyDto } from './dto/dependency.dto';

@Controller('projects/:projectId/dependencies')
@UseGuards(JwtAuthGuard)
export class DependenciesController {
  constructor(private readonly dependencies: DependenciesService) {}

  @Get()
  summary(@CurrentUser() user: AuthUser, @Param('projectId') projectId: string) {
    return this.dependencies.getProjectSummary(user.id, projectId);
  }

  @Get('units/:unitId')
  unitDependencies(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('unitId') unitId: string,
  ) {
    return this.dependencies.getUnitDependencies(user.id, projectId, unitId);
  }

  @Get('units/:unitId/:type/options')
  options(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('type') type: DependencyType,
  ) {
    return this.dependencies.getProvisionOptions(user.id, projectId, type);
  }

  @Post('units/:unitId/:type/validate-deploy')
  async validateDeploy(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('unitId') unitId: string,
  ) {
    await this.dependencies.getUnitDependencies(user.id, projectId, unitId);
    return this.dependencies.validateBeforeDeploy(projectId, unitId);
  }

  @Post('units/:unitId/:type/health')
  health(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('unitId') unitId: string,
    @Param('type') type: DependencyType,
  ) {
    return this.dependencies.checkHealth(user.id, projectId, unitId, type);
  }

  @Post('units/:unitId/:type/provision')
  provision(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('unitId') unitId: string,
    @Param('type') type: DependencyType,
    @Body() body: ProvisionDependencyDto,
  ) {
    return this.dependencies.provision(user.id, projectId, unitId, type, body);
  }

  @Post('units/:unitId/:type/connect')
  connect(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('unitId') unitId: string,
    @Param('type') type: DependencyType,
    @Body() body: ConnectDependencyDto,
  ) {
    return this.dependencies.connectExisting(user.id, projectId, unitId, type, body);
  }

  @Post('units/:unitId/:type/unlink')
  unlink(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('unitId') unitId: string,
    @Param('type') type: DependencyType,
  ) {
    return this.dependencies.unlink(user.id, projectId, unitId, type);
  }

  @Delete('units/:unitId/:type/cloud-resource')
  destroyCloud(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('unitId') unitId: string,
    @Param('type') type: DependencyType,
  ) {
    return this.dependencies.destroyCloudResource(user.id, projectId, unitId, type);
  }
}
