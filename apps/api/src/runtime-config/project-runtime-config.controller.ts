import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { RuntimeConfigScopeType } from '@launchos/database';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { PromoteRuntimeConfigDto } from './dto/promote-runtime-config.dto';
import { UpdateRotationPolicyDto } from './dto/update-rotation-policy.dto';
import { UpsertRuntimeConfigDto } from './dto/upsert-runtime-config.dto';
import { RuntimeConfigService } from './runtime-config.service';

@Controller('projects/:projectId')
@UseGuards(JwtAuthGuard)
export class ProjectRuntimeConfigController {
  constructor(private readonly runtimeConfig: RuntimeConfigService) {}

  @Get('config')
  list(@CurrentUser() user: AuthUser, @Param('projectId') projectId: string) {
    return this.runtimeConfig.listProjectConfig(user.id, projectId);
  }

  @Get('config/security-summary')
  securitySummary(@CurrentUser() user: AuthUser, @Param('projectId') projectId: string) {
    return this.runtimeConfig.getSecuritySummary(user.id, projectId);
  }

  @Get('config/audit')
  audit(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Query('key') key?: string,
    @Query('unitId') unitId?: string,
    @Query('scope') scope?: RuntimeConfigScopeType,
  ) {
    return this.runtimeConfig.listAuditEvents(user.id, projectId, { key, unitId, scope });
  }

  @Put('config/:key')
  upsert(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('key') key: string,
    @Body() body: UpsertRuntimeConfigDto,
  ) {
    return this.runtimeConfig.upsertProjectValue(user.id, projectId, key, body.value);
  }

  @Patch('config/:key/rotation-policy')
  updateRotationPolicy(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('key') key: string,
    @Body() body: UpdateRotationPolicyDto,
  ) {
    return this.runtimeConfig.updateProjectRotationPolicy(
      user.id,
      projectId,
      key,
      body.rotationIntervalDays ?? null,
    );
  }

  @Get('config/:key/delete-impact')
  deleteImpact(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('key') key: string,
  ) {
    return this.runtimeConfig.getProjectDeleteImpact(user.id, projectId, key);
  }

  @Delete('config/:key')
  remove(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('key') key: string,
  ) {
    return this.runtimeConfig.deleteProjectValue(user.id, projectId, key);
  }

  @Post('config/:key/promote-from-unit')
  promoteFromUnit(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('key') key: string,
    @Body() body: PromoteRuntimeConfigDto,
  ) {
    return this.runtimeConfig.promoteToShared(user.id, projectId, body.unitId, key);
  }
}
