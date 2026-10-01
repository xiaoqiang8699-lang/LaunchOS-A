import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { CreateProviderAccountDto } from './dto/create-provider-account.dto';
import { ProviderAccountsService } from './provider-accounts.service';

class VerifyDnsDto {
  @IsString()
  @MinLength(3)
  @MaxLength(253)
  rootDomain!: string;
}

class UpdateAliyunCredentialsDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  accessKey?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  secretKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  region?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;
}

@Controller()
@UseGuards(JwtAuthGuard)
export class ProviderAccountsController {
  constructor(private readonly providerAccountsService: ProviderAccountsService) {}

  @Post('provider-accounts')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateProviderAccountDto) {
    return this.providerAccountsService.create(user.id, dto);
  }

  @Get('provider-accounts')
  list(@CurrentUser() user: AuthUser) {
    return this.providerAccountsService.list(user.id);
  }

  @Get('providers/aliyun/readiness')
  aliyunReadiness(@CurrentUser() user: AuthUser) {
    return this.providerAccountsService.getAliyunReadiness(user.id);
  }

  @Get('provider-accounts/:id/capabilities')
  capabilities(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.providerAccountsService.getCapabilities(user.id, id);
  }

  @Patch('provider-accounts/:id')
  updateCredentials(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: UpdateAliyunCredentialsDto,
  ) {
    return this.providerAccountsService.updateAliyunCredentials(user.id, id, body);
  }

  @Post('provider-accounts/:id/verify-dns')
  verifyDns(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: VerifyDnsDto,
  ) {
    return this.providerAccountsService.verifyDnsConnection(user.id, id, body.rootDomain);
  }
}
