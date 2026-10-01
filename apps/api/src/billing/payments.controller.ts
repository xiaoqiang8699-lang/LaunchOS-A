import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { userPaymentMessage } from '@launchos/domain';
import { PaymentService } from './payment.service';
import { AlipayPaymentService } from './alipay-payment.service';

@Controller('payments')
export class PaymentsWebhookController {
  constructor(
    private readonly payments: PaymentService,
    private readonly alipay: AlipayPaymentService,
  ) {}

  @Post('webhooks/:provider')
  @HttpCode(200)
  async webhook(
    @Param('provider') provider: string,
    @Body() body: Record<string, unknown>,
    @Headers('x-launchos-timestamp') timestamp = '',
    @Headers('x-launchos-signature') signature = '',
  ) {
    if (provider === 'alipay') {
      const result = await this.alipay.notification(body);
      if (result.httpStatus >= 400) throw new BadRequestException({ code: result.code, message: userPaymentMessage(result.code ?? '') });
      return { status: result.status, code: result.code ?? null };
    }
    const result = await this.payments.webhook(provider, JSON.stringify(body), timestamp, signature);
    if (result.httpStatus >= 400) {
      throw new BadRequestException({ code: result.code, message: userPaymentMessage(result.code ?? '') });
    }
    return { status: result.status, code: result.code ?? null };
  }
}

@Controller('admin')
@UseGuards(JwtAuthGuard)
export class AdminPaymentsController {
  constructor(
    private readonly payments: PaymentService,
    private readonly alipay: AlipayPaymentService,
  ) {}

  @Get('payments/summary')
  summary(@CurrentUser() user: AuthUser) {
    return this.payments.summary(user.id);
  }

  @Get('payments')
  list(@CurrentUser() user: AuthUser, @Query() query: { q?: string; status?: string; page?: string }) {
    return this.payments.list(user.id, query);
  }

  @Get('payments/:id')
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.payments.detail(user.id, id);
  }

  @Post('payments/:id/retry')
  retry(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.payments.retry(user.id, id);
  }

  @Post('payments/:id/retry-webhook')
  retryWebhook(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.payments.retryWebhook(user.id, id);
  }

  @Post('payments/reconcile')
  reconcile(@CurrentUser() user: AuthUser) {
    return this.payments.reconcile(user.id);
  }

  @Post('orders/:id/checkout')
  checkout(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { amount?: number; currency?: string }) {
    return this.payments.checkout(user.id, id, body ?? {});
  }

  @Post('mock-payments/:id/:action')
  mock(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('action') action: string) {
    return this.payments.mockAction(user.id, id, action);
  }

  @Get('payment-providers')
  providers(@CurrentUser() user: AuthUser) {
    return this.alipay.list(user.id);
  }

  @Get('payment-providers/alipay')
  alipayDetail(@CurrentUser() user: AuthUser) {
    return this.alipay.detail(user.id);
  }

  @Post('payment-providers/alipay')
  saveAlipay(@CurrentUser() user: AuthUser, @Body() body: { environment?: 'SANDBOX' | 'PRODUCTION'; displayName?: string; appId?: string; gatewayUrl?: string; notifyUrl?: string; returnUrl?: string; publicKey?: string; privateKey?: string; appReady?: boolean }) {
    return this.alipay.save(user.id, body ?? {});
  }

  @Post('payment-providers/alipay/verify')
  verifyAlipay(@CurrentUser() user: AuthUser, @Body() body: { environment?: 'SANDBOX' | 'PRODUCTION' }) {
    return this.alipay.verify(user.id, body?.environment === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX');
  }

  @Post('payment-providers/alipay/disable')
  disableAlipay(@CurrentUser() user: AuthUser, @Body() body: { environment?: 'SANDBOX' | 'PRODUCTION'; disabled?: boolean }) {
    return this.alipay.setDisabled(user.id, body?.disabled !== false, body?.environment === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX');
  }

  @Post('payment-providers/alipay/production-test')
  startProductionTest(@CurrentUser() user: AuthUser) {
    return this.alipay.startProductionTest(user.id);
  }

  @Post('payment-providers/alipay/production-test/disable')
  disablePaymentTest(@CurrentUser() user: AuthUser) {
    return this.alipay.disablePaymentTest(user.id);
  }

  @Post('payments/:id/refund')
  refund(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { amount?: number }) {
    return this.alipay.refund(user.id, id, body?.amount);
  }

  @Post('payments/:id/close')
  close(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.alipay.close(user.id, id);
  }

  @Post('payments/:id/arm-failure')
  arm(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.alipay.armFailure(user.id, id);
  }
}

@Controller('checkout')
@UseGuards(JwtAuthGuard)
export class CheckoutController {
  constructor(private readonly alipay: AlipayPaymentService) {}

  @Get(':orderId')
  view(@CurrentUser() user: AuthUser, @Param('orderId') orderId: string) {
    return this.alipay.orderView(user.id, orderId);
  }

  @Get(':orderId/status')
  status(@CurrentUser() user: AuthUser, @Param('orderId') orderId: string) {
    return this.alipay.orderView(user.id, orderId);
  }

  @Post(':orderId/alipay')
  pay(@CurrentUser() user: AuthUser, @Param('orderId') orderId: string, @Body() body: { amount?: number; environment?: 'SANDBOX' | 'PRODUCTION' }) {
    return this.alipay.checkout(user.id, orderId, body ?? {});
  }
}
