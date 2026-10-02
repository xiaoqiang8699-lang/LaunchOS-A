import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FORMAL_PRICES_LOCKED,
  assertPricesMatchLocked,
  buildCheckoutPreview,
  buildFormalPaymentLaunchChecklist,
  canPurchaseFormalPlan,
  decideFormalAlipayCheckout,
  describeAlipaySandboxOnlySemantics,
  formalPathIgnoresSandboxOnlyFlag,
  formalRevenueBucket,
  fulfillmentPendingEventType,
  killSwitchAllowsExistingFinalization,
  killSwitchBlocksNewCheckout,
  lockedFormalPriceFen,
  mockActivationMatrix,
  purchaseIntentIsUsable,
  readAlipayProviderMode,
  serverPriceMatchesLocked,
  accessPolicyAllows,
  workspacePercentageBucket,
} from './formal-payment-readiness.js';
import { decideAlipayCheckout, readAlipayGates } from './alipay-readiness.js';

describe('M8-3 formal prices locked', () => {
  it('locks pro/team fen amounts', () => {
    assert.equal(FORMAL_PRICES_LOCKED.pro.monthlyFen, 9900);
    assert.equal(FORMAL_PRICES_LOCKED.pro.yearlyFen, 99000);
    assert.equal(FORMAL_PRICES_LOCKED.team.monthlyFen, 29900);
    assert.equal(FORMAL_PRICES_LOCKED.team.yearlyFen, 299000);
    const locked = lockedFormalPriceFen('pro', 'MONTHLY');
    assert.equal(locked.ok && locked.ok ? locked.amountFen : -1, 9900);
    assert.equal(serverPriceMatchesLocked('pro', 'MONTHLY', 99, 990), true);
    assert.equal(serverPriceMatchesLocked('team', 'YEARLY', 299, 2990), true);
  });

  it('blocks enterprise checkout price', () => {
    const r = lockedFormalPriceFen('enterprise', 'MONTHLY');
    assert.equal(r.ok, false);
  });
});

