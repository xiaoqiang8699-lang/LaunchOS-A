import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { join } from 'node:path';
import { IsBoolean, IsOptional } from 'class-validator';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { BindDnsProviderDto } from './dto/dns-provider.dto';
import { SystemDomainApiService } from './system-domain.service';

class RenewCertificateDto {
  @IsOptional()
  @IsBoolean()
  force?: boolean;

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

@Controller('system-domain')
@UseGuards(JwtAuthGuard)
export class SystemDomainController {
  constructor(private readonly systemDomain: SystemDomainApiService) {}

  @Get('status')
  status(@CurrentUser() user: AuthUser) {
    return this.systemDomain.getStatus(user.id);
  }

  @Post('verify')
  verify(@CurrentUser() user: AuthUser) {
    return this.systemDomain.verify(user.id);
  }

  @Post('deploy-gateway')
  deployGateway(@CurrentUser() user: AuthUser) {
    const bundled = join(process.cwd(), 'apps/gateway/dist/gateway.cjs');
    const alt = join(process.cwd(), '../../apps/gateway/dist/gateway.cjs');
    return this.systemDomain.deployGateway(user.id, bundled, alt);
  }

  @Post('sync-routes')
  syncRoutes(@CurrentUser() user: AuthUser) {
    return this.systemDomain.syncRoutes(user.id);
  }

  @Get('certificate')
  certificate(@CurrentUser() user: AuthUser) {
    return this.systemDomain.getCertificate(user.id);
  }

  @Post('certificate/renew')
  renewCertificate(@CurrentUser() user: AuthUser, @Body() body: RenewCertificateDto) {
    return this.systemDomain.renewCertificate(user.id, {
      force: body?.force,
      dryRun: body?.dryRun,
    });
  }

  @Get('dns-provider')
  dnsProvider(@CurrentUser() user: AuthUser) {
    return this.systemDomain.getDnsProviderConfig(user.id);
  }

  @Post('dns-provider/bind')
  bindDnsProvider(@CurrentUser() user: AuthUser, @Body() body: BindDnsProviderDto) {
    return this.systemDomain.bindDnsProvider(user.id, body.providerAccountId);
  }

  @Post('dns-provider/verify')
  verifyDnsProvider(@CurrentUser() user: AuthUser) {
    return this.systemDomain.verifyDnsProvider(user.id);
  }

  @Post('dns-provider/txt-test')
  dnsTxtTest(@CurrentUser() user: AuthUser) {
    return this.systemDomain.runDnsTxtTest(user.id);
  }

  @Post('dns-provider/enable-automatic')
  enableAutomaticDns(@CurrentUser() user: AuthUser) {
    return this.systemDomain.enableAutomaticDns(user.id);
  }
}
