import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { ServerProvisionService } from './server-provision.service';
import { ServerInitializationService } from '../server-initialization/server-initialization.service';
import { CreateServerProvisionDto, DestroyServerProvisionDto } from './dto/server-provision.dto';
import { InitializeServerDto } from '../server-initialization/dto/initialize-server.dto';

/**
 * Project server surface.
 * Full paths (globalPrefix=api/v1):
 *   POST   /api/v1/projects/:projectId/server/initialize
 *   GET    /api/v1/projects/:projectId/server/initialization
 *   GET    /api/v1/projects/:projectId/server/initialization/:id
 *   + existing provision routes
 */
@Controller('projects/:projectId/server')
@UseGuards(JwtAuthGuard)
export class ServerProvisionController {
  constructor(
    private readonly provisions: ServerProvisionService,
    private readonly initialization: ServerInitializationService,
  ) {}

  @Post('initialize')
  initialize(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Body() body: InitializeServerDto,
  ) {
    return this.initialization.initialize(user.id, projectId, body.serverInstanceId);
  }

  @Get('initialization')
  initializationLatest(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
  ) {
    return this.initialization.getStatus(user.id, projectId);
  }

  @Get('initialization/:id')
  initializationById(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.initialization.getStatus(user.id, projectId, id);
  }

  @Get('provision/dry-run')
  dryRun(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Query('profile') profile?: 'DEV' | 'STANDARD' | 'PRODUCTION',
  ) {
    return this.provisions.getDryRunPreview(user.id, projectId, profile || 'STANDARD');
  }

  @Post('provision')
  create(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Body() body: CreateServerProvisionDto,
  ) {
    return this.provisions.create(user.id, projectId, body);
  }

  @Get('provisions')
  list(@CurrentUser() user: AuthUser, @Param('projectId') projectId: string) {
    return this.provisions.list(user.id, projectId);
  }

  @Get('provisions/:id')
  status(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.provisions.getStatus(user.id, projectId, id);
  }

  @Post('provisions/:id/retry')
  retry(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.provisions.retry(user.id, projectId, id);
  }

  @Post('provisions/:id/destroy')
  destroy(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() body: DestroyServerProvisionDto,
  ) {
    return this.provisions.destroy(user.id, projectId, id, body);
  }
}
