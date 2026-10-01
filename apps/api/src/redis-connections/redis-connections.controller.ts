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
  CreateRedisConnectionDto,
  TestRedisConnectionDto,
  UpdateRedisConnectionDto,
} from './dto/redis-connection.dto';
import { RedisConnectionsService } from './redis-connections.service';

@Controller('projects/:projectId/redis-connections')
@UseGuards(JwtAuthGuard)
export class RedisConnectionsController {
  constructor(private readonly redisConnections: RedisConnectionsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Param('projectId') projectId: string) {
    return this.redisConnections.list(user.id, projectId);
  }

  @Get('summary')
  summary(@CurrentUser() user: AuthUser, @Param('projectId') projectId: string) {
    return this.redisConnections.getSummary(user.id, projectId);
  }

  @Post('test')
  test(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Body() body: TestRedisConnectionDto,
  ) {
    return this.redisConnections.test(user.id, projectId, body);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Body() body: CreateRedisConnectionDto,
  ) {
    return this.redisConnections.create(user.id, projectId, body);
  }

  @Get(':id/delete-impact')
  deleteImpact(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.redisConnections.getDeleteImpact(user.id, projectId, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() body: UpdateRedisConnectionDto,
  ) {
    return this.redisConnections.update(user.id, projectId, id, body);
  }

  @Delete(':id')
  remove(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.redisConnections.remove(user.id, projectId, id);
  }
}
