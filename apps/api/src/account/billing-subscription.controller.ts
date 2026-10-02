import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { AccountService } from './account.service';
import { BillingCheckoutService } from '../billing/billing-checkout.service';
import { FormalPaymentReadinessService } from '../billing/formal-payment-readiness.service';

/** UX-4 aliases: GET/POST /billing/subscription* + M8-1 POST /billing/checkout + M8-3 preview/confirm */
@Controller('billing')
@UseGuards(JwtAuthGuard)
export class BillingSubscriptionController {
  constructor(
    private readonly account: AccountService,
    private readonly checkout: BillingCheckoutService,
    private readonly formal: FormalPaymentReadinessService,
  ) {}

  @Get('subscription')
  subscription(@CurrentUser() user: AuthUser) {
    return this.account.subscription(user.id);
  }

  @Post('subscription/change-plan')
  changePlan(@CurrentUser() user: AuthUser, @Body() body: { plan?: string; planCode?: string }) {
    return this.account.changePlan(user.id, body.plan ?? body.planCode ?? '');
  }

  @Post('subscription/cancel')
  cancel(@CurrentUser() user: AuthUser) {
    return this.account.scheduleCancel(user.id);
  }

  @Post('subscription/resume')
  resume(@CurrentUser() user: AuthUser) {
    return this.account.resumeSubscription(user.id);
  }

  @Post('checkout/preview')
  checkoutPreview(
    @CurrentUser() user: AuthUser,
    @Body() body: { planCode?: string; billingCycle?: string },
  ) {
    return this.formal.preview(user.id, body ?? {});
  }

  @Post('checkout/confirm')
  checkoutConfirm(
    @CurrentUser() user: AuthUser,
    @Body() body: { planCode?: string; billingCycle?: string; acceptTerms?: boolean },
  ) {
    return this.formal.createPurchaseIntent(user.id, body ?? {});
  }

  @Post('checkout')
  createCheckout(
    @CurrentUser() user: AuthUser,
    @Body()
    body: {
      planCode?: string;
      billingCycle?: string;
      amount?: number;
      amountFen?: number;
      amountCents?: number;
      purchaseIntentId?: string;
    },
  ) {
    return this.checkout.checkout(user.id, body ?? {});
  }
}
