import {
  Controller,
  Delete,
  Get,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { GitHubConnectionsService } from './github-connections.service';

@Controller('git/github')
export class GitHubConnectionsController {
  constructor(private readonly github: GitHubConnectionsService) {}

  @Get('config')
  config() {
    return this.github.getConfigStatus();
  }

  @Get('status')
  @UseGuards(JwtAuthGuard)
  status(@CurrentUser() user: AuthUser) {
    return this.github.getStatus(user.id);
  }

  @Get('authorize')
  @UseGuards(JwtAuthGuard)
  authorize(
    @CurrentUser() user: AuthUser,
    @Query('returnTo') returnTo?: string,
  ) {
    return this.github.createAuthorizeUrl(user.id, returnTo);
  }

  @Get('callback')
  async callback(
    @Query('installation_id') installationId: string | undefined,
    @Query('setup_action') setupAction: string | undefined,
    @Query('state') state: string | undefined,
    @Res() res: Response,
  ) {
    const redirectTo = await this.github.handleCallback({
      installation_id: installationId,
      setup_action: setupAction,
      state,
    });
    return res.redirect(302, redirectTo);
  }

  @Get('repositories')
  @UseGuards(JwtAuthGuard)
  repositories(
    @CurrentUser() user: AuthUser,
    @Query('q') q?: string,
  ) {
    return this.github.listRepositories(user.id, q);
  }

  @Delete('connection')
  @UseGuards(JwtAuthGuard)
  disconnect(@CurrentUser() user: AuthUser) {
    return this.github.disconnect(user.id);
  }
}
