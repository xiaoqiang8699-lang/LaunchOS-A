import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { ServerPlanService } from './server-plan.service';
import { UpdateServerPlanDto } from './dto/server-plan.dto';

@Controller('projects/:projectId/server-plan')
@UseGuards(JwtAuthGuard)
export class ServerPlanController {
  constructor(private readonly serverPlan: ServerPlanService) {}

  @Get()
  get(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Query('simulateNoServer') simulateNoServer?: string,
    @Query('profile') profile?: 'DEV' | 'STANDARD' | 'PRODUCTION',
    @Query('region') region?: string,
  ) {
    return this.serverPlan.getPlan(user.id, projectId, {
      simulateNoServer: simulateNoServer === '1' || simulateNoServer === 'true',
      profile,
      region,
    });
  }

  @Post()
  update(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Body() body: UpdateServerPlanDto,
  ) {
    return this.serverPlan.updatePlan(user.id, projectId, body);
  }
}
