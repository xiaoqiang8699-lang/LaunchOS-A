import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { CreateCloudResourceDto } from './dto/create-cloud-resource.dto';
import { CloudResourcesService } from './cloud-resources.service';

@Controller('cloud-resources')
@UseGuards(JwtAuthGuard)
export class CloudResourcesController {
  constructor(private readonly cloudResourcesService: CloudResourcesService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateCloudResourceDto) {
    return this.cloudResourcesService.create(user.id, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.cloudResourcesService.list(user.id);
  }
}
