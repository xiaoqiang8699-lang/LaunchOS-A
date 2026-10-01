import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { AccountService } from './account.service';

@Controller('account')
@UseGuards(JwtAuthGuard)
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @Get()
  profile(@CurrentUser() user: AuthUser) {
    return this.account.profile(user.id);
  }

  @Patch()
  updateProfile(@CurrentUser() user: AuthUser, @Body() body: { name?: string }) {
    return this.account.updateProfile(user.id, body.name ?? '');
  }

  @Get('members')
  members(@CurrentUser() user: AuthUser) {
    return this.account.members(user.id);
  }

  @Post('members')
  invite(@CurrentUser() user: AuthUser, @Body() body: { email?: string; role?: string }) {
    return this.account.invite(user.id, body.email ?? '', body.role ?? 'MEMBER');
  }

  @Patch('members/:userId')
  changeRole(
    @CurrentUser() user: AuthUser,
    @Param('userId') userId: string,
    @Body() body: { role?: string },
  ) {
    return this.account.changeRole(user.id, userId, body.role ?? '');
  }

  @Delete('members/:userId')
  remove(@CurrentUser() user: AuthUser, @Param('userId') userId: string) {
    return this.account.remove(user.id, userId);
  }

  @Get('security')
  security(@CurrentUser() user: AuthUser) {
    return this.account.security(user.id, user.sessionId);
  }

  @Post('password')
  password(@CurrentUser() user: AuthUser, @Body() body: { currentPassword?: string; nextPassword?: string }) {
    return this.account.changePassword(user.id, body.currentPassword ?? '', body.nextPassword ?? '');
  }

  @Post('sessions/revoke-others')
  revokeOthers(@CurrentUser() user: AuthUser) {
    return this.account.revokeOtherSessions(user.id, user.sessionId);
  }

  @Get('subscription')
  subscription(@CurrentUser() user: AuthUser) {
    return this.account.subscription(user.id);
  }

  @Get('entitlements')
  entitlements(@CurrentUser() user: AuthUser) {
    return this.account.entitlements(user.id);
  }

  @Get('usage')
  usage(@CurrentUser() user: AuthUser) {
    return this.account.usage(user.id);
  }

  @Get('subscription/plans')
  plans(@CurrentUser() user: AuthUser) {
    return this.account.planComparison(user.id);
  }

  @Get('subscription/feature-hint')
  featureHint(@CurrentUser() user: AuthUser, @Query('feature') feature = '') {
    return this.account.featureHint(user.id, feature);
  }

  @Post('subscription/upgrade-request')
  upgrade(@CurrentUser() user: AuthUser, @Body() body: { planCode?: string }) {
    return this.account.requestUpgrade(user.id, body.planCode ?? 'pro');
  }

  @Post('subscription/cancel')
  cancelSubscription(@CurrentUser() user: AuthUser) {
    return this.account.scheduleCancel(user.id);
  }

  @Post('subscription/resume')
  resumeSubscription(@CurrentUser() user: AuthUser) {
    return this.account.resumeSubscription(user.id);
  }

  @Post('subscription/trial')
  startTrial(@CurrentUser() user: AuthUser, @Body() body: { planCode?: string; days?: number }) {
    return this.account.startTrial(user.id, body.planCode ?? 'pro', Number(body.days ?? 14));
  }

  @Get('billing')
  billing(@CurrentUser() user: AuthUser) {
    return this.account.billing(user.id);
  }

  @Patch('billing/profile')
  updateBillingProfile(@CurrentUser() user: AuthUser, @Body() body: Record<string, unknown>) {
    return this.account.updateBillingProfile(user.id, body);
  }

  @Post('billing/coupon')
  coupon() {
    return this.account.rejectCoupon();
  }

  @Post('billing')
  changeBilling(@CurrentUser() user: AuthUser) {
    return this.account.changeBilling(user.id);
  }
}
