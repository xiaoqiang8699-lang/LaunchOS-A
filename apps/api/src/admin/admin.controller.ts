import { Body, Controller, Delete, Get, NotFoundException, BadRequestException, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
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
import { GrowthAnalyticsService } from '../analytics/growth-analytics.service';
import { LifecycleAutomationService } from '../lifecycle/lifecycle-automation.service';
import {
  AIGrowthService,
  AIUserInsightService,
  DeploymentInsightService,
  UpgradeOpportunityService,
} from '../ai-growth/ai-growth.services';
import { AIDeploymentCopilotService } from '../ai-growth/ai-deployment-copilot.service';
import { AIDeploymentPreflightService } from '../ai-growth/ai-deployment-preflight.service';
import {
  DeploymentKnowledgeService,
  KnowledgeExtractionService,
} from '../ai-growth/deployment-knowledge.service';
import { AIDeploymentSuccessOptimizerService } from '../ai-growth/ai-deployment-success.service';
import { AIProductRecommendationService } from '../ai-growth/ai-product-recommendation.service';
import { AIOnboardingOptimizerService } from '../ai-growth/ai-onboarding-optimizer.service';
import { ActivationBackfillService } from '../ai-growth/activation-backfill.service';
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
    private readonly growth: GrowthAnalyticsService,
    private readonly lifecycle: LifecycleAutomationService,
    private readonly aiGrowth: AIGrowthService,
    private readonly aiUserInsight: AIUserInsightService,
    private readonly deploymentInsight: DeploymentInsightService,
    private readonly upgradeOpportunity: UpgradeOpportunityService,
    private readonly deploymentCopilot: AIDeploymentCopilotService,
    private readonly deploymentPreflight: AIDeploymentPreflightService,
    private readonly deploymentKnowledge: DeploymentKnowledgeService,
    private readonly knowledgeExtraction: KnowledgeExtractionService,
    private readonly successOptimizer: AIDeploymentSuccessOptimizerService,
    private readonly productRecommendations: AIProductRecommendationService,
    private readonly onboardingOptimizer: AIOnboardingOptimizerService,
    private readonly activationBackfill: ActivationBackfillService,
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

  @Get('subscriptions/:id/timeline')
  subscriptionTimeline(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.subscriptionOps.timeline(user.id, id);
  }

  @Post('subscriptions/:id/reconcile')
  subscriptionReconcile(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.subscriptionOps.reconcile(user.id, id);
  }

  @Post('subscriptions/reconcile')
  subscriptionsReconcile(@CurrentUser() user: AuthUser) {
    return this.subscriptionOps.reconcile(user.id);
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

  @Get('deployments/:id/copilot')
  async adminDeploymentCopilot(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.deploymentCopilot.getCopilotAsAdmin(id);
  }

  @Post('deployments/:id/copilot/analyze')
  async adminDeploymentCopilotAnalyze(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.deploymentCopilot.getCopilotAsAdmin(id, { force: true });
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

  @Get('growth/overview')
  async growthOverview(@CurrentUser() user: AuthUser) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.growth.overview();
  }

  @Get('growth/funnel')
  async growthFunnel(@CurrentUser() user: AuthUser) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.growth.funnel();
  }

  @Get('growth/usage')
  async growthUsage(@CurrentUser() user: AuthUser) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.growth.usage();
  }

  @Get('growth/events')
  async growthEvents(@CurrentUser() user: AuthUser, @Query() query: Record<string, string>) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.growth.events(query);
  }

  @Get('growth/commercial')
  async growthCommercial(@CurrentUser() user: AuthUser) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.growth.commercial();
  }

  @Get('users/:id/health')
  async userHealth(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.admin.requirePlatformAdmin(user.id);
    const health = await this.growth.userHealth(id);
    if (!health) {
      throw new NotFoundException('User not found');
    }
    return health;
  }

  @Get('users/:id/lifecycle')
  async userLifecycle(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.admin.requirePlatformAdmin(user.id);
    const lifecycle = await this.lifecycle.userLifecycle(id);
    if (!lifecycle) {
      throw new NotFoundException('User not found');
    }
    return lifecycle;
  }

  @Get('automation')
  async automationOverview(@CurrentUser() user: AuthUser) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.lifecycle.overview();
  }

  @Get('automation/rules')
  async automationRules(@CurrentUser() user: AuthUser) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.lifecycle.listRules();
  }

  @Post('automation/rules')
  async createAutomationRule(
    @CurrentUser() user: AuthUser,
    @Body()
    body: {
      name?: string;
      description?: string;
      triggerEvent?: string;
      conditionJson?: Record<string, unknown>;
      actionType?: 'ADD_TAG' | 'CREATE_ALERT' | 'SHOW_IN_ADMIN';
      actionConfigJson?: Record<string, unknown>;
      status?: 'ACTIVE' | 'DISABLED';
    },
  ) {
    await this.admin.requirePlatformAdmin(user.id);
    if (!body?.name?.trim() || !body?.triggerEvent?.trim() || !body?.actionType) {
      throw new BadRequestException('INVALID_RULE');
    }
    return this.lifecycle.createRule({
      name: body.name.trim(),
      description: body.description,
      triggerEvent: body.triggerEvent.trim(),
      conditionJson: body.conditionJson,
      actionType: body.actionType,
      actionConfigJson: body.actionConfigJson,
      status: body.status,
    });
  }

  @Patch('automation/rules/:id')
  async updateAutomationRule(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body()
    body: Partial<{
      name: string;
      description: string | null;
      triggerEvent: string;
      conditionJson: Record<string, unknown>;
      actionType: 'ADD_TAG' | 'CREATE_ALERT' | 'SHOW_IN_ADMIN';
      actionConfigJson: Record<string, unknown>;
      status: 'ACTIVE' | 'DISABLED';
    }>,
  ) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.lifecycle.updateRule(id, body || {});
  }

  @Post('automation/rules/:id/toggle')
  async toggleAutomationRule(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.admin.requirePlatformAdmin(user.id);
    const row = await this.lifecycle.toggleRule(id);
    if (!row) throw new NotFoundException('Rule not found');
    return row;
  }

  @Post('automation/scan')
  async runAutomationScan(@CurrentUser() user: AuthUser) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.lifecycle.runDailyScan();
  }

  @Get('ai-growth/summary')
  async aiGrowthSummary(@CurrentUser() user: AuthUser) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.aiGrowth.generateDailySummary();
  }

  @Get('ai-growth/issues')
  async aiGrowthIssues(@CurrentUser() user: AuthUser) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.deploymentInsight.analyzeDeploymentFailures();
  }

  @Get('ai-growth/opportunities')
  async aiGrowthOpportunities(@CurrentUser() user: AuthUser) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.upgradeOpportunity.listOpportunities();
  }

  @Get('deployment-insights')
  async deploymentInsights(@CurrentUser() user: AuthUser) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.deploymentCopilot.platformStats(30);
  }

  @Get('ai-growth/deployment-issues')
  async aiGrowthDeploymentIssues(@CurrentUser() user: AuthUser) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.deploymentCopilot.platformStats(30);
  }

  @Get('preflight-insights')
  async preflightInsights(@CurrentUser() user: AuthUser) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.deploymentPreflight.platformStats(30);
  }

  @Get('ai-growth/preflight')
  async aiGrowthPreflight(@CurrentUser() user: AuthUser) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.deploymentPreflight.platformStats(30);
  }

  @Get('deployment-knowledge')
  async adminDeploymentKnowledge(
    @CurrentUser() user: AuthUser,
    @Query('category') category?: string,
    @Query('q') q?: string,
    @Query('status') status?: string,
  ) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.deploymentKnowledge.listAdmin({ category, q, status });
  }

  @Get('ai-growth/knowledge/analytics')
  async aiGrowthKnowledgeAnalytics(@CurrentUser() user: AuthUser) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.deploymentKnowledge.analytics(30);
  }

  @Post('ai-growth/knowledge/scan')
  async scanKnowledge(@CurrentUser() user: AuthUser) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.knowledgeExtraction.scanRecentSuccesses(30);
  }

  @Get('ai-growth/knowledge')
  async aiGrowthKnowledge(
    @CurrentUser() user: AuthUser,
    @Query('category') category?: string,
    @Query('q') q?: string,
    @Query('status') status?: string,
  ) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.deploymentKnowledge.listAdmin({ category, q, status });
  }

  @Post('deployment-knowledge/:id/review')
  async reviewKnowledgeCandidate(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: { decision: 'APPROVED' | 'REJECTED' },
  ) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.deploymentKnowledge.reviewCandidate(user.id, id, body.decision);
  }

  @Get('success-analytics')
  async successAnalytics(@CurrentUser() user: AuthUser) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.successOptimizer.analyzeSuccessRate(30);
  }

  @Get('success-analytics/frameworks')
  async successAnalyticsFrameworks(@CurrentUser() user: AuthUser) {
    await this.admin.requirePlatformAdmin(user.id);
    return {
      frameworks: await this.successOptimizer.frameworkStats(30),
      note: '仅分析，不自动修改产品流程。',
    };
  }

  @Get('success-analytics/recommendations')
  async successAnalyticsRecommendations(@CurrentUser() user: AuthUser) {
    await this.admin.requirePlatformAdmin(user.id);
    return {
      recommendations: await this.productRecommendations.listRecommendations(),
      note: '仅建议，不自动落地。',
    };
  }

  @Get('ai-growth/success')
  async aiGrowthSuccess(@CurrentUser() user: AuthUser) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.successOptimizer.analyzeSuccessRate(30);
  }

  @Post('ai-growth/success/refresh')
  async refreshSuccessAnalytics(@CurrentUser() user: AuthUser) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.successOptimizer.refreshSnapshots(30);
  }

  @Get('onboarding/overview')
  async onboardingOverview(@CurrentUser() user: AuthUser) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.onboardingOptimizer.analyzePlatformOnboarding();
  }

  @Get('onboarding/funnel')
  async onboardingFunnel(@CurrentUser() user: AuthUser) {
    await this.admin.requirePlatformAdmin(user.id);
    const full = await this.onboardingOptimizer.analyzePlatformOnboarding({ backfill: false });
    return { funnel: full.funnel, dropoff: full.dropoff, note: full.note };
  }

  @Get('onboarding/blocked-users')
  async onboardingBlockedUsers(
    @CurrentUser() user: AuthUser,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
    @Query('stage') stage?: string,
    @Query('blocker') blocker?: string,
    @Query('q') q?: string,
  ) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.onboardingOptimizer.listBlockedUsers({
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 20,
      status,
      stage,
      blocker,
      q,
    });
  }

  @Get('onboarding/recommendations')
  async onboardingRecommendations(@CurrentUser() user: AuthUser) {
    await this.admin.requirePlatformAdmin(user.id);
    return {
      recommendations: await this.onboardingOptimizer.listRecommendations(),
      note: '仅建议，管理员可人工标记；AI 不会自动标记为已实施。',
    };
  }

  @Post('onboarding/backfill')
  async onboardingBackfill(@CurrentUser() user: AuthUser) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.activationBackfill.backfillAll(2000);
  }

  @Get('ai-growth/onboarding')
  async aiGrowthOnboarding(@CurrentUser() user: AuthUser) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.onboardingOptimizer.analyzePlatformOnboarding();
  }

  @Get('users/:id/activation')
  async userActivation(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.onboardingOptimizer.analyzeUserActivation(id);
  }

  @Get('users/:id/ai-insight')
  async userAiInsight(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.admin.requirePlatformAdmin(user.id);
    const insight = await this.aiUserInsight.analyzeUser(id);
    if (!insight) throw new NotFoundException('User not found');
    return insight;
  }

  @Get('audit')
  async audit(@CurrentUser() user: AuthUser) {
    await this.admin.requirePlatformAdmin(user.id);
    return this.admin.audit();
  }
}
