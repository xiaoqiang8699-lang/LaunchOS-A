import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { AIGrowthModule } from '../ai-growth/ai-growth.module';
import { QueueModule } from '../queue/queue.module';
import { CapacityModule } from '../capacity/capacity.module';
import { AdminController } from './admin.controller';
import { AdminPaymentsController, CheckoutController, PaymentsWebhookController } from '../billing/payments.controller';
import { AdminService } from './admin.service';
import { AdminUsersService } from './admin-users.service';
import { AdminWorkspacesService } from './admin-workspaces.service';

@Module({
  imports: [AuthModule, BillingModule, AnalyticsModule, AIGrowthModule, QueueModule, CapacityModule],
  controllers: [AdminController, PaymentsWebhookController, AdminPaymentsController, CheckoutController],
  providers: [AdminService, AdminUsersService, AdminWorkspacesService],
})
export class AdminModule {}
