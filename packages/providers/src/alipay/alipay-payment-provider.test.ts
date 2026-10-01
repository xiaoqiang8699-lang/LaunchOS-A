import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import { AlipayPaymentProvider } from './alipay-payment-provider';
import { buildPagePayUrl, extractSignedObject, type GatewayFetch } from './gateway';
import { alipayNotificationId, parseAlipayNotification, parseAmountCents } from './notify';
import { signAlipayContent, signAlipayParams } from './signature';

function pair() {
  return generateKeyPairSync('rsa', { modulusLength: 2048 });
}

function pem(key: { export: (options: { type: 'pkcs1' | 'pkcs8' | 'spki'; format: 'pem' }) => string | Buffer }, type: 'pkcs1' | 'pkcs8' | 'spki'): string {
  return String(key.export({ type, format: 'pem' }));
}

function notifyParams(input: { privateKey: string; amount?: string; order?: string; status?: string; notifyId?: string; appId?: string }) {
  const params: Record<string, string> = {
    app_id: input.appId ?? 'sandbox-app',
    out_trade_no: input.order ?? 'LOS-20260928-ABCDEF12',
    trade_no: '2026092822001',
    trade_status: input.status ?? 'TRADE_SUCCESS',
    total_amount: input.amount ?? '99.00',
    notify_id: input.notifyId ?? 'notify_sandbox_001',
  };
  return { ...params, sign_type: 'RSA2', sign: signAlipayParams(params, input.privateKey) };
}

describe('alipay provider', () => {
  const app = pair();
  const alipay = pair();
  const config = {
    appId: 'sandbox-app',
    gatewayUrl: 'http://127.0.0.1:9/gateway.do',
    privateKey: pem(app.privateKey, 'pkcs8'),
    alipayPublicKey: pem(alipay.publicKey, 'spki'),
    notifyUrl: 'https://example.com/api/v1/payments/webhooks/alipay',
    returnUrl: 'http://localhost:3000/checkout/return',
  };

  it('verifies official signatures and rejects tampering', () => {
    const params = notifyParams({ privateKey: pem(alipay.privateKey, 'pkcs8') });
    const parsed = parseAlipayNotification(params, config.alipayPublicKey);
    assert.equal(parsed.ok, true);
    const tampered = { ...params, total_amount: '0.01' };
    assert.equal(parseAlipayNotification(tampered, config.alipayPublicKey).ok, false);
  });

  it('keeps a stable idempotency key and maps trade status', () => {
    const params = notifyParams({ privateKey: pem(alipay.privateKey, 'pkcs8') });
    assert.equal(alipayNotificationId(params), alipayNotificationId({ ...params }));
    const success = parseAlipayNotification(params, config.alipayPublicKey);
    assert.equal(success.ok && !success.ignored && success.event.event, 'PAYMENT_SUCCEEDED');
    const closed = notifyParams({ privateKey: pem(alipay.privateKey, 'pkcs8'), status: 'TRADE_CLOSED', notifyId: 'notify_sandbox_002' });
    const canceled = parseAlipayNotification(closed, config.alipayPublicKey);
    assert.equal(canceled.ok && !canceled.ignored && canceled.event.event, 'PAYMENT_CANCELED');
  });

  it('parses provider amounts in cents', () => {
    assert.equal(parseAmountCents('99.00'), 9900);
    assert.equal(parseAmountCents('0.01'), 1);
    assert.equal(parseAmountCents('99.001'), null);
  });

  it('builds checkout from the locked amount', () => {
    const checkout = buildPagePayUrl(config, { merchantOrderNo: 'LOS-20260928-ABCDEF12', amountCents: 9900, subject: 'LaunchOS Pro' });
    const url = new URL(checkout.url);
    const biz = JSON.parse(url.searchParams.get('biz_content') ?? '{}') as { total_amount?: string; out_trade_no?: string };
    assert.equal(biz.total_amount, '99.00');
    assert.equal(biz.out_trade_no, 'LOS-20260928-ABCDEF12');
    assert.equal(url.searchParams.get('method'), 'alipay.trade.page.pay');
  });

  it('does not treat a gateway timeout as payment failure', async () => {
    const fetchImpl: GatewayFetch = async () => {
      throw new Error('timeout');
    };
    const provider = new AlipayPaymentProvider(config, fetchImpl);
    const queried = await provider.getCheckoutStatus('LOS-20260928-ABCDEF12');
    assert.equal(queried.state, 'UNKNOWN_PENDING');
  });

  it('verifies a signed query response and keeps refunds unconfirmed until query', async () => {
    const fetchImpl: GatewayFetch = async (_url, init) => {
      const method = new URLSearchParams(init.body).get('method');
      if (method === 'alipay.trade.query') {
        const content = JSON.stringify({ code: '10000', trade_status: 'TRADE_SUCCESS', out_trade_no: 'LOS-20260928-ABCDEF12', trade_no: 'T1', total_amount: '99.00' });
        return { status: 200, text: JSON.stringify({ alipay_trade_query_response: JSON.parse(content), sign: signAlipayContent(content, pem(alipay.privateKey, 'pkcs8')) }) };
      }
      if (method === 'alipay.trade.refund') {
        const content = JSON.stringify({ code: '10000', fund_change: 'Y' });
        return { status: 200, text: JSON.stringify({ alipay_trade_refund_response: JSON.parse(content), sign: signAlipayContent(content, pem(alipay.privateKey, 'pkcs8')) }) };
      }
      const content = JSON.stringify({ code: '10000', refund_status: 'REFUND_SUCCESS', refund_amount: '99.00' });
      return { status: 200, text: JSON.stringify({ alipay_trade_fastpay_refund_query_response: JSON.parse(content), sign: signAlipayContent(content, pem(alipay.privateKey, 'pkcs8')) }) };
    };
    const provider = new AlipayPaymentProvider(config, fetchImpl);
    const trade = await provider.getCheckoutStatus('LOS-20260928-ABCDEF12');
    assert.equal(trade.state, 'SUCCEEDED');
    if (trade.state === 'SUCCEEDED') assert.equal(trade.amountCents, 9900);
    const refund = await provider.refundPayment({ merchantOrderNo: 'LOS-20260928-ABCDEF12', refundCents: 9900, refundRequestNo: 'RF1' });
    assert.equal(refund.state, 'SUCCEEDED');
    const extracted = extractSignedObject('{"alipay_trade_query_response":{"code":"10000"},"sign":"abc"}', 'alipay_trade_query_response');
    assert.equal(extracted?.content, '{"code":"10000"}');
  });

  it('checks key format and gateway reachability without cross-signing the two keys', async () => {
    const unreachable = new AlipayPaymentProvider(config, async () => {
      throw new Error('down');
    });
    const failed = await unreachable.verifyConfiguration();
    assert.equal(failed.ok, false);
    const reachable = new AlipayPaymentProvider(config, async () => ({ status: 200, text: 'ok' }));
    const passed = await reachable.verifyConfiguration();
    assert.equal(passed.ok, true);
  });
});
