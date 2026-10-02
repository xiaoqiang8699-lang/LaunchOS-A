import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { AccountController } from './account.controller';
import { BillingSubscriptionController } from './billing-subscription.controller';
import { AccountService } from './account.service';

@Module({
  imports: [AuthModule, BillingModule, WorkspacesModule, AnalyticsModule],
  controllers: [AccountController, BillingSubscriptionController],
  providers: [AccountService],
})
export class AccountModule {}
