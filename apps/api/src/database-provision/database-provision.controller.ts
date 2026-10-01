import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { DatabaseProvisionService } from './database-provision.service';
import {
  CreateDatabaseProvisionDto,
  DeleteDatabaseProvisionDto,
  RetryDatabaseProvisionDto,
} from './dto/database-provision.dto';

@Controller('projects/:projectId/database-provisions')
@UseGuards(JwtAuthGuard)
export class DatabaseProvisionController {
  constructor(private readonly provisions: DatabaseProvisionService) {}

  @Get('options')
  options(@CurrentUser() user: AuthUser, @Param('projectId') projectId: string) {
    return this.provisions.getOptions(user.id, projectId);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Param('projectId') projectId: string) {
    return this.provisions.list(user.id, projectId);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Body() body: CreateDatabaseProvisionDto,
  ) {
    return this.provisions.create(user.id, projectId, body);
  }

  @Get(':id')
  status(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.provisions.getStatus(user.id, projectId, id);
  }

  @Post(':id/retry')
  retry(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() _body: RetryDatabaseProvisionDto,
  ) {
    return this.provisions.retry(user.id, projectId, id);
  }

  @Post(':id/unlink')
  unlink(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.provisions.unlink(user.id, projectId, id);
  }

  @Post(':id/delete')
  destroy(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() body: DeleteDatabaseProvisionDto,
  ) {
    return this.provisions.destroy(user.id, projectId, id, body);
  }
}
