import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { LaunchService } from './launch.service';

@Controller('projects/:projectId/launch')
@UseGuards(JwtAuthGuard)
export class LaunchController {
  constructor(private readonly launch: LaunchService) {}

  @Post('plan')
  createPlan(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Body() body: { environmentId?: string },
  ) {
    return this.launch.createPlan(user.id, projectId, body);
  }

  @Post()
  startLaunch(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Body()
    body: {
      dryRun?: boolean;
      confirm?: boolean;
      environmentId?: string;
      launchRunId?: string;
    },
  ) {
    return this.launch.startLaunch(user.id, projectId, body ?? {});
  }

  @Get(':launchRunId')
  getRun(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('launchRunId') launchRunId: string,
  ) {
    return this.launch.getLaunchRun(user.id, projectId, launchRunId);
  }

  @Post(':launchRunId/confirm')
  confirm(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('launchRunId') launchRunId: string,
    @Body() body: { planVersion?: string; acceptance?: boolean },
  ) {
    return this.launch.confirmLaunch(user.id, projectId, launchRunId, body ?? {});
  }

  @Post(':launchRunId/execute')
  execute(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('launchRunId') launchRunId: string,
    @Body() body: { confirmLaunchExecution?: boolean; gateOnly?: boolean },
  ) {
    return this.launch.executeLaunch(user.id, projectId, launchRunId, body ?? {});
  }

  @Post(':launchRunId/gate')
  gate(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('launchRunId') launchRunId: string,
  ) {
    return this.launch.gateLaunch(user.id, projectId, launchRunId);
  }

  @Post(':launchRunId/cancel')
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('launchRunId') launchRunId: string,
  ) {
    return this.launch.cancelLaunchRun(user.id, projectId, launchRunId);
  }

  @Post(':launchRunId/resume')
  resume(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('launchRunId') launchRunId: string,
  ) {
    return this.launch.resumeLaunchRun(user.id, projectId, launchRunId);
  }
}
