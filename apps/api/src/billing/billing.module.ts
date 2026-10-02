import { Module } from '@nestjs/common';
import { SubscriptionEngineService } from './subscription-engine.service';
import { SubscriptionService } from './subscription.service';
import { PricingService } from './pricing.service';
import { CommercialService } from './commercial.service';
import { PaymentService } from './payment.service';
import { AlipayPaymentService } from './alipay-payment.service';
import { BillingCheckoutService } from './billing-checkout.service';
import { EntitlementGovernanceService } from './entitlement-governance.service';
import { FormalPaymentReadinessService } from './formal-payment-readiness.service';

@Module({
  controllers: [],
  providers: [
    SubscriptionEngineService,
    SubscriptionService,
    PricingService,
    CommercialService,
    PaymentService,
    AlipayPaymentService,
    BillingCheckoutService,
    EntitlementGovernanceService,
    FormalPaymentReadinessService,
  ],
  exports: [
    SubscriptionEngineService,
    SubscriptionService,
    PricingService,
    CommercialService,
    PaymentService,
    AlipayPaymentService,
    BillingCheckoutService,
    EntitlementGovernanceService,
    FormalPaymentReadinessService,
  ],
})
export class BillingModule {}
