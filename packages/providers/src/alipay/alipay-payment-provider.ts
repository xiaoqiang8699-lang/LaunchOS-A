import { buildPagePayUrl, closeAlipayTrade, queryAlipayRefund, queryAlipayTrade, requestAlipayRefund, verifyAlipayConfiguration, type AlipayGatewayConfig, type GatewayFetch } from './gateway';
import { parseAlipayNotification, type ParsedAlipayNotification } from './notify';
import { stringifyParams } from './signature';

export class AlipayPaymentProvider {
  constructor(private readonly config: AlipayGatewayConfig, private readonly fetchImpl?: GatewayFetch) {}

  createCheckout(input: { merchantOrderNo: string; amountCents: number; subject: string }): { checkoutUrl: string; requestId: string } {
    const created = buildPagePayUrl(this.config, input);
    return { checkoutUrl: created.url, requestId: created.requestId };
  }

  async getCheckoutStatus(merchantOrderNo: string) {
    return queryAlipayTrade(this.config, merchantOrderNo, this.fetchImpl);
  }

  createSubscription(input: { merchantOrderNo: string; amountCents: number; subject: string }) {
    return this.createCheckout(input);
  }

  cancelSubscription(): { available: false; message: string } {
    return { available: false, message: '本阶段不通过支付渠道自动取消权益' };
  }

  getInvoice(): { available: false; message: string } {
    return { available: false, message: '账单由 LaunchOS 生成' };
  }

  async refundPayment(input: { merchantOrderNo: string; refundCents: number; refundRequestNo: string }) {
    const requested = await requestAlipayRefund(this.config, input, this.fetchImpl);
    if (requested.state === 'UNKNOWN_PENDING') return requested;
    return queryAlipayRefund(this.config, input, this.fetchImpl);
  }

  verifyWebhook(params: Record<string, unknown>) {
    return parseAlipayNotification(stringifyParams(params), this.config.alipayPublicKey);
  }

  parseWebhookEvent(params: Record<string, unknown>): ParsedAlipayNotification | null {
    const parsed = this.verifyWebhook(params);
    if (!parsed.ok || parsed.ignored) return null;
    return parsed.event;
  }

  verifyConfiguration() {
    return verifyAlipayConfiguration(this.config, this.fetchImpl);
  }

  async closeTrade(merchantOrderNo: string) {
    return closeAlipayTrade(this.config, merchantOrderNo, this.fetchImpl);
  }
}

export type { ParsedAlipayNotification };
