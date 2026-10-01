import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { WorkspacesService } from './workspaces.service';

@Controller('workspaces')
@UseGuards(JwtAuthGuard)
export class WorkspacesController {
  constructor(private readonly workspacesService: WorkspacesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.workspacesService.listForUser(user.id);
  }

  @Get(':workspaceId/projects')
  listProjects(@CurrentUser() user: AuthUser, @Param('workspaceId') workspaceId: string) {
    return this.workspacesService.listProjects(user.id, workspaceId);
  }
}
