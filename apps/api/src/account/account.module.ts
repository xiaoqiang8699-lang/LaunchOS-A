import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';

@Module({
  imports: [AuthModule, BillingModule, WorkspacesModule],
  controllers: [AccountController],
  providers: [AccountService],
})
export class AccountModule {}
