import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { CreateServerDto } from './dto/create-server.dto';
import { ServersService } from './servers.service';

@Controller('servers')
@UseGuards(JwtAuthGuard)
export class ServersController {
  constructor(private readonly serversService: ServersService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateServerDto) {
    return this.serversService.create(user.id, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.serversService.list(user.id);
  }

  @Get(':id')
  getById(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.serversService.getById(user.id, id);
  }

  @Post(':id/test-connection')
  testConnection(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.serversService.testConnection(user.id, id);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.serversService.remove(user.id, id);
  }
}
