import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ALIPAY_PRODUCTION_GATEWAY,
  ALIPAY_SANDBOX_GATEWAY,
  assessAlipayProductionReadiness,
  assertGatewayEnvironment,
  buildMerchantOrderNo,
  canProcessExistingAlipayPayment,
  decideAlipayCheckout,
  fulfillmentCopy,
  fulfillmentSourceForPayment,
  providerAmountMatches,
  providerTimeoutState,
  readAlipayGates,
  resolveCatalogPriceCents,
  returnUrlIsNotPaymentFact,
  subscriptionChargeCents,
  userPaymentWaitCopy,
  alipayRevenueBucket,
} from './alipay-readiness';

const verified = { actorIsPlatformAdmin: true, environment: 'SANDBOX' as const, providerStatus: 'VERIFIED', gates: readAlipayGates({}) };

describe('alipay readiness', () => {
  it('keeps providers separate and production gates closed by default', () => {
    const gates = readAlipayGates({});
    assert.equal(gates.realPaymentsEnabled, false);
    assert.equal(gates.alipayProductionEnabled, false);
    assert.equal(gates.alipayProductionTestEnabled, false);
    assert.equal(gates.paymentTestRealEnabled, false);
    assert.equal(gates.productionTestWorkspaceId, null);
    assert.equal(gates.sandboxOnly, true);
    assert.equal(decideAlipayCheckout({ ...verified, environment: 'PRODUCTION' }).ok, false);
    assert.equal(decideAlipayCheckout({ ...verified, actorIsPlatformAdmin: false }).ok, false);
    assert.equal(decideAlipayCheckout(verified).ok, true);
  });

  it('aliases PAYMENT_TEST_REAL_ENABLED without requiring REAL_PAYMENTS_ENABLED', () => {
    const gates = readAlipayGates({
      PAYMENT_TEST_REAL_ENABLED: 'true',
      REAL_PAYMENTS_ENABLED: 'false',
      ALIPAY_SANDBOX_ONLY: 'false',
    });
    assert.equal(gates.paymentTestRealEnabled, true);
    assert.equal(gates.realPaymentsEnabled, false);
    const testOrder = {
      workspaceId: 'ws-test',
      allowedWorkspaceId: 'ws-test',
      planCode: 'PAYMENT_TEST',
      planStatus: 'INTERNAL_TEST',
      priceMonthlyCents: 90,
    };
    const ok = decideAlipayCheckout({
      actorIsPlatformAdmin: true,
      environment: 'PRODUCTION',
      providerStatus: 'VERIFIED',
      gates,
      productionTest: testOrder,
    });
    assert.equal(ok.ok && ok.isProductionTest, true);
    const realBlocked = decideAlipayCheckout({
      actorIsPlatformAdmin: true,
      environment: 'PRODUCTION',
      providerStatus: 'VERIFIED',
      gates,
      realCatalogPurchase: true,
    });
    assert.equal(realBlocked.ok, false);
  });

  it('isolates sandbox and production gateways', () => {
    assert.equal(assertGatewayEnvironment('SANDBOX', ALIPAY_PRODUCTION_GATEWAY).ok, false);
    assert.equal(assertGatewayEnvironment('PRODUCTION', ALIPAY_SANDBOX_GATEWAY).ok, false);
    assert.equal(assertGatewayEnvironment('SANDBOX', ALIPAY_SANDBOX_GATEWAY).ok, true);
    assert.equal(assertGatewayEnvironment('PRODUCTION', ALIPAY_PRODUCTION_GATEWAY).ok, true);
    assert.equal(assertGatewayEnvironment('SANDBOX', 'http://127.0.0.1:4010/gateway.do').ok, true);
  });

  it('charges only the locked subscription amount and ignores the client', () => {
    const charge = subscriptionChargeCents({ subscriptionFee: 99, discountAmount: 0, taxAmount: null, cloudCostEstimate: 20, clientAmount: 0.01 });
    assert.equal(charge.cents, 9900);
    assert.equal(charge.includesCloudCost, false);
    assert.equal(charge.ignoredClientAmount, true);
    assert.equal(providerAmountMatches(99, 9900), true);
    assert.equal(providerAmountMatches(99, 1), false);
    assert.equal(providerAmountMatches(0, 90, 90), true);
    assert.equal(providerAmountMatches(0, 1, 90), false);
    const proMonthly = resolveCatalogPriceCents({ planCode: 'pro', billingCycle: 'MONTHLY', priceMonthly: 99 });
    const proYearly = resolveCatalogPriceCents({ planCode: 'pro', billingCycle: 'YEARLY', priceYearly: 990 });
    const teamMonthly = resolveCatalogPriceCents({ planCode: 'team', billingCycle: 'MONTHLY', priceMonthly: 299 });
    const teamYearly = resolveCatalogPriceCents({ planCode: 'team', billingCycle: 'YEARLY', priceYearly: 2990 });
    const paymentTest = resolveCatalogPriceCents({ planCode: 'PAYMENT_TEST', billingCycle: 'ONE_TIME_TEST' });
    assert.equal(proMonthly.ok && proMonthly.amountCents, 9900);
    assert.equal(proYearly.ok && proYearly.amountCents, 99000);
    assert.equal(teamMonthly.ok && teamMonthly.amountCents, 29900);
    assert.equal(teamYearly.ok && teamYearly.amountCents, 299000);
    assert.equal(paymentTest.ok && paymentTest.amountCents, 90);
  });

  it('builds a unique merchant order shape and does not trust the return url', () => {
    const first = buildMerchantOrderNo(new Date('2026-09-28T00:00:00Z'), 'abcd1234');
    const second = buildMerchantOrderNo(new Date('2026-09-28T00:00:00Z'), 'abcd1235');
    assert.match(first, /^LOS-20260928-[A-Z0-9]{8}$/);
    assert.notEqual(first, second);
    assert.equal(returnUrlIsNotPaymentFact().trusted, false);
  });

  it('keeps timeout, disable, refund-unrelated fulfillment, and revenue split safe', () => {
    assert.equal(providerTimeoutState().markFailed, false);
    assert.equal(canProcessExistingAlipayPayment('DISABLED'), true);
    assert.equal(decideAlipayCheckout({ ...verified, providerStatus: 'DISABLED' }).ok, false);
    assert.equal(fulfillmentCopy({ paymentStatus: 'SUCCEEDED', orderStatus: 'FULFILLING' }), '支付已成功，服务正在处理中');
    assert.equal(userPaymentWaitCopy({ orderStatus: 'FULFILLED', paymentStatus: 'SUCCEEDED' }), '开通完成');
    assert.equal(fulfillmentSourceForPayment({ provider: 'ALIPAY', environment: 'SANDBOX', isTestPayment: true }).source, 'ALIPAY_SANDBOX');
    assert.equal(alipayRevenueBucket({ isTestPayment: true, paymentStatus: 'SUCCEEDED', orderStatus: 'FULFILLED', amount: 99 }).bucket, 'test');
    assert.equal(alipayRevenueBucket({ isTestPayment: false, paymentStatus: 'SUCCEEDED', orderStatus: 'FULFILLED', amount: 99 }).bucket, 'real');
    assert.equal(alipayRevenueBucket({ isTestPayment: false, isProductionTest: true, paymentStatus: 'SUCCEEDED', orderStatus: 'FULFILLED', amount: 0.9 }).bucket, 'none');
    assert.equal(fulfillmentSourceForPayment({ provider: 'ALIPAY', environment: 'PRODUCTION', isTestPayment: false, isProductionTest: true }).source, 'ALIPAY_PRODUCTION_TEST');
    const openGates = {
      realPaymentsEnabled: true,
      alipayProductionEnabled: true,
      alipayProductionTestEnabled: true,
      paymentTestRealEnabled: true,
      sandboxOnly: false,
    };
    const testOrder = {
      workspaceId: 'ws-test',
      allowedWorkspaceId: 'ws-test',
      planCode: 'PAYMENT_TEST',
      planStatus: 'INTERNAL_TEST',
      priceMonthlyCents: 90,
    };
    const productionTest = decideAlipayCheckout({
      actorIsPlatformAdmin: true,
      environment: 'PRODUCTION',
      providerStatus: 'VERIFIED',
      gates: openGates,
      productionTest: testOrder,
    });
    assert.equal(productionTest.ok && productionTest.isProductionTest && !productionTest.isTestPayment, true);
    assert.equal(decideAlipayCheckout({ actorIsPlatformAdmin: true, environment: 'PRODUCTION', providerStatus: 'VERIFIED', gates: openGates }).ok, false);
    assert.equal(
      decideAlipayCheckout({
        actorIsPlatformAdmin: true,
        environment: 'PRODUCTION',
        providerStatus: 'VERIFIED',
        gates: openGates,
        productionTest: { ...testOrder, planCode: 'pro', priceMonthlyCents: null },
      }).ok,
      false,
    );
    assert.equal(
      decideAlipayCheckout({
        actorIsPlatformAdmin: false,
        environment: 'PRODUCTION',
        providerStatus: 'VERIFIED',
        gates: openGates,
        productionTest: testOrder,
      }).ok,
      false,
    );
    assert.equal(
      decideAlipayCheckout({
        actorIsPlatformAdmin: true,
        environment: 'PRODUCTION',
        providerStatus: 'VERIFIED',
        gates: openGates,
        productionTest: { ...testOrder, workspaceId: 'other' },
      }).ok,
      false,
    );
    assert.equal(
      decideAlipayCheckout({
        actorIsPlatformAdmin: true,
        environment: 'PRODUCTION',
        providerStatus: 'VERIFIED',
        gates: { ...openGates, alipayProductionTestEnabled: false, paymentTestRealEnabled: false },
        productionTest: testOrder,
      }).ok,
      false,
    );
    assert.equal(
      decideAlipayCheckout({
        actorIsPlatformAdmin: true,
        environment: 'PRODUCTION',
        providerStatus: 'VERIFIED',
        gates: openGates,
        productionTest: { ...testOrder, planStatus: 'INACTIVE' },
      }).ok,
      false,
    );
    const realOk = decideAlipayCheckout({
      actorIsPlatformAdmin: false,
      environment: 'PRODUCTION',
      providerStatus: 'VERIFIED',
      gates: openGates,
      realCatalogPurchase: true,
    });
    assert.equal(realOk.ok && !realOk.isProductionTest, true);
    const readiness = assessAlipayProductionReadiness({
      appReady: false,
      appId: null,
      gatewayUrl: ALIPAY_SANDBOX_GATEWAY,
      privateKeyConfigured: false,
      publicKeyConfigured: false,
      notifyUrl: 'http://localhost/api/v1/payments/webhooks/alipay',
      signatureVerified: false,
      clockOk: true,
      callbackReachable: false,
    });
    assert.equal(readiness.ready, false);
    assert.ok(readiness.blockers.length >= 5);
  });
});
