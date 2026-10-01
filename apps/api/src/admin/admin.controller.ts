import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { AdminService } from './admin.service';
import { AdminUsersService } from './admin-users.service';
import { AdminWorkspacesService } from './admin-workspaces.service';
import { SubscriptionEngineService } from '../billing/subscription-engine.service';
import { SubscriptionService } from '../billing/subscription.service';
import { PricingService } from '../billing/pricing.service';
import { CommercialService } from '../billing/commercial.service';
import { EntitlementGovernanceService } from '../billing/entitlement-governance.service';
import { DeleteAdminUserDto } from './dto/delete-admin-user.dto';
import { UpdateAdminUserDto } from './dto/update-admin-user.dto';

@Controller('admin')
@UseGuards(JwtAuthGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly usersAdmin: AdminUsersService,
    private readonly workspacesAdmin: AdminWorkspacesService,
    private readonly billing: SubscriptionEngineService,
    private readonly subscriptionOps: SubscriptionService,
    private readonly pricing: PricingService,
    private readonly commercial: CommercialService,
    private readonly entitlements: EntitlementGovernanceService,
  ) {}

  @Get('overview')
  async overview(@CurrentUser() user: AuthUser) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.admin.overview();
  }

  @Get('users')
  async users(@CurrentUser() user: AuthUser, @Query() query: Record<string, string>) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.usersAdmin.list(user.id, query);
  }

  @Get('users/:id')
  async user(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.usersAdmin.detail(user.id, id);
  }

  @Patch('users/:id')
  async updateUser(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: UpdateAdminUserDto) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.usersAdmin.update(user.id, id, body);
  }

  @Post('users/:id/suspend')
  async suspendUser(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { reason?: string }) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.usersAdmin.suspend(user.id, id, body?.reason);
  }

  @Post('users/:id/restore')
  async restoreUser(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.usersAdmin.restore(user.id, id);
  }

  @Post('users/:id/reset-onboarding')
  async resetOnboarding(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.usersAdmin.resetOnboarding(user.id, id);
  }

  @Post('users/:id/revoke-sessions')
  async revokeSessions(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.usersAdmin.revokeAllSessions(user.id, id);
  }

  @Post('users/:id/archive')
  async archiveUser(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.usersAdmin.archive(user.id, id);
  }

  @Post('users/:id/delete')
  async deleteUser(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: DeleteAdminUserDto) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.usersAdmin.permanentlyDelete(user.id, id, body);
  }

  @Get('workspaces')
  async workspaces(@CurrentUser() user: AuthUser, @Query() query: Record<string, string>) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.workspacesAdmin.list(user.id, query);
  }

  @Get('workspaces/:id')
  async workspace(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.workspacesAdmin.detail(user.id, id);
  }

  @Patch('workspaces/:id')
  async updateWorkspace(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { name?: string; status?: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED'; adminNote?: string; suspendReason?: string }) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.workspacesAdmin.update(user.id, id, body);
  }

  @Post('workspaces/:id/suspend')
  async suspendWorkspace(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { reason?: string }) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.workspacesAdmin.suspend(user.id, id, body?.reason);
  }

  @Post('workspaces/:id/restore')
  async restoreWorkspace(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.workspacesAdmin.restore(user.id, id);
  }

  @Post('workspaces/:id/archive')
  async archiveWorkspace(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.workspacesAdmin.archive(user.id, id);
  }

  @Post('workspaces/:id/delete')
  async deleteWorkspace(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.workspacesAdmin.permanentlyDelete(user.id, id);
  }

  @Post('workspaces/:id/transfer-owner')
  async transferOwner(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { userId?: string }) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.workspacesAdmin.transferOwner(user.id, id, body.userId ?? '');
  }

  @Post('workspaces/:id/members')
  async inviteMember(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { email?: string; role?: string }) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.workspacesAdmin.invite(user.id, id, body.email ?? '', body.role ?? 'MEMBER');
  }

  @Patch('workspaces/:id/members/:userId')
  async changeMember(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('userId') userId: string, @Body() body: { role?: string }) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.workspacesAdmin.changeMemberRole(user.id, id, userId, body.role ?? '');
  }

  @Post('workspaces/:id/members/:userId/remove')
  async removeMember(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('userId') userId: string) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.workspacesAdmin.removeMember(user.id, id, userId);
  }

  @Post('workspaces/:id/plan')
  async overridePlan(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { planCode?: string; reason?: string }) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.workspacesAdmin.overridePlan(user.id, id, body.planCode ?? '', body.reason);
  }

  @Get('workspaces/:id/entitlements')
  async workspaceEntitlements(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.entitlements.resolveEffectiveEntitlements(id);
  }

  @Post('workspaces/:id/entitlement-override')
  async entitlementOverride(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body()
    body: {
      entitlements?: Record<string, unknown>;
      reason?: string;
      expiresAt?: string | null;
      betaTester?: boolean;
    },
  ) {
    await this.admin.requirePlatformAdmin(user.id);
    if (body.betaTester) {
      return this.entitlements.ensureBetaTesterOverride({
        adminId: user.id,
        workspaceId: id,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
      });
    }
    return this.entitlements.upsertEntitlementOverride({
      adminId: user.id,
      workspaceId: id,
      entitlements: (body.entitlements ?? {}) as never,
      reason: body.reason ?? '',
      expiresAt: body.expiresAt,
    });
  }

  @Get('apps')
  async apps(@CurrentUser() user: AuthUser, @Query() query: Record<string, string>) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.workspacesAdmin.listApps(user.id, query);
  }

  @Get('apps/:id')
  async app(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.workspacesAdmin.appDetail(user.id, id);
  }

  @Get('applications')
  async applications(@CurrentUser() user: AuthUser) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.admin.applications();
  }

  @Get('orders')
  orders(@CurrentUser() user: AuthUser) {
    return this.commercial.listOrders(user.id);
  }

  @Post('orders/:id/cancel')
  cancelOrder(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.commercial.cancelOrder(user.id, id);
  }

  @Get('billing')
  adminBilling(@CurrentUser() user: AuthUser) {
    return this.commercial.adminBilling(user.id);
  }

  @Post('invoices/settle')
  settleInvoice(@CurrentUser() user: AuthUser) {
    return this.commercial.refuseSettlement(user.id);
  }

  @Get('upgrade-requests')
  upgradeRequests(@CurrentUser() user: AuthUser) {
    return this.pricing.listRequests(user.id);
  }

  @Post('upgrade-requests/:id/approve')
  approveUpgrade(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.pricing.approve(user.id, id);
  }

  @Post('upgrade-requests/:id/reject')
  rejectUpgrade(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.pricing.reject(user.id, id);
  }

  @Get('subscriptions')
  async subscriptions(@CurrentUser() user: AuthUser, @Query() query: Record<string, string>) {
    return this.billing.listSubscriptions(user.id, query);
  }

  @Post('subscriptions/process')
  async processSubscriptions(@CurrentUser() user: AuthUser) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.subscriptionOps.processDue();
  }

  @Get('subscriptions/:id')
  subscriptionDetail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.subscriptionOps.detail(user.id, id);
  }

  @Post('subscriptions/:id/trial')
  subscriptionTrial(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { planCode?: string; days?: number; reason?: string }) {
    return this.subscriptionOps.startTrial({ actorId: user.id, subscriptionId: id, planCode: body.planCode ?? 'pro', days: Number(body.days ?? 14), reason: body.reason, adminRegrant: true });
  }

  @Post('subscriptions/:id/activate')
  subscriptionActivate(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { planCode?: string; reason?: string }) {
    return this.subscriptionOps.activate({ actorId: user.id, subscriptionId: id, planCode: body.planCode ?? 'pro', reason: body.reason });
  }

  @Post('subscriptions/:id/change-plan')
  subscriptionChangePlan(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { planCode?: string; reason?: string }) {
    return this.subscriptionOps.changePlan({ actorId: user.id, subscriptionId: id, planCode: body.planCode ?? '', reason: body.reason });
  }

  @Post('subscriptions/:id/complimentary')
  subscriptionComplimentary(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { planCode?: string; days?: number; reason?: string }) {
    return this.subscriptionOps.grantComplimentary({ actorId: user.id, subscriptionId: id, planCode: body.planCode ?? 'pro', days: Number(body.days ?? 30), reason: body.reason });
  }

  @Post('subscriptions/:id/extend')
  subscriptionExtend(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { days?: number; reason?: string }) {
    return this.subscriptionOps.extendPeriod({ actorId: user.id, subscriptionId: id, days: Number(body.days ?? 0), reason: body.reason });
  }

  @Post('subscriptions/:id/schedule-cancel')
  subscriptionScheduleCancel(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { reason?: string }) {
    return this.subscriptionOps.scheduleCancellation({ actorId: user.id, subscriptionId: id, reason: body.reason, requireAdminReason: true });
  }

  @Post('subscriptions/:id/cancel-now')
  subscriptionCancelNow(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { confirmation?: string; reason?: string }) {
    return this.subscriptionOps.cancelNow({ actorId: user.id, subscriptionId: id, confirmation: body.confirmation ?? '', reason: body.reason });
  }

  @Post('subscriptions/:id/resume')
  subscriptionResume(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { reason?: string }) {
    return this.subscriptionOps.resume({ actorId: user.id, subscriptionId: id, reason: body.reason, requireAdminReason: true });
  }

  @Post('subscriptions/:id/status')
  async subscriptionStatus(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { status?: string; reason?: string }) {
    return this.billing.simulateStatus(user.id, id, body.status ?? '', body.reason ?? '');
  }

  @Get('plans')
  plans(@CurrentUser() user: AuthUser) {
    return this.billing.listPlans(user.id);
  }

  @Post('plans')
  createPlan(@CurrentUser() user: AuthUser, @Body() body: Record<string, unknown>) {
    return this.billing.createPlan(user.id, body);
  }

  @Patch('plans/:id')
  updatePlan(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.billing.updatePlan(user.id, id, body);
  }

  @Post('plans/:id/disable')
  disablePlan(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.billing.disablePlan(user.id, id);
  }

  @Delete('plans/:id')
  deletePlan(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.billing.deletePlan(user.id, id);
  }

  @Get('invoices')
  async invoices(@CurrentUser() user: AuthUser) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.admin.invoices();
  }

  @Get('runtime')
  async runtime(@CurrentUser() user: AuthUser) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.admin.runtime();
  }

  @Get('system')
  async system(@CurrentUser() user: AuthUser) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.admin.runtime();
  }

  @Get('deployments')
  async deployments(@CurrentUser() user: AuthUser, @Query() query: Record<string, string>) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.admin.listDeployments(query);
  }

  @Get('deployments/:id')
  async deployment(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.admin.getDeployment(id);
  }

  @Get('domains')
  async domains(@CurrentUser() user: AuthUser, @Query() query: Record<string, string>) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.admin.listDomains(query);
  }

  @Get('platform-resources')
  async platformResources(@CurrentUser() user: AuthUser) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.admin.listPlatformResources();
  }

  @Get('audit')
  async audit(@CurrentUser() user: AuthUser) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.admin.audit();
  }
}
