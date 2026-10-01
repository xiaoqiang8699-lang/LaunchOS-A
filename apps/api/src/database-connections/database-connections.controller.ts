import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import {
  CreateDatabaseConnectionDto,
  TestDatabaseConnectionDto,
  UpdateDatabaseConnectionDto,
} from './dto/database-connection.dto';
import { DatabaseConnectionsService } from './database-connections.service';

@Controller('projects/:projectId/database-connections')
@UseGuards(JwtAuthGuard)
export class DatabaseConnectionsController {
  constructor(private readonly databaseConnections: DatabaseConnectionsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Param('projectId') projectId: string) {
    return this.databaseConnections.list(user.id, projectId);
  }

  @Get('summary')
  summary(@CurrentUser() user: AuthUser, @Param('projectId') projectId: string) {
    return this.databaseConnections.getSummary(user.id, projectId);
  }

  @Post('test')
  test(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Body() body: TestDatabaseConnectionDto,
  ) {
    return this.databaseConnections.test(user.id, projectId, body);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Body() body: CreateDatabaseConnectionDto,
  ) {
    return this.databaseConnections.create(user.id, projectId, body);
  }

  @Get(':id/delete-impact')
  deleteImpact(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.databaseConnections.getDeleteImpact(user.id, projectId, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() body: UpdateDatabaseConnectionDto,
  ) {
    return this.databaseConnections.update(user.id, projectId, id, body);
  }

  @Delete(':id')
  remove(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.databaseConnections.remove(user.id, projectId, id);
  }
}
