import { randomBytes } from 'node:crypto';
import { signAlipayParams, verifyAlipayContent, privateKeyCanSign, publicKeyParses } from './signature';
import { parseAmountCents, mapAlipayTradeStatus } from './notify';

export type GatewayFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{ status: number; text: string }>;

export type AlipayGatewayConfig = {
  appId: string;
  gatewayUrl: string;
  privateKey: string;
  alipayPublicKey: string;
  notifyUrl: string;
  returnUrl: string;
};

export type NormalizedTrade = {
  state: 'SUCCEEDED' | 'FAILED' | 'CANCELED' | 'PENDING';
  amountCents: number;
  currency: string;
  providerTradeNo: string | null;
  appId: string | null;
  merchantOrderNo: string | null;
};

const defaultFetch: GatewayFetch = async (url, init) => {
  const response = await fetch(url, { method: init.method, headers: init.headers, body: init.method === 'GET' ? undefined : init.body, signal: init.signal });
  return { status: response.status, text: await response.text() };
};

function timestamp(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function signedParams(config: AlipayGatewayConfig, method: string, biz: Record<string, unknown>, extra: Record<string, string> = {}): Record<string, string> {
  const params: Record<string, string> = {
    app_id: config.appId,
    method,
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: timestamp(),
    version: '1.0',
    notify_url: config.notifyUrl,
    ...extra,
    biz_content: JSON.stringify(biz),
  };
  return { ...params, sign: signAlipayParams(params, config.privateKey) };
}

export function extractSignedObject(payload: string, key: string): { content: string; value: Record<string, unknown>; sign: string } | null {
  const signMatch = payload.match(/"sign"\s*:\s*"([^"]+)"/);
  const marker = `"${key}"`;
  const start = payload.indexOf(marker);
  if (!signMatch?.[1] || start < 0) return null;
  const brace = payload.indexOf('{', start);
  if (brace < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = brace; index < payload.length; index += 1) {
    const char = payload[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const content = payload.slice(brace, index + 1);
        try {
          return { content, value: JSON.parse(content) as Record<string, unknown>, sign: signMatch[1] };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

async function postMethod(config: AlipayGatewayConfig, method: string, responseKey: string, biz: Record<string, unknown>, fetchImpl: GatewayFetch, timeoutMs: number): Promise<{ value: Record<string, unknown> } | { state: 'UNKNOWN_PENDING' }> {
  const params = signedParams(config, method, biz);
  const body = new URLSearchParams(params).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(config.gatewayUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
    const extracted = extractSignedObject(response.text, responseKey);
    if (!extracted || !verifyAlipayContent(extracted.content, extracted.sign, config.alipayPublicKey)) return { state: 'UNKNOWN_PENDING' };
    return { value: extracted.value };
  } catch {
    return { state: 'UNKNOWN_PENDING' };
  } finally {
    clearTimeout(timer);
  }
}

function readTrade(value: Record<string, unknown>): NormalizedTrade | { state: 'UNKNOWN_PENDING' } {
  const status = typeof value.trade_status === 'string' ? value.trade_status : '';
  const mapped = mapAlipayTradeStatus(status);
  const amountCents = parseAmountCents(typeof value.total_amount === 'string' ? value.total_amount : undefined);
  if (!mapped || amountCents == null) {
    if (status === 'WAIT_BUYER_PAY' && amountCents != null) {
      return {
        state: 'PENDING',
        amountCents,
        currency: 'CNY',
        providerTradeNo: typeof value.trade_no === 'string' ? value.trade_no : null,
        appId: null,
        merchantOrderNo: typeof value.out_trade_no === 'string' ? value.out_trade_no : null,
      };
    }
    return { state: 'UNKNOWN_PENDING' };
  }
  return {
    state: mapped === 'PAYMENT_SUCCEEDED' ? 'SUCCEEDED' : mapped === 'PAYMENT_CANCELED' ? 'CANCELED' : 'FAILED',
    amountCents,
    currency: 'CNY',
    providerTradeNo: typeof value.trade_no === 'string' ? value.trade_no : null,
    appId: null,
    merchantOrderNo: typeof value.out_trade_no === 'string' ? value.out_trade_no : null,
  };
}

export function buildPagePayUrl(config: AlipayGatewayConfig, input: { merchantOrderNo: string; amountCents: number; subject: string }): { url: string; requestId: string } {
  const requestId = `req_${randomBytes(8).toString('hex')}`;
  const params = signedParams(config, 'alipay.trade.page.pay', {
    out_trade_no: input.merchantOrderNo,
    total_amount: (input.amountCents / 100).toFixed(2),
    subject: input.subject,
    product_code: 'FAST_INSTANT_TRADE_PAY',
  }, { return_url: config.returnUrl });
  return { url: `${config.gatewayUrl}?${new URLSearchParams(params).toString()}`, requestId };
}

export async function queryAlipayTrade(config: AlipayGatewayConfig, merchantOrderNo: string, fetchImpl: GatewayFetch = defaultFetch, timeoutMs = 8000): Promise<NormalizedTrade | { state: 'UNKNOWN_PENDING' }> {
  const result = await postMethod(config, 'alipay.trade.query', 'alipay_trade_query_response', { out_trade_no: merchantOrderNo }, fetchImpl, timeoutMs);
  if ('state' in result) return result;
  return readTrade(result.value);
}

export async function requestAlipayRefund(config: AlipayGatewayConfig, input: { merchantOrderNo: string; refundCents: number; refundRequestNo: string }, fetchImpl: GatewayFetch = defaultFetch, timeoutMs = 8000): Promise<{ state: 'PENDING' | 'UNKNOWN_PENDING' }> {
  const result = await postMethod(config, 'alipay.trade.refund', 'alipay_trade_refund_response', {
    out_trade_no: input.merchantOrderNo,
    refund_amount: (input.refundCents / 100).toFixed(2),
    out_request_no: input.refundRequestNo,
  }, fetchImpl, timeoutMs);
  if ('state' in result) return { state: 'UNKNOWN_PENDING' };
  return { state: 'PENDING' };
}

export async function queryAlipayRefund(config: AlipayGatewayConfig, input: { merchantOrderNo: string; refundRequestNo: string }, fetchImpl: GatewayFetch = defaultFetch, timeoutMs = 8000): Promise<{ state: 'SUCCEEDED' | 'FAILED' | 'PENDING' | 'UNKNOWN_PENDING'; amountCents: number | null }> {
  const result = await postMethod(config, 'alipay.trade.fastpay.refund.query', 'alipay_trade_fastpay_refund_query_response', {
    out_trade_no: input.merchantOrderNo,
    out_request_no: input.refundRequestNo,
  }, fetchImpl, timeoutMs);
  if ('state' in result) return { state: 'UNKNOWN_PENDING', amountCents: null };
  const status = result.value.refund_status;
  const amountCents = parseAmountCents(typeof result.value.refund_amount === 'string' ? result.value.refund_amount : undefined);
  if (status === 'REFUND_SUCCESS') return { state: 'SUCCEEDED', amountCents };
  if (status === 'REFUND_FAIL' || status === 'REFUND_FAILED') return { state: 'FAILED', amountCents };
  return { state: 'PENDING', amountCents };
}

export async function closeAlipayTrade(config: AlipayGatewayConfig, merchantOrderNo: string, fetchImpl: GatewayFetch = defaultFetch, timeoutMs = 8000): Promise<{ state: 'CLOSED' | 'UNKNOWN_PENDING' }> {
  const result = await postMethod(config, 'alipay.trade.close', 'alipay_trade_close_response', { out_trade_no: merchantOrderNo }, fetchImpl, timeoutMs);
  if ('state' in result) return { state: 'UNKNOWN_PENDING' };
  return result.value.code === '10000' ? { state: 'CLOSED' } : { state: 'UNKNOWN_PENDING' };
}

export async function verifyAlipayConfiguration(config: AlipayGatewayConfig, fetchImpl: GatewayFetch = defaultFetch): Promise<{ ok: true } | { ok: false; code: 'KEY_INVALID' | 'PUBLIC_KEY_INVALID' | 'GATEWAY_UNREACHABLE' }> {
  if (!privateKeyCanSign(config.privateKey)) return { ok: false, code: 'KEY_INVALID' };
  if (!publicKeyParses(config.alipayPublicKey)) return { ok: false, code: 'PUBLIC_KEY_INVALID' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetchImpl(config.gatewayUrl, { method: 'GET', headers: {}, signal: controller.signal });
    if (response.status >= 500) return { ok: false, code: 'GATEWAY_UNREACHABLE' };
    return { ok: true };
  } catch {
    return { ok: false, code: 'GATEWAY_UNREACHABLE' };
  } finally {
    clearTimeout(timer);
  }
}
