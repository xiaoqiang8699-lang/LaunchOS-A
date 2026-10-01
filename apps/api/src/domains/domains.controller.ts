import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { CreateDomainDto } from './dto/create-domain.dto';
import { DomainsService } from './domains.service';

@Controller('projects')
@UseGuards(JwtAuthGuard)
export class DomainsController {
  constructor(private readonly domainsService: DomainsService) {}

  @Post(':id/domains')
  create(
    @CurrentUser() user: AuthUser,
    @Param('id') projectId: string,
    @Body() dto: CreateDomainDto,
  ) {
    return this.domainsService.create(user.id, projectId, dto);
  }

  @Get(':id/domains')
  list(@CurrentUser() user: AuthUser, @Param('id') projectId: string) {
    return this.domainsService.list(user.id, projectId);
  }
}
