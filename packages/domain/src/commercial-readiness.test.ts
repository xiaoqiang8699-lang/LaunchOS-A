import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeAdminAuditMetadata } from './admin-user-management';
import { unavailablePaymentProvider } from './subscription-usage';
import {
  CLOUD_ESTIMATE_DISCLAIMER,
  COMMERCIAL_NOTIFICATION_TYPES,
  TAX_PENDING_COPY,
  attributeCloudCosts,
  billingProfileAccess,
  buildCheckoutDraft,
  buildInvoiceSnapshot,
  calculateWorkspacePriceBreakdown,
  canCreateRealPayment,
  canWriteInvoiceFacts,
  commercialDocuments,
  estimateWorkspaceCloudCost,
  estimatedCostEnforcement,
  manualActivationMarker,
  presentPriceBreakdown,
  profileIncomplete,
  recognizedMargin,
  rejectCouponEntry,
  unavailableCloudBillingProvider,
  validateBillingProfile,
  assertOrderStaysUnpaid,
} from './commercial-readiness';

test('billing profile allows empty company fields and checks email', () => {
  assert.equal(validateBillingProfile({ companyName: null, taxId: null, billingEmail: 'a@b.co' }).ok, true);
  assert.equal(validateBillingProfile({ billingEmail: 'not-an-email' }).ok, false);
  assert.equal(profileIncomplete({ billingName: '', billingEmail: 'a@b.co' }), true);
});

test('billing RBAC follows workspace role', () => {
  assert.deepEqual(billingProfileAccess('OWNER'), { read: true, edit: true });
  assert.deepEqual(billingProfileAccess('ADMIN'), { read: true, edit: true });
  assert.deepEqual(billingProfileAccess('MEMBER'), { read: true, edit: false });
  assert.deepEqual(billingProfileAccess('VIEWER'), { read: true, edit: false });
  assert.equal(billingProfileAccess('PLATFORM_ADMIN').edit, false);
});

test('cloud cost stays on the owning workspace and skips shared resources', () => {
  const resources = [
    { workspaceId: 'ws', shared: false, resourceType: 'SERVER' as const, resourceId: 's1', amount: 100 },
    { workspaceId: 'other', shared: false, resourceType: 'SERVER' as const, resourceId: 's2', amount: 80 },
    { workspaceId: 'ws', shared: true, resourceType: 'SERVER' as const, resourceId: 'shared', amount: 500 },
  ];
  assert.deepEqual(attributeCloudCosts('ws', resources).map((item) => item.resourceId), ['s1']);
  const estimate = estimateWorkspaceCloudCost('ws', resources);
  assert.equal(estimate.serverCost, 100);
  assert.equal(estimate.totalEstimatedCloudCost, 100);
});

test('missing resource price stays unknown instead of zero', () => {
  const estimate = estimateWorkspaceCloudCost('ws', [
    { workspaceId: 'ws', shared: false, resourceType: 'SERVER', resourceId: 's1', amount: null },
    { workspaceId: 'ws', shared: false, resourceType: 'DATABASE', resourceId: 'd1', amount: 20 },
  ]);
  assert.equal(estimate.serverCost, 'unknown');
  assert.equal(estimate.databaseCost, 20);
  assert.equal(estimate.redisCost, 0);
  assert.equal(estimate.totalEstimatedCloudCost, 'unknown');
});

test('price breakdown keeps tax empty and separates cloud cost', () => {
  const breakdown = calculateWorkspacePriceBreakdown({
    subscriptionFee: 99,
    cloudResourceEstimatedCost: 126,
    discount: 0,
    currency: 'CNY',
  });
  assert.equal(breakdown.taxEstimated, null);
  assert.equal(breakdown.totalEstimated, 225);
  const view = presentPriceBreakdown({
    planName: 'LaunchOS Pro',
    subscriptionFee: 99,
    contactSales: false,
    cloudResourceEstimatedCost: 126,
    discount: 0,
    totalEstimated: 225,
    currency: 'CNY',
  });
  assert.match(view.subscriptionFeeLabel, /99 CNY/);
  assert.match(view.cloudCostLabel, /126 CNY/);
  assert.match(view.totalLabel, /225 CNY/);
  assert.equal(view.taxLabel, TAX_PENDING_COPY);
  assert.match(view.disclaimer, /估算/);
  const unknown = calculateWorkspacePriceBreakdown({ subscriptionFee: 99, cloudResourceEstimatedCost: 'unknown', discount: 0, currency: 'CNY' });
  assert.equal(unknown.totalEstimated, 'unknown');
  assert.match(presentPriceBreakdown({
    planName: 'LaunchOS Pro',
    subscriptionFee: 99,
    contactSales: false,
    cloudResourceEstimatedCost: 'unknown',
    discount: 0,
    totalEstimated: 'unknown',
    currency: 'CNY',
  }).cloudCostLabel, /暂未估算/);
});

