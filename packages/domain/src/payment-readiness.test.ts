import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyRefundDecision,
  canCancelOrder,
  canEditOrderAmounts,
  classifyPaymentRevenue,
  decideVerifiedPayment,
  lockOrderAmount,
  mockPaymentsEnabled,
  nextInvoiceNumber,
  parseProviderEvent,
  safePaymentLog,
  signMockWebhook,
  userPaymentMessage,
  verifyMockWebhook,
} from './payment-readiness';

const now = '2026-09-28T08:00:00.000Z';

test('server recalculates amount and ignores the client', () => {
  const locked = lockOrderAmount({ subscriptionFee: 99, discountAmount: 0, taxAmount: null, currency: 'CNY', clientAmount: 1, clientCurrency: 'USD' });
  assert.equal(locked.totalAmount, 99);
  assert.equal(locked.currency, 'CNY');
  assert.equal(locked.ignoredClientAmount, true);
  assert.equal(canEditOrderAmounts('DRAFT'), true);
  assert.equal(canEditOrderAmounts('PENDING_PAYMENT'), false);
  assert.equal(canCancelOrder('PENDING_PAYMENT'), true);
  assert.equal(canCancelOrder('FULFILLED'), false);
});

test('webhook signature rejects tampering and accepts a valid mock signature', () => {
  const payload = JSON.stringify({ externalEventId: 'evt-1', eventType: 'payment.succeeded', amount: 99 });
  const timestamp = String(Date.parse(now));
  const signature = signMockWebhook(payload, timestamp, 'dev-mock-webhook-secret');
  assert.equal(verifyMockWebhook({ payload, timestamp, signature, secret: 'dev-mock-webhook-secret', now: Date.parse(now) }).ok, true);
  assert.equal(verifyMockWebhook({ payload, timestamp, signature: 'bad', secret: 'dev-mock-webhook-secret', now: Date.parse(now) }).ok, false);
  assert.equal(parseProviderEvent('payment.succeeded'), 'PAYMENT_SUCCEEDED');
  assert.equal(parseProviderEvent('payment.failed'), 'PAYMENT_FAILED');
});

test('success, duplicate, mismatch, currency, expiry, and failed payments stay separated', () => {
  const base = { paymentStatus: 'PENDING', orderStatus: 'PENDING_PAYMENT', orderAmount: 99, orderCurrency: 'CNY', providerAmount: 99, providerCurrency: 'CNY', expiresAt: '2026-10-01T00:00:00.000Z', now, hasSucceededPayment: false };
  assert.equal(decideVerifiedPayment({ ...base, event: 'PAYMENT_SUCCEEDED' }).action, 'succeed');
  assert.equal(decideVerifiedPayment({ ...base, event: 'PAYMENT_SUCCEEDED', hasSucceededPayment: true }).code, 'ORDER_ALREADY_PAID');
  assert.equal(decideVerifiedPayment({ ...base, event: 'PAYMENT_SUCCEEDED', paymentStatus: 'FAILED' }).code, 'LAST_PAYMENT_STATE_INVALID');
  assert.equal(decideVerifiedPayment({ ...base, event: 'PAYMENT_SUCCEEDED', providerAmount: 1 }).code, 'PAYMENT_AMOUNT_MISMATCH');
  assert.equal(decideVerifiedPayment({ ...base, event: 'PAYMENT_SUCCEEDED', providerCurrency: 'USD' }).code, 'PAYMENT_CURRENCY_MISMATCH');
  assert.equal(decideVerifiedPayment({ ...base, event: 'PAYMENT_SUCCEEDED', expiresAt: '2026-09-01T00:00:00.000Z' }).code, 'ORDER_EXPIRED');
  assert.equal(decideVerifiedPayment({ ...base, event: 'PAYMENT_FAILED' }).orderStatus, 'PAYMENT_FAILED');
  assert.equal(userPaymentMessage('PAYMENT_AMOUNT_MISMATCH').includes('PAYMENT_AMOUNT_MISMATCH'), false);
});

test('refunds keep the invoice and do not stop service', () => {
  const full = applyRefundDecision({ paymentStatus: 'SUCCEEDED', paymentAmount: 99, alreadyRefunded: 0, refundAmount: 99, invoiceAmount: 99 });
  assert.equal(full.ok && full.paymentStatus, 'REFUNDED');
  assert.equal(full.ok && full.invoiceAmount, 99);
  assert.equal(full.ok && full.stopsService, false);
  const partial = applyRefundDecision({ paymentStatus: 'SUCCEEDED', paymentAmount: 99, alreadyRefunded: 0, refundAmount: 20, invoiceAmount: 99 });
  assert.equal(partial.ok && partial.paymentStatus, 'PARTIALLY_REFUNDED');
  assert.equal(partial.ok && partial.invoiceAmount, 99);
  assert.equal(applyRefundDecision({ paymentStatus: 'FAILED', paymentAmount: 99, alreadyRefunded: 0, refundAmount: 10, invoiceAmount: 99 }).ok, false);
});

test('mock revenue is separate and logs drop secrets', () => {
  assert.deepEqual(classifyPaymentRevenue({ provider: 'MOCK', isTestPayment: true, paymentStatus: 'SUCCEEDED', orderStatus: 'FULFILLED', amount: 99 }), { bucket: 'test', amount: 99 });
  assert.equal(classifyPaymentRevenue({ provider: 'MOCK', isTestPayment: true, paymentStatus: 'SUCCEEDED', orderStatus: 'PAID', amount: 99 }).bucket, 'none');
  assert.equal(classifyPaymentRevenue({ provider: 'FUTURE', isTestPayment: false, paymentStatus: 'SUCCEEDED', orderStatus: 'FULFILLED', amount: 99 }).bucket, 'real');
  const logged = safePaymentLog({ provider: 'MOCK', eventId: 'evt-1', orderId: 'ord', paymentId: 'pay', status: 'PROCESSED', secret: 'dev-mock-webhook-secret', payload: 'card' });
  assert.equal(logged.secret, undefined);
  assert.equal(logged.provider, 'MOCK');
  assert.equal(nextInvoiceNumber(['INV-202609-000001'], new Date('2026-09-28T00:00:00.000Z')), 'INV-202609-000002');
  assert.equal(mockPaymentsEnabled({ NODE_ENV: 'production' }), false);
  assert.equal(mockPaymentsEnabled({ NODE_ENV: 'development' }), true);
});
