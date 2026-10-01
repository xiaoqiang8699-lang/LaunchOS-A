import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { ServicesService } from './services.service';

@Controller('projects')
@UseGuards(JwtAuthGuard)
export class ServicesController {
  constructor(private readonly servicesService: ServicesService) {}

  @Get(':id/services')
  list(@CurrentUser() user: AuthUser, @Param('id') projectId: string) {
    return this.servicesService.list(user.id, projectId);
  }
}
