import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decideAlipayCheckout,
  normalizeBillingCycle,
  readAlipayGates,
  resolveCatalogPriceCents,
} from './alipay-readiness';

describe('M8-1 billing checkout foundation', () => {
  it('locks formal catalog prices in fen', () => {
    assert.deepEqual(
      [
        resolveCatalogPriceCents({ planCode: 'pro', billingCycle: 'MONTHLY', priceMonthly: 99 }),
        resolveCatalogPriceCents({ planCode: 'pro', billingCycle: 'YEARLY', priceYearly: 990 }),
        resolveCatalogPriceCents({ planCode: 'team', billingCycle: 'MONTHLY', priceMonthly: 299 }),
        resolveCatalogPriceCents({ planCode: 'team', billingCycle: 'YEARLY', priceYearly: 2990 }),
        resolveCatalogPriceCents({ planCode: 'PAYMENT_TEST', billingCycle: 'ONE_TIME_TEST' }),
      ].map((row) => (row.ok ? row.amountCents : null)),
      [9900, 99000, 29900, 299000, 90],
    );
  });

  it('normalizes billingCycle and rejects junk', () => {
    assert.equal(normalizeBillingCycle('monthly'), 'MONTHLY');
    assert.equal(normalizeBillingCycle('YEARLY'), 'YEARLY');
    assert.equal(normalizeBillingCycle('ONE_TIME_TEST'), 'ONE_TIME_TEST');
    assert.equal(normalizeBillingCycle('weekly'), null);
  });

  it('keeps both feature gates off by default and isolates PAYMENT_TEST', () => {
    const gates = readAlipayGates({});
    assert.equal(gates.realPaymentsEnabled, false);
    assert.equal(gates.paymentTestRealEnabled, false);
    const testOnly = readAlipayGates({
      PAYMENT_TEST_REAL_ENABLED: 'true',
      REAL_PAYMENTS_ENABLED: 'false',
      ALIPAY_SANDBOX_ONLY: 'false',
    });
    const productionTest = decideAlipayCheckout({
      actorIsPlatformAdmin: true,
      environment: 'PRODUCTION',
      providerStatus: 'VERIFIED',
      gates: testOnly,
      productionTest: {
        workspaceId: 'ws',
        allowedWorkspaceId: 'ws',
        planCode: 'PAYMENT_TEST',
        planStatus: 'INTERNAL_TEST',
        priceMonthlyCents: 90,
      },
    });
    assert.equal(productionTest.ok, true);
    const real = decideAlipayCheckout({
      actorIsPlatformAdmin: false,
      environment: 'PRODUCTION',
      providerStatus: 'VERIFIED',
      gates: testOnly,
      realCatalogPurchase: true,
    });
    assert.equal(real.ok, false);
  });
});
