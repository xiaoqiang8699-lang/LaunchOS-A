import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { CreateSourceDto } from './dto/create-source.dto';
import { SourcesService } from './sources.service';

@Controller('projects')
@UseGuards(JwtAuthGuard)
export class SourcesController {
  constructor(private readonly sourcesService: SourcesService) {}

  @Post(':id/sources')
  create(
    @CurrentUser() user: AuthUser,
    @Param('id') projectId: string,
    @Body() dto: CreateSourceDto,
  ) {
    return this.sourcesService.create(user.id, projectId, dto);
  }

  @Get(':id/sources')
  list(@CurrentUser() user: AuthUser, @Param('id') projectId: string) {
    return this.sourcesService.list(user.id, projectId);
  }
}