describe('M8-3 provider mode vs sandboxOnly', () => {
  it('documents sandboxOnly as legacy business block not provider select', () => {
    const s = describeAlipaySandboxOnlySemantics();
    assert.equal(s.providerModeIndependent, true);
    assert.equal(s.blocksFormalCheckoutViaSandboxOnly, false);
    assert.equal(formalPathIgnoresSandboxOnlyFlag(), true);
  });

  it('Path B ignores sandboxOnly when REAL_PAYMENTS enabled', () => {
    const r = decideAlipayCheckout({
      actorIsPlatformAdmin: false,
      environment: 'PRODUCTION',
      providerStatus: 'VERIFIED',
      gates: {
        realPaymentsEnabled: true,
        alipayProductionEnabled: true,
        alipayProductionTestEnabled: false,
        paymentTestRealEnabled: false,
        sandboxOnly: true,
      },
      realCatalogPurchase: true,
    });
    assert.equal(r.ok, true);
  });

  it('Path B still blocked when REAL_PAYMENTS false even if sandboxOnly false', () => {
    const r = decideAlipayCheckout({
      actorIsPlatformAdmin: false,
      environment: 'PRODUCTION',
      providerStatus: 'VERIFIED',
      gates: {
        realPaymentsEnabled: false,
        alipayProductionEnabled: true,
        alipayProductionTestEnabled: false,
        paymentTestRealEnabled: false,
        sandboxOnly: false,
      },
      realCatalogPurchase: true,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'REAL_PAYMENTS_DISABLED');
  });

  it('provider mode defaults PRODUCTION', () => {
    assert.equal(readAlipayProviderMode({}), 'PRODUCTION');
    assert.equal(readAlipayProviderMode({ ALIPAY_PROVIDER_MODE: 'SANDBOX' }), 'SANDBOX');
  });
});

describe('M8-3 eligibility and access', () => {
  it('disabled access blocks', () => {
    const r = canPurchaseFormalPlan({
      realPaymentsEnabled: true,
      alipayProductionEnabled: true,
      accessMode: 'DISABLED',
      workspaceId: 'ws1',
      allowlisted: true,
      planCode: 'pro',
      billingCycle: 'MONTHLY',
      workspaceStatus: 'ACTIVE',
      providerLiveValidated: true,
    });
    assert.equal(r.eligible, false);
    assert.equal(r.reason, 'PAYMENT_ACCESS_DISABLED');
  });

  it('allowlist member dry-run eligible without gates', () => {
    const r = canPurchaseFormalPlan({
      realPaymentsEnabled: false,
      alipayProductionEnabled: false,
      accessMode: 'DISABLED',
      workspaceId: 'ws1',
      allowlisted: true,
      planCode: 'pro',
      billingCycle: 'MONTHLY',
      workspaceStatus: 'ACTIVE',
      providerLiveValidated: false,
      dryRun: true,
    });
    assert.equal(r.eligible, true);
  });

  it('percentage bucket is stable', () => {
    const a = workspacePercentageBucket('cmunqotx500cbrl013xbhpio2');
    const b = workspacePercentageBucket('cmunqotx500cbrl013xbhpio2');
    assert.equal(a, b);
    const access = accessPolicyAllows({
      mode: 'PERCENTAGE',
      workspaceId: 'cmunqotx500cbrl013xbhpio2',
      allowlisted: false,
      percentage: 0,
    });
    assert.equal(access.allowed, false);
  });
});

describe('M8-3 preview and intent', () => {
  it('builds preview without auto-renew', () => {
    const p = buildCheckoutPreview({
      planCode: 'pro',
      billingCycle: 'MONTHLY',
      currentPlanCode: 'free',
      planName: 'Pro',
      amountFen: 9900,
      workspaceName: 'Demo',
    });
    assert.equal(p.autoRenew, false);
    assert.equal(p.effectiveRule, 'IMMEDIATE');
    assert.match(p.realPaymentWarning, /真实支付宝/);
  });

  it('downgrade rule is period end', () => {
    const p = buildCheckoutPreview({
      planCode: 'pro',
      billingCycle: 'MONTHLY',
      currentPlanCode: 'team',
      planName: 'Pro',
      amountFen: 9900,
      workspaceName: 'Demo',
    });
    assert.equal(p.effectiveRule, 'AT_PERIOD_END');
  });

  it('purchase intent expires', () => {
    const ok = purchaseIntentIsUsable({
      status: 'CONFIRMED',
      expiresAt: new Date(Date.now() - 1000),
      amountFen: 9900,
      planCode: 'pro',
      billingCycle: 'MONTHLY',
    });
    assert.equal(ok.ok, false);
  });

  it('price drift blocked', () => {
    assert.equal(assertPricesMatchLocked({ planCode: 'pro', billingCycle: 'MONTHLY', amountFen: 1 }).ok, false);
  });
});

describe('M8-3 revenue kill switch checklist', () => {
  it('classifies payment test as TEST_PAYMENT', () => {
    assert.equal(
      formalRevenueBucket({ paymentStatus: 'SUCCEEDED', isProductionTest: true, planCode: 'PAYMENT_TEST' }),
      'TEST_PAYMENT',
    );
    assert.equal(
      formalRevenueBucket({
        paymentStatus: 'SUCCEEDED',
        businessType: 'SUBSCRIPTION_PURCHASE',
        planCode: 'pro',
      }),
      'SUBSCRIPTION_REVENUE',
    );
  });

  it('kill switch blocks new but allows finalization', () => {
    assert.equal(killSwitchBlocksNewCheckout(false), true);
    assert.equal(killSwitchAllowsExistingFinalization(), true);
  });

  it('formal checkout requires live validated', () => {
    const r = decideFormalAlipayCheckout({
      realPaymentsEnabled: true,
      alipayProductionEnabled: true,
      providerStatus: 'VERIFIED',
      providerLiveValidated: false,
      accessAllowed: true,
    });
    assert.equal(r.ok, false);
  });

  it('mock matrix covers four SKUs', () => {
    assert.equal(mockActivationMatrix().length, 4);
    assert.equal(fulfillmentPendingEventType(), 'PAYMENT_SUCCEEDED_FULFILLMENT_PENDING');
  });

  it('checklist ready only when all pass; opened always false', () => {
    const ready = buildFormalPaymentLaunchChecklist({
      productionProviderLiveVerified: true,
      pricesLocked: true,
      termsVersionActive: true,
      purchaseConfirmReady: true,
      subscriptionLifecycleReady: true,
      entitlementReady: true,
      billingReady: true,
      adminPaymentsReady: true,
      killSwitchReady: true,
      allowlistReady: true,
      reconciliationReady: true,
      alertsReady: true,
      regressionPass: true,
    });
    assert.equal(ready.formalPaymentLaunchReady, true);
    assert.equal(ready.formalPlanPaymentOpened, false);
  });

  it('gates default closed', () => {
    const g = readAlipayGates({ REAL_PAYMENTS_ENABLED: 'false' });
    assert.equal(g.realPaymentsEnabled, false);
  });
});