test('discount is a placeholder and coupons stay closed', () => {
  assert.equal(rejectCouponEntry().ok, false);
  assert.match(rejectCouponEntry().message, /优惠码/);
});

test('checkout draft is an order, not an invoice or a payment', () => {
  const breakdown = calculateWorkspacePriceBreakdown({ subscriptionFee: 99, cloudResourceEstimatedCost: 126, discount: 0, currency: 'CNY' });
  const draft = buildCheckoutDraft({
    orderNumber: 'LO-1',
    type: 'SUBSCRIPTION_UPGRADE',
    planId: 'pro',
    planVersionId: 'v2',
    billingInterval: 'monthly',
    breakdown,
  });
  assert.equal(draft.status, 'DRAFT');
  assert.equal(draft.payment, null);
  assert.equal(draft.invoice, null);
  assert.equal(draft.totalAmount, 225);
  assert.equal(assertOrderStaysUnpaid('PAID').ok, false);
  assert.deepEqual(commercialDocuments(), ['CommercialOrder', 'Invoice', 'Payment']);
});

test('manual activation does not invent a paid order', () => {
  const marker = manualActivationMarker();
  assert.equal(marker.paymentStatus, 'NOT_APPLICABLE');
  assert.equal(marker.activationSource, 'MANUAL_ADMIN');
  assert.equal(marker.createsPaidOrder, false);
  assert.equal(marker.createsPayment, false);
  assert.equal(canCreateRealPayment(), false);
});

test('margin stays empty without recognized revenue and estimates do not collect', () => {
  assert.equal(recognizedMargin({ recognizedSubscriptionRevenue: null, actualCloudCost: 126 }), null);
  assert.equal(recognizedMargin({ recognizedSubscriptionRevenue: 99, actualCloudCost: null }), null);
  assert.equal(recognizedMargin({ recognizedSubscriptionRevenue: 99, actualCloudCost: 126 }), -27);
  assert.deepEqual(estimatedCostEnforcement(), { suspend: false, pastDue: false, dunning: false, reclaim: false });
});

test('invoice snapshot keeps historical profile and plan terms', () => {
  const profile = { billingName: '甲', billingEmail: 'a@b.co', companyName: null, taxId: null };
  const snapshot = buildInvoiceSnapshot({
    billingProfile: profile,
    planVersion: { id: 'v1', version: 1, priceMonthly: 99, priceYearly: 990, limitsJson: { maxProjects: 5 }, featuresJson: {} },
    subscriptionAmount: 99,
    cloudResourceAmount: 126,
    discountAmount: 0,
    taxAmount: null,
    currency: 'CNY',
  });
  profile.billingName = '乙';
  assert.equal(snapshot.billingProfileSnapshot.billingName, '甲');
  assert.equal(snapshot.planVersionSnapshot.priceMonthly, 99);
  assert.equal(snapshot.totalAmount, 225);
  assert.equal(canWriteInvoiceFacts(null), false);
  assert.equal(canWriteInvoiceFacts('NOT_APPLICABLE'), false);
  assert.equal(canWriteInvoiceFacts('SUCCEEDED'), true);
});

test('payment and cloud bill providers stay unimplemented and copy stays safe', async () => {
  const payment = await unavailablePaymentProvider.refundPayment({ paymentId: 'pay' });
  const status = await unavailablePaymentProvider.getCheckoutStatus({ orderId: 'order' });
  const cloud = await unavailableCloudBillingProvider.fetchWorkspaceCosts({ workspaceId: 'ws' });
  assert.equal(payment.available, false);
  assert.equal(status.available, false);
  assert.match(cloud.message, /尚未接入/);
  assert.equal(COMMERCIAL_NOTIFICATION_TYPES.includes('ORDER_CREATED'), true);
  assert.equal(COMMERCIAL_NOTIFICATION_TYPES.includes('INVOICE_AVAILABLE'), true);
  assert.match(CLOUD_ESTIMATE_DISCLAIMER, /实际云厂商/);
  const safe = sanitizeAdminAuditMetadata({ orderNumber: 'LO-1', password: 'secret', token: 'abc', accessKey: 'AKIA', amount: 99 });
  assert.equal(safe.orderNumber, 'LO-1');
  assert.equal(safe.password, undefined);
  assert.equal(safe.token, undefined);
  assert.equal(safe.accessKey, undefined);
});
