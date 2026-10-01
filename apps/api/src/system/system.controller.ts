import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { SystemStatusService } from './system-status.service';

@Controller('system')
@UseGuards(JwtAuthGuard)
export class SystemController {
  constructor(private readonly systemStatus: SystemStatusService) {}

  @Get('queue-status')
  getQueueStatus(@CurrentUser() user: AuthUser) {
    return this.systemStatus.getQueueStatus(user.id);
  }
}
