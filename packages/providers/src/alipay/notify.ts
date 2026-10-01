import { createHash } from 'node:crypto';
import { verifyAlipayParams } from './signature';

export type AlipayInternalEvent = 'PAYMENT_SUCCEEDED' | 'PAYMENT_FAILED' | 'PAYMENT_CANCELED' | 'REFUND_SUCCEEDED' | 'REFUND_FAILED';

export type ParsedAlipayNotification = {
  externalEventId: string;
  event: AlipayInternalEvent;
  merchantOrderNo: string;
  providerTradeNo: string | null;
  amountCents: number;
  currency: string;
  appId: string | null;
};

export function parseAmountCents(total: string | undefined): number | null {
  if (!total) return null;
  if (!/^\d+(\.\d{2})?$/.test(total)) return null;
  const [whole, frac = '00'] = total.split('.');
  return Number(whole) * 100 + Number(frac);
}

export function mapAlipayTradeStatus(status: string | undefined): AlipayInternalEvent | null {
  if (status === 'TRADE_SUCCESS' || status === 'TRADE_FINISHED') return 'PAYMENT_SUCCEEDED';
  if (status === 'TRADE_CLOSED') return 'PAYMENT_CANCELED';
  return null;
}

export function alipayNotificationId(params: Record<string, string>): string {
  if (params.notify_id && /^[A-Za-z0-9_-]{8,80}$/.test(params.notify_id)) return params.notify_id;
  return createHash('sha256')
    .update([params.out_trade_no ?? '', params.trade_no ?? '', params.trade_status ?? '', params.total_amount ?? '', params.refund_fee ?? ''].join('|'))
    .digest('hex');
}

export function parseAlipayNotification(
  params: Record<string, string>,
  publicKey: string,
): { ok: true; ignored?: false; event: ParsedAlipayNotification } | { ok: true; ignored: true; externalEventId: string } | { ok: false; code: 'WEBHOOK_SIGNATURE_INVALID' } {
  if (!verifyAlipayParams(params, publicKey)) return { ok: false, code: 'WEBHOOK_SIGNATURE_INVALID' };
  if (params.trade_status === 'WAIT_BUYER_PAY' && !params.refund_fee) {
    return { ok: true, ignored: true, externalEventId: alipayNotificationId(params) };
  }
  const refundEvent = params.refund_fee ? (params.refund_status === 'REFUND_SUCCESS' ? 'REFUND_SUCCEEDED' : 'REFUND_FAILED') : null;
  const event = refundEvent ?? mapAlipayTradeStatus(params.trade_status);
  if (!event || !params.out_trade_no) return { ok: false, code: 'WEBHOOK_SIGNATURE_INVALID' };
  const amountCents = parseAmountCents(params.refund_fee || params.total_amount);
  if (amountCents == null) return { ok: false, code: 'WEBHOOK_SIGNATURE_INVALID' };
  return {
    ok: true,
    event: {
      externalEventId: alipayNotificationId(params),
      event,
      merchantOrderNo: params.out_trade_no,
      providerTradeNo: params.trade_no || null,
      amountCents,
      currency: 'CNY',
      appId: params.app_id || null,
    },
  };
}
