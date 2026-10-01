import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { QueueModule } from '../queue/queue.module';
import { CapacityModule } from '../capacity/capacity.module';
import { AdminController } from './admin.controller';
import { AdminPaymentsController, CheckoutController, PaymentsWebhookController } from '../billing/payments.controller';
import { AdminService } from './admin.service';
import { AdminUsersService } from './admin-users.service';
import { AdminWorkspacesService } from './admin-workspaces.service';

@Module({
  imports: [AuthModule, BillingModule, QueueModule, CapacityModule],
  controllers: [AdminController, PaymentsWebhookController, AdminPaymentsController, CheckoutController],
  providers: [AdminService, AdminUsersService, AdminWorkspacesService],
})
export class AdminModule {}
