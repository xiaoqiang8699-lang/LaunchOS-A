import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { BillingModule } from '../billing/billing.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { DomainsController } from './domains.controller';
import { DomainsService } from './domains.service';

@Module({
  imports: [AuthModule, WorkspacesModule, BillingModule, AnalyticsModule],
  controllers: [DomainsController],
  providers: [DomainsService],
})
export class DomainsModule {}
