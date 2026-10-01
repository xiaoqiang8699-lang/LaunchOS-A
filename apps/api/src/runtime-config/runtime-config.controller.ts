import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { UpdateRotationPolicyDto } from './dto/update-rotation-policy.dto';
import { UpsertRuntimeConfigDto } from './dto/upsert-runtime-config.dto';
import { RuntimeConfigService } from './runtime-config.service';

@Controller('projects/:projectId/units/:unitId')
@UseGuards(JwtAuthGuard)
export class RuntimeConfigController {
  constructor(private readonly runtimeConfig: RuntimeConfigService) {}

  @Get('config-requirements')
  list(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('unitId') unitId: string,
  ) {
    return this.runtimeConfig.listRequirements(user.id, projectId, unitId);
  }

  @Put('config/:key')
  upsert(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('unitId') unitId: string,
    @Param('key') key: string,
    @Body() body: UpsertRuntimeConfigDto,
  ) {
    return this.runtimeConfig.upsertValue(user.id, projectId, unitId, key, body.value);
  }

  @Post('config/:key/generate')
  generate(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('unitId') unitId: string,
    @Param('key') key: string,
  ) {
    return this.runtimeConfig.generateValue(user.id, projectId, unitId, key);
  }

  @Patch('config/:key/rotation-policy')
  updateRotationPolicy(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('unitId') unitId: string,
    @Param('key') key: string,
    @Body() body: UpdateRotationPolicyDto,
  ) {
    return this.runtimeConfig.updateUnitRotationPolicy(
      user.id,
      projectId,
      unitId,
      key,
      body.rotationIntervalDays ?? null,
    );
  }

  @Get('config/:key/delete-impact')
  deleteImpact(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('unitId') unitId: string,
    @Param('key') key: string,
  ) {
    return this.runtimeConfig.getUnitDeleteImpact(user.id, projectId, unitId, key);
  }

  @Delete('config/:key')
  remove(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('unitId') unitId: string,
    @Param('key') key: string,
  ) {
    return this.runtimeConfig.deleteValue(user.id, projectId, unitId, key);
  }

  @Post('config/:key/restore-shared')
  restoreShared(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('unitId') unitId: string,
    @Param('key') key: string,
  ) {
    return this.runtimeConfig.restoreShared(user.id, projectId, unitId, key);
  }

  @Post('config/rescan')
  rescan(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('unitId') unitId: string,
  ) {
    return this.runtimeConfig.rescan(user.id, projectId, unitId);
  }
}
