import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { userPaymentMessage } from '@launchos/domain';
import { PaymentService } from './payment.service';
import { AlipayPaymentService } from './alipay-payment.service';
import { BillingCheckoutService } from './billing-checkout.service';
import { FormalPaymentReadinessService } from './formal-payment-readiness.service';

@Controller('payments')
export class PaymentsWebhookController {
  constructor(
    private readonly payments: PaymentService,
    private readonly alipay: AlipayPaymentService,
  ) {}

  @Post('webhooks/:provider')
  @HttpCode(200)
  @UsePipes(new ValidationPipe({ whitelist: false, forbidNonWhitelisted: false, transform: false }))
  async webhook(
    @Param('provider') provider: string,
    @Body() body: Record<string, unknown>,
    @Headers('content-type') contentType = '',
    @Headers('x-launchos-timestamp') timestamp = '',
    @Headers('x-launchos-signature') signature = '',
    @Res({ passthrough: true }) res?: Response,
  ) {
    if (provider === 'alipay') {
      const normalized = normalizeAlipayNotifyBody(body);
      const result = await this.alipay.notification(normalized);
      if (result.httpStatus >= 400) {
        throw new BadRequestException({ code: result.code, message: userPaymentMessage(result.code ?? '') });
      }
      // Alipay requires plain-text "success" (not JSON) to stop retries.
      if (res) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return 'success';
      }
      return 'success';
    }
    void contentType;
    const result = await this.payments.webhook(provider, JSON.stringify(body ?? {}), timestamp, signature);
    if (result.httpStatus >= 400) {
      throw new BadRequestException({ code: result.code, message: userPaymentMessage(result.code ?? '') });
    }
    return { status: result.status, code: result.code ?? null };
  }
}

function normalizeAlipayNotifyBody(body: Record<string, unknown> | string | null | undefined): Record<string, unknown> {
  if (!body) return {};
  if (typeof body === 'string') {
    const params = new URLSearchParams(body);
    const out: Record<string, unknown> = {};
    for (const [key, value] of params.entries()) out[key] = value;
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else if (value == null) continue;
    else out[key] = String(value);
  }
  return out;
}

@Controller('admin')
@UseGuards(JwtAuthGuard)
export class AdminPaymentsController {
  constructor(
    private readonly payments: PaymentService,
    private readonly alipay: AlipayPaymentService,
    private readonly billingCheckout: BillingCheckoutService,
    private readonly formal: FormalPaymentReadinessService,
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

  @Post('payment-providers/alipay/production-test/continue')
  continueProductionTest(@CurrentUser() user: AuthUser, @Body() body: { paymentId?: string }) {
    if (!body?.paymentId) {
      return this.alipay.startProductionTest(user.id);
    }
    return this.alipay.continueProductionTestPayment(user.id, body.paymentId);
  }

  @Post('payment-providers/alipay/production-test/disable')
  disablePaymentTest(@CurrentUser() user: AuthUser) {
    return this.alipay.disablePaymentTest(user.id);
  }

  @Get('commercial/payment-test')
  paymentTestStatus(@CurrentUser() user: AuthUser) {
    return this.billingCheckout.paymentTestStatus(user.id);
  }

  @Get('commercial/payment-controls')
  paymentControls(@CurrentUser() user: AuthUser) {
    return this.formal.paymentControls(user.id);
  }

  @Post('commercial/payment-controls/access')
  updatePaymentAccess(
    @CurrentUser() user: AuthUser,
    @Body() body: { accessMode?: string; percentage?: number; confirmPhrase?: string },
  ) {
    return this.formal.updatePaymentAccess(user.id, body ?? {});
  }

  @Post('commercial/payment-controls/allowlist')
  addAllowlist(@CurrentUser() user: AuthUser, @Body() body: { workspaceId?: string; note?: string }) {
    return this.formal.addAllowlist(user.id, body ?? {});
  }

  @Post('commercial/checkout/dry-run')
  dryRun(
    @CurrentUser() user: AuthUser,
    @Body() body: { workspaceId?: string; planCode?: string; billingCycle?: string },
  ) {
    return this.formal.dryRunCheckout(user.id, body ?? {});
  }

  @Get('commercial/payment-launch-checklist')
  launchChecklist(@CurrentUser() user: AuthUser) {
    return this.formal.launchChecklist(user.id);
  }

  @Get('commercial/payment-consistency')
  consistency(@CurrentUser() user: AuthUser) {
    return this.formal.consistencyAudit(user.id);
  }

  @Post('commercial/mock-activation-matrix')
  mockMatrix(@CurrentUser() user: AuthUser) {
    return this.formal.mockActivateMatrix(user.id);
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
