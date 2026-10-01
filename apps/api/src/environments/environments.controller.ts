import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { CreateEnvironmentDto } from './dto/create-environment.dto';
import { EnvironmentsService } from './environments.service';

@Controller('projects')
@UseGuards(JwtAuthGuard)
export class EnvironmentsController {
  constructor(private readonly environmentsService: EnvironmentsService) {}

  @Post(':id/environments')
  create(
    @CurrentUser() user: AuthUser,
    @Param('id') projectId: string,
    @Body() dto: CreateEnvironmentDto,
  ) {
    return this.environmentsService.create(user.id, projectId, dto);
  }
}
