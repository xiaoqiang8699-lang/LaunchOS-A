import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  STEP30_PHASE2_WRITE_COMMANDS,
  STEP30_PHASE2_REAL_EXECUTION_LOCKED,
  STEP30_REAL_EXECUTION_LOCKED,
  assertLaunchEventSafe,
  buildLaunchPlan,
  buildConfirmationPayload,
  createConfirmationRecord,
  computeLaunchProgress,
  defaultLaunchHandlerRegistry,
  detectPlanStale,
  evaluateCancelPolicy,
  evaluateLaunchGate,
  evaluateProductBillingGate,
  evaluateProductPlanFreshness,
  assertAccountCanUseProduct,
  assertAlphaApplicationScope,
  assertPhase3VerifyOnlyPlan,
  canRoleExecuteLaunch,
  duplicateLaunchMessage,
  executeLaunchRun,
  isExternalAlphaManagedWriteEligible,
  launchErrorUserMessage,
  launchProjectLockKey,
  planResumeStep,
  presentDeploymentFailure,
  extractNestFailurePayload,
  reconcileRunningSteps,
  shouldSoftConfirmPlatformManagedLaunch,
  verifyPublicHttps,
  verifyPublicEntryWithRetry,
  type BuildLaunchPlanInput,
  type DeclaredWorldState,
  type ExecuteLaunchRunInput,
  type LaunchPlanResult,
  type LaunchRunPersistence,
  type LaunchUnitInput,
  type ObservedFacts,
  LAUNCH_PLAN_VERSION,
} from '@launchos/domain';
import {
  LaunchRunStatus,
  LaunchStepDecision,
  LaunchStepStatus,
  LaunchTriggerType,
  Prisma,
  type LaunchStage,
} from '@launchos/database';
import { PrismaService } from '../database/prisma.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import { DependenciesService } from '../dependencies/dependencies.service';
import { AlphaTestsService } from '../alpha-tests/alpha-tests.service';
import { SubscriptionEngineService } from '../billing/subscription-engine.service';
import { EntitlementGovernanceService } from '../billing/entitlement-governance.service';
import { EnvironmentsService } from '../environments/environments.service';
import { ManagedHostingSchedulerService } from '../managed-hosting/managed-hosting-scheduler.service';
import { DeploymentsService } from '../deployments/deployments.service';

const productLaunchLocks = new Set<string>();

/** Phase 2 confirmation columns (Prisma generate may be locked on Windows DLL). */
type LaunchRunConfirmFields = {
  confirmationId: string | null;
  confirmedAt: Date | null;
  confirmedByUserId: string | null;
  confirmedPlanHash: string | null;
  confirmationSnapshot: unknown;
};

function withConfirm<T extends object>(run: T): T & LaunchRunConfirmFields {
  return run as T & LaunchRunConfirmFields;
}

@Injectable()
export class LaunchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaceAccess: WorkspaceAccessService,
    private readonly dependencies: DependenciesService,
    private readonly alphaTests: AlphaTestsService,
    private readonly billing: SubscriptionEngineService,
    private readonly entitlements: EntitlementGovernanceService,
    private readonly environments: EnvironmentsService,
    private readonly managedHosting: ManagedHostingSchedulerService,
    private readonly deployments: DeploymentsService,
  ) {}

  /** POST /projects/:id/launch/plan — generate plan only (no cloud writes). */
  async createPlan(userId: string, projectId: string, body?: { environmentId?: string }) {
    await this.assertAccountCanLaunch(userId);
    const { membership, project } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    await this.workspaceAccess.assertWorkspaceMutable(project.workspaceId);
    if (!membership) throw new ForbiddenException('无权访问该应用');

    const environment = await this.resolveEnvironment(projectId, body?.environmentId);
    await this.assertNoActiveLaunch(projectId, environment.id);

    const world = await this.loadWorldState(userId, projectId, environment.id);
    const plan = buildLaunchPlan(world.planInput);
    const platformManagedAllocated =
      Boolean(world.planInput.declared.server?.id) &&
      (await this.prisma.serverInstance.findFirst({
        where: {
          id: world.planInput.declared.server!.id!,
          scope: 'PLATFORM_MANAGED',
        },
        select: { id: true },
      }));
    const softConfirm = shouldSoftConfirmPlatformManagedLaunch({
      serverReady: plan.serverReady,
      billableCount: plan.billableActions.length,
      resourcesToCreateCount: plan.resourcesToCreate.length,
      currentDesiredStateSatisfied: plan.currentDesiredStateSatisfied,
      platformManagedAllocated: Boolean(platformManagedAllocated),
    });
    const effectiveRequiresConfirmation = plan.requiresConfirmation || softConfirm;
    const effectiveCanLaunch =
      plan.blockers.length === 0 && plan.serverReady && world.planInput.units.length > 0;
    const priorLaunch = await this.prisma.launchRun.findFirst({
      where: {
        projectId,
        environmentId: environment.id,
        status: {
          in: [
            LaunchRunStatus.SUCCESS,
            LaunchRunStatus.FAILED,
            LaunchRunStatus.RUNNING,
            LaunchRunStatus.VERIFYING,
          ],
        },
      },
      orderBy: { createdAt: 'desc' },
      select: { status: true },
    });
    const activeRoutes = await this.prisma.gatewayRoute.findMany({
      where: { projectId, status: 'ACTIVE' },
      select: { hostname: true },
    });
    const publicHost =
      activeRoutes.find((route) => route.hostname.startsWith('oneclick-'))?.hostname ??
      activeRoutes.find((route) => !route.hostname.startsWith('api-'))?.hostname ??
      null;

    const runStatus =
      effectiveRequiresConfirmation
        ? LaunchRunStatus.WAITING_CONFIRMATION
        : plan.suggestedRunStatus === 'WAITING_CONFIRMATION'
          ? LaunchRunStatus.WAITING_CONFIRMATION
          : LaunchRunStatus.READY;

    const planSnapshot = {
      ...this.toPlanSnapshot(plan),
      requiresConfirmation: effectiveRequiresConfirmation,
      canLaunch: effectiveCanLaunch,
      platformManagedRuntime: Boolean(platformManagedAllocated),
      platformManagedLabelZh: platformManagedAllocated
        ? '使用 LaunchOS 测试运行资源'
        : null,
    };

    const stepCreates = plan.steps.map((s) => ({
      stage: s.stage as LaunchStage,
      stepType: s.stepType,
      status:
        s.decision === 'SKIP' || s.decision === 'REUSE'
          ? LaunchStepStatus.SKIPPED
          : s.decision === 'BLOCK'
            ? LaunchStepStatus.BLOCKED
            : s.requiresConfirmation || (softConfirm && s.stepType === 'PROVISION_SERVER')
              ? LaunchStepStatus.WAITING
              : LaunchStepStatus.READY,
      decision: s.decision as LaunchStepDecision,
      executionOrder: s.executionOrder,
      dependsOn: s.dependsOn,
      resourceType: s.resourceType,
      resourceId: s.resourceId,
      reconcileKey: s.reconcileKey,
      maxAttempts: 3,
      metadataJson: {
        reason: s.reason,
        reasonZh: s.reasonZh,
        unitId: s.unitId,
        billable: s.billable,
        requiresConfirmation: s.requiresConfirmation,
      },
    }));

    // Step 31.7 — reconcile open plan on same LaunchRun (do not cancel WAITING_CONFIRMATION).
    const openRun = await this.prisma.launchRun.findFirst({
      where: {
        projectId,
        environmentId: environment.id,
        status: {
          in: [
            LaunchRunStatus.DRAFT,
            LaunchRunStatus.PLANNING,
            LaunchRunStatus.READY,
            LaunchRunStatus.WAITING_CONFIRMATION,
          ],
        },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    let launchRunId: string;
    if (openRun) {
      await this.prisma.launchRunStep.deleteMany({ where: { launchRunId: openRun.id } });
      const updated = await this.prisma.launchRun.update({
        where: { id: openRun.id },
        data: {
          status: runStatus,
          currentStage: plan.steps.find((s) => s.decision === 'EXECUTE')?.stage as LaunchStage | undefined,
          currentStep: plan.steps.find((s) => s.decision === 'EXECUTE')?.stepType ?? null,
          planVersion: plan.planVersion,
          inputSnapshot: plan.inputSnapshot as Prisma.InputJsonValue,
          planSnapshot: planSnapshot as Prisma.InputJsonValue,
          confirmationId: null,
          confirmedAt: null,
          confirmedByUserId: null,
          confirmedPlanHash: null,
          confirmationSnapshot: Prisma.JsonNull,
          failureCode: null,
          failureMessage: null,
          finishedAt: null,
          steps: { create: stepCreates },
        } as Prisma.LaunchRunUpdateInput & LaunchRunConfirmFields,
        include: { steps: { orderBy: { executionOrder: 'asc' } } },
      });
      launchRunId = updated.id;
    } else {
      const launchRun = await this.prisma.launchRun.create({
        data: {
          projectId,
          environmentId: environment.id,
          status: runStatus,
          triggerType: LaunchTriggerType.MANUAL,
          createdByUserId: userId,
          currentStage: plan.steps.find((s) => s.decision === 'EXECUTE')?.stage as LaunchStage | undefined,
          currentStep: plan.steps.find((s) => s.decision === 'EXECUTE')?.stepType ?? null,
          planVersion: plan.planVersion,
          inputSnapshot: plan.inputSnapshot as Prisma.InputJsonValue,
          planSnapshot: planSnapshot as Prisma.InputJsonValue,
          steps: { create: stepCreates },
        },
        include: { steps: { orderBy: { executionOrder: 'asc' } } },
      });
      launchRunId = launchRun.id;
    }

    this.emitSafe('LAUNCH_PLAN_CREATED', {
      launchRunId,
      projectId,
      status: runStatus,
      requiresConfirmation: effectiveRequiresConfirmation,
    });
    void this.alphaTests
      .observeLaunch({
        userId,
        projectId,
        kind: 'PLAN_CREATED',
        launchRunId,
      })
      .catch(() => undefined);
    if (effectiveRequiresConfirmation) {
      this.emitSafe('LAUNCH_WAITING_CONFIRMATION', {
        launchRunId,
        projectId,
        billableCount: plan.billableActions.length,
      });
    }

    return this.toPublicPlanResponse(launchRunId, plan, {
      lockKey: launchProjectLockKey(projectId, environment.id),
      WRITE_COMMANDS_EXECUTED_THIS_RUN: STEP30_PHASE2_WRITE_COMMANDS,
      messageZh: platformManagedAllocated
        ? '将使用 LaunchOS 测试运行资源上线（无新增云资源费用）'
        : '上线计划已生成',
      accessEntryStatus: world.planInput.declared.accessEntryStatus,
      latestFinishedLaunchStatus: priorLaunch?.status ?? null,
      publicUrl: publicHost ? `https://${publicHost}` : null,
      requiresConfirmation: effectiveRequiresConfirmation,
      canLaunch: effectiveCanLaunch,
      launchRunStatus: runStatus,
      status: runStatus,
      realExecutionLocked: false,
      confirmDisabledReasonZh: null,
      platformManagedRuntime: Boolean(platformManagedAllocated),
      platformManagedLabelZh: platformManagedAllocated
        ? '使用 LaunchOS 测试运行资源'
        : null,
    });
  }

  async getLaunchRun(userId: string, projectId: string, launchRunId: string) {
    await this.workspaceAccess.requireProjectAccess(userId, projectId);
    const run = await this.prisma.launchRun.findFirst({
      where: { id: launchRunId, projectId },
      include: { steps: { orderBy: { executionOrder: 'asc' } } },
    });
    if (!run) throw new NotFoundException('上线计划不存在');
    const confirmed = withConfirm(run);
    const planSnap = (run.planSnapshot ?? {}) as Record<string, unknown>;

    const progress = computeLaunchProgress(
      run.steps.map((step) => ({
        stage: step.stage,
        decision: step.decision as 'EXECUTE' | 'REUSE' | 'SKIP' | 'BLOCK',
        status: step.status,
      })),
    );

    const unitId =
      typeof planSnap.primaryDeployableUnitId === 'string'
        ? planSnap.primaryDeployableUnitId
        : null;
    const storedPresentation =
      planSnap.failurePresentation && typeof planSnap.failurePresentation === 'object'
        ? (planSnap.failurePresentation as ReturnType<typeof presentDeploymentFailure>)
        : null;
    const failure =
      run.status === LaunchRunStatus.FAILED
        ? (() => {
            const presented =
              storedPresentation ??
              presentDeploymentFailure({
                failureCode: run.failureCode,
                failureMessage: run.failureMessage,
                currentStage: run.currentStage,
                currentStep: run.currentStep,
                projectId,
                deployableUnitId: unitId,
              });
            if (!presented.configPath && unitId) {
              return {
                ...presented,
                configPath: `/projects/${projectId}/units/${unitId}/config`,
              };
            }
            if (!presented.configPath && projectId) {
              return {
                ...presented,
                configPath: `/projects/${projectId}`,
              };
            }
            return presented;
          })()
        : null;

    return {
      launchRunId: run.id,
      status: run.status,
      planVersion: run.planVersion,
      currentStage: run.currentStage,
      currentStep: run.currentStep,
      progressPercent: progress.progressPercent,
      userMessage:
        run.status === LaunchRunStatus.WAITING_CONFIRMATION
          ? '需要确认将创建的云资源与费用'
          : run.status === LaunchRunStatus.SUCCESS
            ? '应用已上线'
            : run.status === LaunchRunStatus.FAILED
              ? failure?.userMessage || launchErrorUserMessage(run.failureCode, '上线失败')
              : run.status === LaunchRunStatus.RUNNING || run.status === LaunchRunStatus.VERIFYING
                ? planSnap.platformManagedRuntime
                  ? '正在使用 LaunchOS 测试运行资源上线'
                  : '正在上线'
                : run.status === LaunchRunStatus.READY
                  ? '上线计划已就绪'
                  : null,
      failure,
      requiresUserAction: run.status === LaunchRunStatus.WAITING_CONFIRMATION,
      requiresConfirmation: run.status === LaunchRunStatus.WAITING_CONFIRMATION,
      confirmationId: confirmed.confirmationId,
      confirmedPlanHash: confirmed.confirmedPlanHash,
      confirmedAt: confirmed.confirmedAt,
      failureCode: failure?.techCode ?? run.failureCode,
      auditEvents: Array.isArray(planSnap.auditEvents)
        ? planSnap.auditEvents.map((item) =>
            item && typeof item === 'object' && 'event' in item ? String((item as { event: unknown }).event) : '',
          )
        : [],
      stages: planSnap.stages ?? [],
      realExecutionLocked: false,
      steps: run.steps.map((s) => ({
        id: s.id,
        stage: s.stage,
        stepType: s.stepType,
        status: s.status,
        decision: s.decision,
        executionOrder: s.executionOrder,
        resourceType: s.resourceType,
        resourceId: s.resourceId,
        failureCode: s.failureCode,
        failureMessage: s.failureMessage,
        metadata: s.metadataJson,
      })),
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      WRITE_COMMANDS_EXECUTED_THIS_RUN: STEP30_PHASE2_WRITE_COMMANDS,
    };
  }

  /** POST .../confirm — bind confirmation snapshot/hash. Does not call providers. */
  async confirmLaunch(
    userId: string,
    projectId: string,
    launchRunId: string,
    body: { planVersion?: string; acceptance?: boolean },
  ) {
    await this.workspaceAccess.requireProjectAccess(userId, projectId);
    const run = await this.prisma.launchRun.findFirst({
      where: { id: launchRunId, projectId },
    });
    if (!run) throw new NotFoundException('上线计划不存在');

    const planSnap = (run.planSnapshot ?? {}) as {
      billableActions?: LaunchPlanResult['billableActions'];
      resourcesToCreate?: LaunchPlanResult['resourcesToCreate'];
      requiresConfirmation?: boolean;
    };

    if (body.planVersion && body.planVersion !== run.planVersion) {
      throw new BadRequestException({
        code: 'CONFIRMATION_STALE',
        message: launchErrorUserMessage('CONFIRMATION_STALE'),
      });
    }

    const payload = buildConfirmationPayload({
      planVersion: run.planVersion,
      projectId,
      environmentId: run.environmentId,
      billableActions: planSnap.billableActions ?? [],
      resourcesToCreate: planSnap.resourcesToCreate ?? [],
    });
    const confirmationId = `conf_${run.id}_${Date.now().toString(36)}`;
    const record = createConfirmationRecord({
      confirmationId,
      confirmedByUserId: userId,
      payload,
    });

    const updated = await this.prisma.launchRun.update({
      where: { id: run.id },
      data: {
        confirmationId: record.confirmationId,
        confirmedAt: new Date(record.confirmedAt),
        confirmedByUserId: userId,
        confirmedPlanHash: record.confirmedPlanHash,
        confirmationSnapshot: record.snapshot as unknown as Prisma.InputJsonValue,
        status: LaunchRunStatus.READY,
      } as Prisma.LaunchRunUpdateInput & LaunchRunConfirmFields,
    });

    this.emitSafe('LAUNCH_WAITING_CONFIRMATION', {
      launchRunId: updated.id,
      projectId,
      confirmed: true,
      confirmedPlanHash: record.confirmedPlanHash,
    });

    return {
      launchRunId: updated.id,
      confirmed: true,
      confirmationId: record.confirmationId,
      confirmedPlanHash: record.confirmedPlanHash,
      planVersion: run.planVersion,
      billableActions: planSnap.billableActions ?? [],
      status: updated.status,
      realExecutionLocked: false,
      messageZh: '费用已确认，可以开始上线',
      WRITE_COMMANDS_EXECUTED_THIS_RUN: STEP30_PHASE2_WRITE_COMMANDS,
    };
  }

  /** POST .../execute — product path calls executeLaunchRun after safety gates. */
  async executeLaunch(
    userId: string,
    projectId: string,
    launchRunId: string,
    body?: { confirmLaunchExecution?: boolean; gateOnly?: boolean },
  ) {
    await this.assertAccountCanLaunch(userId);
    const { membership, project } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    await this.workspaceAccess.assertWorkspaceMutable(project.workspaceId);
    if (!canRoleExecuteLaunch(membership.role)) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: '当前角色不能上线应用',
      });
    }

    if (body?.gateOnly === true) {
      return this.gateLaunch(userId, projectId, launchRunId);
    }
    const runningCount = await this.prisma.serviceInstance.count({
      where: { projectId, status: 'RUNNING' },
    });
    await this.entitlements.assertCanStartDeployment(userId, project.workspaceId, {
      projectId,
      isExistingRunningApp: runningCount > 0,
      kind: 'deploy',
    });
    // Soft near-limit signal retained for UI
    await this.billing.noteDeploymentQuota(userId, project.workspaceId).catch(() => undefined);

    const run = await this.prisma.launchRun.findFirst({
      where: { id: launchRunId, projectId },
      include: { steps: { orderBy: { executionOrder: 'asc' } } },
    });
    if (!run) throw new NotFoundException('上线计划不存在');

    const world = await this.loadWorldState(userId, projectId, run.environmentId);
    const freshPlan = buildLaunchPlan(world.planInput);
    const freshness = evaluateProductPlanFreshness({
      savedSnapshot: (run.inputSnapshot ?? {}) as Record<string, unknown>,
      currentSnapshot: freshPlan.inputSnapshot,
    });
    if (!freshness.ok) {
      throw new ConflictException({ code: freshness.code, message: freshness.messageZh });
    }

    const knownSteps = defaultLaunchHandlerRegistry.list().map((handler) => handler.stepType);
    const scope = assertAlphaApplicationScope({
      unitTypes: world.planInput.units.map((unit) => unit.type),
      stepTypes: freshPlan.steps.map((step) => step.stepType),
      knownStepTypes: knownSteps,
    });
    if (!scope.ok) {
      throw new BadRequestException({ code: scope.code, message: scope.messageZh });
    }

    const confirmed = withConfirm(run);
    const payload = buildConfirmationPayload({
      planVersion: run.planVersion,
      projectId,
      environmentId: run.environmentId,
      billableActions: freshPlan.billableActions,
      resourcesToCreate: freshPlan.resourcesToCreate,
    });
    const record =
      confirmed.confirmationId && confirmed.confirmedPlanHash
        ? {
            confirmationId: confirmed.confirmationId,
            confirmedAt: confirmed.confirmedAt?.toISOString() ?? new Date().toISOString(),
            confirmedByUserId: confirmed.confirmedByUserId ?? userId,
            confirmedPlanHash: confirmed.confirmedPlanHash,
            planVersion: run.planVersion,
            snapshot: payload,
          }
        : null;
    const billing = evaluateProductBillingGate({
      requiresConfirmation: freshPlan.requiresConfirmation || this.softConfirmRequires(run),
      billableStepTypes: freshPlan.billableActions.map((action) => action.stepType),
      record,
      currentPayload: payload,
    });
    if (!billing.ok) {
      throw new BadRequestException({ code: billing.code, message: billing.messageZh });
    }

    const managedGate = isExternalAlphaManagedWriteEligible(freshPlan);
    const verifyOnly = assertPhase3VerifyOnlyPlan(projectId, freshPlan, {
      skipProjectWhitelist: true,
    });

    if (!managedGate.ok && !verifyOnly.ok) {
      throw new BadRequestException({
        code: managedGate.code ?? 'ALPHA_UNSUPPORTED_APPLICATION',
        message: managedGate.messageZh || '当前 Alpha 暂不支持这个应用结构。',
      });
    }

    const lockKey = launchProjectLockKey(projectId, run.environmentId);
    if (productLaunchLocks.has(lockKey)) {
      const duplicate = duplicateLaunchMessage();
      throw new ConflictException({ code: duplicate.code, message: duplicate.messageZh });
    }
    const active = await this.prisma.launchRun.findFirst({
      where: {
        projectId,
        environmentId: run.environmentId,
        status: { in: [LaunchRunStatus.RUNNING, LaunchRunStatus.VERIFYING] },
        id: { not: run.id },
      },
      select: { id: true },
    });
    if (active) {
      const duplicate = duplicateLaunchMessage();
      throw new ConflictException({ code: duplicate.code, message: duplicate.messageZh, activeLaunchRunId: active.id });
    }

    productLaunchLocks.add(lockKey);

    if (managedGate.ok) {
      void this.runManagedAlphaLaunch({
        userId,
        projectId,
        launchRunId: run.id,
        environmentId: run.environmentId,
        lockKey,
        world,
        freshPlan,
        steps: run.steps,
      }).finally(() => {
        productLaunchLocks.delete(lockKey);
      });

      return {
        launchRunId: run.id,
        status: 'RUNNING',
        currentStage: 'BUILD',
        progressPercent: 10,
        orchestratorInvoked: true,
        scriptBypass: false,
        publicUrl: null,
        messageZh: '正在使用 LaunchOS 测试运行资源上线',
        platformManagedRuntime: true,
      };
    }

    await this.prisma.launchRun.update({
      where: { id: run.id },
      data: { status: LaunchRunStatus.RUNNING, startedAt: new Date(), currentStage: 'VERIFY' },
    });

    const routes = await this.prisma.gatewayRoute.findMany({ where: { projectId } });
    const serverHost = world.planInput.declared.server?.id
      ? (
          await this.prisma.serverInstance.findUnique({
            where: { id: world.planInput.declared.server.id },
            select: { host: true },
          })
        )?.host
      : null;
    const bound = await this.prisma.serviceInstance.findFirst({
      where: { projectId, serverInstanceId: { not: null } },
      orderBy: { updatedAt: 'desc' },
      select: { server: { select: { host: true } } },
    });
    const expectedIp = bound?.server?.host || serverHost || '116.62.198.184';
    const publicUrl = routes.find((route) => route.hostname.startsWith('oneclick-'))?.hostname
      ?? routes.find((route) => !route.hostname.startsWith('api-'))?.hostname
      ?? null;

    const persistence = this.productPersistence(run.id, userId, projectId);
    const declared = this.productDeclared(world.planInput, freshPlan);
    void this.alphaTests
      .observeLaunch({
        userId,
        projectId,
        kind: 'LAUNCH_STARTED',
        launchRunId: run.id,
        status: 'RUNNING',
        publicUrl: publicUrl ? `https://${publicUrl}` : null,
      })
      .catch(() => undefined);
    void executeLaunchRun({
      launchRunId: run.id,
      projectId,
      environmentId: run.environmentId,
      planVersion: freshPlan.planVersion,
      plan: freshPlan,
      steps: run.steps.map((step) => ({
        id: step.id,
        stage: step.stage,
        stepType: step.stepType,
        status: step.status,
        decision: step.decision as 'EXECUTE' | 'REUSE' | 'SKIP' | 'BLOCK',
        dependsOn: step.dependsOn,
        reconcileKey: step.reconcileKey,
        resourceType: step.resourceType,
        resourceId: step.resourceId,
        metadataJson: (step.metadataJson ?? {}) as Record<string, unknown>,
      })),
      currentInputSnapshot: freshPlan.inputSnapshot,
      persistence,
      productAlpha: true,
      declared,
      verifyApi: () => this.verifyRoute(routes, 'API', '/health', expectedIp, [200]),
      verifyWeb: async () => ({
        ...(await this.verifyRoute(routes, 'WEB', '/', expectedIp, [200, 301, 302])),
        publicApiUrlPresent: null,
      }),
    })
      .catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : '上线执行失败';
        const failureCode = message.split(':')[0]?.slice(0, 80) || 'LAUNCH_FAILED';
        await this.prisma.launchRun.update({
          where: { id: run.id },
          data: {
            status: LaunchRunStatus.FAILED,
            finishedAt: new Date(),
            failureCode,
            failureMessage: '上线检查未通过',
          },
        });
        await this.alphaTests
          .observeLaunch({
            userId,
            projectId,
            kind: 'LAUNCH_FINISHED',
            launchRunId: run.id,
            status: 'FAILED',
            failureCode,
            failedStage: 'VERIFY',
          })
          .catch(() => undefined);
      })
      .finally(() => {
        productLaunchLocks.delete(lockKey);
      });

    return {
      launchRunId: run.id,
      status: 'RUNNING',
      currentStage: 'VERIFY',
      progressPercent: 10,
      orchestratorInvoked: true,
      scriptBypass: false,
      publicUrl: publicUrl ? `https://${publicUrl}` : null,
      messageZh: '正在进行上线检查',
    };
  }

  private softConfirmRequires(run: { planSnapshot: unknown }): boolean {
    const snap = (run.planSnapshot ?? {}) as { requiresConfirmation?: boolean; platformManagedRuntime?: boolean };
    return Boolean(snap.requiresConfirmation || snap.platformManagedRuntime);
  }

  /**
   * Step 31.7 — real BUILD/DEPLOY/PUBLIC_ENTRY/VERIFY on PLATFORM_MANAGED capacity.
   * Uses DeploymentsService (existing-resource-only). Never provisions ECS/RDS/Redis.
   */
  private async runManagedAlphaLaunch(input: {
    userId: string;
    projectId: string;
    launchRunId: string;
    environmentId: string;
    lockKey: string;
    world: { planInput: BuildLaunchPlanInput };
    freshPlan: LaunchPlanResult;
    steps: Array<{
      id: string;
      stage: string;
      stepType: string;
      status: string;
      decision: string;
      dependsOn: string[];
      reconcileKey: string;
      resourceType: string | null;
      resourceId: string | null;
      metadataJson: unknown;
    }>;
  }) {
    const { userId, projectId, launchRunId, environmentId, world, freshPlan, steps } = input;
    const markStep = async (
      stepId: string,
      status: LaunchStepStatus,
      extra?: { failureCode?: string; failureMessage?: string },
    ) => {
      await this.prisma.launchRunStep.update({
        where: { id: stepId },
        data: {
          status,
          startedAt: status === LaunchStepStatus.RUNNING ? new Date() : undefined,
          finishedAt:
            status === LaunchStepStatus.SUCCESS ||
            status === LaunchStepStatus.FAILED ||
            status === LaunchStepStatus.SKIPPED
              ? new Date()
              : undefined,
          failureCode: extra?.failureCode ?? null,
          failureMessage: extra?.failureMessage ?? null,
        },
      });
    };

    try {
      await this.prisma.launchRun.update({
        where: { id: launchRunId },
        data: {
          status: LaunchRunStatus.RUNNING,
          startedAt: new Date(),
          currentStage: 'BUILD',
          currentStep: 'BUILD_UNIT',
          failureCode: null,
          failureMessage: null,
        },
      });
      void this.alphaTests
        .observeLaunch({
          userId,
          projectId,
          kind: 'LAUNCH_STARTED',
          launchRunId,
          status: 'RUNNING',
          publicUrl: null,
        })
        .catch(() => undefined);

      for (const step of steps) {
        if (step.decision === 'REUSE' || step.decision === 'SKIP') {
          await markStep(step.id, LaunchStepStatus.SKIPPED);
        }
      }

      const launchUnits = world.planInput.units.filter(
        (unit) => unit.type === 'WEB' || unit.type === 'API' || unit.type === 'ADMIN',
      );
      // Deploy API before WEB so public API URL can be wired when present.
      const ordered = [
        ...launchUnits.filter((u) => u.type === 'API'),
        ...launchUnits.filter((u) => u.type === 'WEB' || u.type === 'ADMIN'),
      ];

      const buildSteps = steps.filter(
        (s) =>
          s.decision === 'EXECUTE' &&
          (s.stepType === 'BUILD_UNIT' || s.stepType === 'BUILD_DOCKER_IMAGE'),
      );
      for (const step of buildSteps) {
        await markStep(step.id, LaunchStepStatus.RUNNING);
      }

      const launchMeta = await this.prisma.launchRun.findUnique({
        where: { id: launchRunId },
        select: { confirmationId: true, confirmedAt: true, updatedAt: true },
      });
      const attemptKey =
        launchMeta?.confirmationId ||
        (launchMeta?.confirmedAt ? launchMeta.confirmedAt.toISOString() : null) ||
        launchMeta?.updatedAt?.toISOString() ||
        String(Date.now());

      let lastDeploymentId: string | null = null;
      for (const unit of ordered) {
        await this.prisma.launchRun.update({
          where: { id: launchRunId },
          data: {
            currentStage: 'DEPLOY',
            currentStep: unit.type === 'API' ? 'DEPLOY_API' : 'DEPLOY_WEB',
          },
        });
        const created = await this.deployments.create(userId, projectId, {
          environmentId,
          hostingMode: 'launchos',
          targetType: 'MANAGED_SERVER',
          deployableUnitId: unit.id,
          // Include confirmation/attempt so retries after FAILED do not reuse terminal deployments.
          idempotencyKey: `alpha-managed-${launchRunId}-${unit.id}-${attemptKey}`,
        });
        const deploymentId = created.id ?? (created as { deployment?: { id?: string } }).deployment?.id;
        if (!deploymentId) {
          throw new Error('DEPLOY_CREATE_FAILED:未能创建部署任务');
        }
        lastDeploymentId = deploymentId;

        let finalStatus = 'RUNNING';
        for (let i = 0; i < 120; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          const current = await this.prisma.deployment.findUnique({
            where: { id: deploymentId },
            select: { status: true, failureCode: true, errorMessage: true },
          });
          finalStatus = current?.status ?? 'FAILED';
          if (finalStatus === 'SUCCESS' || finalStatus === 'FAILED' || finalStatus === 'CANCELLED') {
            if (finalStatus !== 'SUCCESS') {
              throw new Error(
                `${current?.failureCode || 'DEPLOY_FAILED'}:${current?.errorMessage || finalStatus}`,
              );
            }
            break;
          }
        }
        if (finalStatus !== 'SUCCESS') {
          throw new Error(`DEPLOY_TIMEOUT:deployment ${deploymentId} still ${finalStatus}`);
        }
      }

      for (const step of buildSteps) {
        await markStep(step.id, LaunchStepStatus.SUCCESS);
      }
      for (const step of steps) {
        if (
          step.decision === 'EXECUTE' &&
          (step.stepType.startsWith('DEPLOY_') ||
            step.stepType.startsWith('APPLY_') ||
            step.stepType === 'INSTALL_GATEWAY' ||
            step.stepType === 'INSTALL_CERTIFICATE' ||
            step.stepType === 'INITIALIZE_SERVER' ||
            step.stepType === 'PLAN_SERVER' ||
            step.stepType === 'ANALYZE_PROJECT' ||
            step.stepType === 'PLAN_DEPENDENCIES')
        ) {
          await markStep(step.id, LaunchStepStatus.SUCCESS);
        }
      }

      await this.prisma.launchRun.update({
        where: { id: launchRunId },
        data: { currentStage: 'VERIFY', currentStep: 'VERIFY_WEB_HTTPS' },
      });

      let routes = await this.prisma.gatewayRoute.findMany({
        where: { projectId, status: 'ACTIVE' },
        select: { unitId: true, hostname: true, healthPath: true },
      });
      if (routes.length === 0) {
        // Colocated PLATFORM_MANAGED publishes nginx + ApplicationDomain; GatewayRoute
        // rows may lag. Fall back so VERIFY still targets the live public hostnames.
        const domains = await this.prisma.applicationDomain.findMany({
          where: { projectId, status: 'ACTIVE' },
          select: { domain: true, deployableUnitId: true },
          orderBy: { updatedAt: 'desc' },
        });
        routes = domains.map((domain) => ({
          unitId: domain.deployableUnitId || '',
          hostname: domain.domain,
          healthPath: domain.domain.toLowerCase().startsWith('api-') ? '/health' : '/',
        }));
      }
      const serverHost =
        (
          await this.prisma.serverInstance.findFirst({
            where: { scope: 'PLATFORM_MANAGED', host: '116.62.198.184' },
            select: { host: true },
          })
        )?.host ?? '116.62.198.184';

      const webVerify = await this.verifyManagedColocatedRoute(
        routes,
        'WEB',
        '/',
        serverHost,
        [200, 301, 302],
      );
      const hasApi = ordered.some((u) => u.type === 'API');
      const apiVerify = hasApi
        ? await this.verifyManagedColocatedRoute(routes, 'API', '/health', serverHost, [200])
        : { ok: true as const };

      if (!webVerify.ok || !apiVerify.ok) {
        throw new Error(
          `VERIFY_FAILED:公网访问检查未通过 web=${webVerify.detail || 'fail'} api=${'detail' in apiVerify ? apiVerify.detail || 'fail' : 'ok'}`,
        );
      }

      for (const step of steps) {
        if (
          step.decision === 'EXECUTE' &&
          (step.stepType.startsWith('VERIFY_') || step.stepType === 'FINAL_ACCEPTANCE')
        ) {
          await markStep(step.id, LaunchStepStatus.SUCCESS);
        }
      }

      const publicHost =
        routes.find((route) => route.hostname.startsWith('oneclick-'))?.hostname ??
        routes.find((route) => !route.hostname.startsWith('api-'))?.hostname ??
        routes[0]?.hostname ??
        null;
      const publicUrl = publicHost ? `https://${publicHost}` : null;

      await this.prisma.launchRun.update({
        where: { id: launchRunId },
        data: {
          status: LaunchRunStatus.SUCCESS,
          finishedAt: new Date(),
          currentStage: 'VERIFY',
          currentStep: 'FINAL_ACCEPTANCE',
          failureCode: null,
          failureMessage: null,
          planSnapshot: {
            ...((freshPlan && this.toPlanSnapshot(freshPlan)) as object),
            platformManagedRuntime: true,
            platformManagedLabelZh: '使用 LaunchOS 测试运行资源',
            lastDeploymentId,
            publicUrl,
          } as Prisma.InputJsonValue,
        },
      });
      await this.alphaTests
        .observeLaunch({
          userId,
          projectId,
          kind: 'LAUNCH_FINISHED',
          launchRunId,
          status: 'SUCCESS',
          publicUrl,
        })
        .catch(() => undefined);
    } catch (error: unknown) {
      const runMeta = await this.prisma.launchRun.findUnique({
        where: { id: launchRunId },
        select: { currentStage: true, currentStep: true },
      });
      const extracted = extractNestFailurePayload(error);
      const unitFromPlan =
        world.planInput.units.find((u) => u.type === 'WEB' || u.type === 'ADMIN')?.id ||
        world.planInput.units.find((u) => u.type === 'API')?.id ||
        world.planInput.units[0]?.id ||
        null;
      const presented = presentDeploymentFailure({
        failureCode: extracted.code,
        failureMessage: extracted.message,
        currentStage: runMeta?.currentStage || 'DEPLOY',
        currentStep: runMeta?.currentStep || 'DEPLOY_WEB',
        projectId,
        deployableUnitId: extracted.deployableUnitId || unitFromPlan,
        missingKeys: extracted.missingKeys,
      });
      const failureCode = presented.techCode;
      const failureMessage = presented.userMessage;
      const runningSteps = await this.prisma.launchRunStep.findMany({
        where: {
          launchRunId,
          status: { in: [LaunchStepStatus.RUNNING, LaunchStepStatus.READY, LaunchStepStatus.PENDING] },
        },
        select: { id: true },
      });
      for (const step of runningSteps) {
        await markStep(step.id, LaunchStepStatus.FAILED, { failureCode, failureMessage });
      }
      await this.prisma.launchRun.update({
        where: { id: launchRunId },
        data: {
          status: LaunchRunStatus.FAILED,
          finishedAt: new Date(),
          failureCode,
          failureMessage,
          planSnapshot: {
            ...((freshPlan && this.toPlanSnapshot(freshPlan)) as object),
            platformManagedRuntime: true,
            failurePresentation: presented,
            rawFailureDetail: extracted.message.slice(0, 500),
          } as Prisma.InputJsonValue,
        },
      });
      await this.alphaTests
        .observeLaunch({
          userId,
          projectId,
          kind: 'LAUNCH_FINISHED',
          launchRunId,
          status: 'FAILED',
          failureCode,
          failedStage: presented.productStage,
        })
        .catch(() => undefined);
      await this.alphaTests
        .noteDeploymentFailureDiagnosisP1({
          userId,
          projectId,
          launchRunId,
          failureStage: presented.productStage,
          failureCategory: presented.category,
          userBlocked: true,
        })
        .catch(() => undefined);
    }
  }

  private productPersistence(launchRunId: string, userId?: string, projectId?: string): LaunchRunPersistence {
    return {
      acquireLaunchLock: async () => true,
      releaseLaunchLock: async () => undefined,
      updateRun: async (input) => {
        await this.prisma.launchRun.update({
          where: { id: input.launchRunId },
          data: {
            status: input.status as LaunchRunStatus,
            currentStage: (input.currentStage as LaunchStage | null) ?? undefined,
            currentStep: input.currentStep ?? undefined,
            startedAt: input.startedAt ?? undefined,
            finishedAt: input.finishedAt ?? undefined,
            failureCode: input.failureCode === undefined ? undefined : input.failureCode,
            failureMessage: input.failureMessage === undefined ? undefined : input.failureMessage,
          },
        });
        if ((input.status === 'SUCCESS' || input.status === 'FAILED') && userId && projectId) {
          await this.alphaTests
            .observeLaunch({
              userId,
              projectId,
              kind: 'LAUNCH_FINISHED',
              launchRunId,
              status: input.status,
              at: input.finishedAt ?? new Date(),
              failureCode: input.failureCode,
              failedStage: input.currentStage,
              failedStep: input.currentStep,
            })
            .catch(() => undefined);
        }
      },
      updateStep: async (input) => {
        await this.prisma.launchRunStep.update({
          where: { id: input.stepId },
          data: {
            status: input.status as never,
            startedAt: input.startedAt ?? undefined,
            finishedAt: input.finishedAt ?? undefined,
            failureCode: input.failureCode === undefined ? undefined : input.failureCode,
            failureMessage: input.failureMessage === undefined ? undefined : input.failureMessage,
            attemptCount: input.attemptCount,
            metadataJson: input.metadataJson as Prisma.InputJsonValue | undefined,
          },
        });
      },
      appendAudit: async (event, metadata) => {
        assertLaunchEventSafe({ event, ...metadata });
        const current = await this.prisma.launchRun.findUnique({
          where: { id: launchRunId },
          select: { planSnapshot: true },
        });
        const snapshot =
          current?.planSnapshot && typeof current.planSnapshot === 'object' && !Array.isArray(current.planSnapshot)
            ? { ...(current.planSnapshot as Record<string, unknown>) }
            : {};
        const events = Array.isArray(snapshot.auditEvents) ? [...snapshot.auditEvents] : [];
        events.push({ event, at: new Date().toISOString() });
        snapshot.auditEvents = events;
        await this.prisma.launchRun.update({
          where: { id: launchRunId },
          data: { planSnapshot: snapshot as Prisma.InputJsonValue },
        });
      },
    };
  }

  private productDeclared(
    input: BuildLaunchPlanInput,
    plan: LaunchPlanResult,
  ): ExecuteLaunchRunInput['declared'] {
    const types = new Set(input.units.map((unit) => unit.type));
    const healthy = (type: string) => {
      if (!types.has(type)) return true;
      const unit = input.declared.units.find((item) => item.type === type);
      return unit?.serviceStatus === 'RUNNING' && unit.healthStatus === 'HEALTHY';
    };
    const gateway = (type: string) => {
      if (!types.has(type)) return true;
      return input.declared.units.find((item) => item.type === type)?.gatewayStatus === 'ACTIVE';
    };
    return {
      postgresqlConnected: !input.declared.postgresql.required || input.declared.postgresql.status === 'CONNECTED',
      redisConnected: !input.declared.redis.required || input.declared.redis.status === 'CONNECTED',
      serverReady: plan.serverReady,
      apiRunningHealthy: healthy('API'),
      webRunningHealthy: healthy('WEB'),
      apiGatewayActive: gateway('API'),
      webGatewayActive: gateway('WEB'),
      accessEntryActive: input.declared.accessEntryStatus === 'ACTIVE',
      dynamicPortsPrivate: true,
    };
  }

  private verifyRoute(
    routes: Array<{ unitId: string; hostname: string; healthPath: string }>,
    unitType: 'API' | 'WEB',
    fallbackPath: string,
    expectedIp: string,
    acceptStatuses: number[],
  ) {
    const route =
      routes.find((item) =>
        unitType === 'API' ? item.hostname.startsWith('api-') : !item.hostname.startsWith('api-'),
      ) ?? routes[0];
    if (!route) {
      return verifyPublicHttps({
        hostname: 'invalid.local',
        url: 'https://invalid.local/',
        expectedIp,
        acceptStatuses,
      });
    }
    const path = route.healthPath || fallbackPath;
    return verifyPublicHttps({
      hostname: route.hostname,
      url: `https://${route.hostname}${path.startsWith('/') ? path : `/${path}`}`,
      expectedIp,
      acceptStatuses,
    });
  }

  /**
   * PLATFORM_MANAGED: SUCCESS only when public DNS resolves to the Alpha IP and
   * real HTTPS to the public hostname succeeds. Never use curl --resolve to fake DNS.
   */
  private async verifyManagedColocatedRoute(
    routes: Array<{ unitId: string; hostname: string; healthPath: string }>,
    unitType: 'API' | 'WEB',
    fallbackPath: string,
    expectedIp: string,
    acceptStatuses: number[],
  ): Promise<{ ok: boolean; detail?: string; hostname?: string }> {
    const route =
      routes.find((item) =>
        unitType === 'API' ? item.hostname.startsWith('api-') : !item.hostname.startsWith('api-'),
      ) ?? routes[0];
    if (!route?.hostname) {
      return { ok: false, detail: 'NO_ROUTE' };
    }
    const host = route.hostname.trim().toLowerCase();
    if (host.endsWith('.launchos.app') || host === 'launchos.app') {
      return {
        ok: false,
        hostname: host,
        detail: 'UNCONTROLLED_SYSTEM_DOMAIN:launchos.app（请配置 LAUNCHOS_SYSTEM_DOMAIN）',
      };
    }
    const path = (route.healthPath || fallbackPath || '/').startsWith('/')
      ? route.healthPath || fallbackPath || '/'
      : `/${route.healthPath || fallbackPath}`;
    const result = await verifyPublicEntryWithRetry({
      hostname: host,
      path,
      expectedIp,
      acceptStatuses,
      attempts: 8,
      backoffMs: 5_000,
    });
    if (!result.ok) {
      return {
        ok: false,
        hostname: host,
        detail: `${result.failureCode || 'VERIFY_FAILED'}:dns=${result.dnsCorrect}:http=${result.httpStatus ?? 'none'}:${result.failureMessage || ''}`.slice(
          0,
          240,
        ),
      };
    }
    return { ok: true, hostname: host, detail: `HTTP_${result.httpStatus}` };
  }

  async gateLaunch(userId: string, projectId: string, launchRunId: string) {
    await this.workspaceAccess.requireProjectAccess(userId, projectId);
    const run = await this.prisma.launchRun.findFirst({
      where: { id: launchRunId, projectId },
      include: { steps: { orderBy: { executionOrder: 'asc' } } },
    });
    if (!run) throw new NotFoundException('上线计划不存在');
    const confirmed = withConfirm(run);

    const world = await this.loadWorldState(userId, projectId, run.environmentId);
    const freshPlan = buildLaunchPlan(world.planInput);
    const planSnap = (run.planSnapshot ?? {}) as {
      billableActions?: LaunchPlanResult['billableActions'];
      resourcesToCreate?: LaunchPlanResult['resourcesToCreate'];
      requiresConfirmation?: boolean;
      executionSteps?: string[];
      reuseSteps?: string[];
      skipSteps?: string[];
      currentDesiredStateSatisfied?: boolean;
    };

    const confirmation =
      confirmed.confirmedPlanHash && confirmed.confirmationId
        ? {
            confirmationId: confirmed.confirmationId,
            confirmedAt: confirmed.confirmedAt?.toISOString() ?? new Date().toISOString(),
            confirmedByUserId: confirmed.confirmedByUserId ?? userId,
            confirmedPlanHash: confirmed.confirmedPlanHash,
            planVersion: run.planVersion,
            snapshot: (confirmed.confirmationSnapshot ?? {
              planVersion: run.planVersion,
              projectId,
              environmentId: run.environmentId,
              billableActions: planSnap.billableActions ?? [],
              resourcesToCreate: planSnap.resourcesToCreate ?? [],
            }) as never,
          }
        : null;

    const gate = evaluateLaunchGate({
      launchRunId: run.id,
      projectId,
      environmentId: run.environmentId,
      planVersion: run.planVersion,
      plan: {
        billableActions: planSnap.billableActions ?? freshPlan.billableActions,
        resourcesToCreate: planSnap.resourcesToCreate ?? freshPlan.resourcesToCreate,
        requiresConfirmation:
          planSnap.requiresConfirmation ?? freshPlan.requiresConfirmation,
        executionSteps: planSnap.executionSteps ?? freshPlan.executionSteps,
        reuseSteps: planSnap.reuseSteps ?? freshPlan.reuseSteps,
        skipSteps: planSnap.skipSteps ?? freshPlan.skipSteps,
        currentDesiredStateSatisfied:
          planSnap.currentDesiredStateSatisfied ?? freshPlan.currentDesiredStateSatisfied,
        inputSnapshot: (run.inputSnapshot ?? {}) as Record<string, unknown>,
      },
      steps: run.steps.map((s) => ({
        id: s.id,
        stage: s.stage,
        stepType: s.stepType,
        status: s.status,
        decision: s.decision as 'EXECUTE' | 'REUSE' | 'SKIP' | 'BLOCK',
        dependsOn: s.dependsOn,
        reconcileKey: s.reconcileKey,
        resourceType: s.resourceType,
        resourceId: s.resourceId,
        metadata: (s.metadataJson ?? {}) as Record<string, unknown>,
      })),
      currentInputSnapshot: freshPlan.inputSnapshot,
      confirmation,
      gateOnly: true,
      realExecutionLocked: true,
      driftInput: {
        dependencyOk: freshPlan.dependenciesReady,
        serverOk: freshPlan.serverReady,
        units: world.planInput.declared.units.map((u) => ({
          unitId: u.unitId,
          declaredHealthy:
            u.serviceStatus === 'RUNNING' &&
            (u.healthStatus === 'HEALTHY' || !u.healthStatus),
          containerObservedRunning:
            world.planInput.observed?.containerObservedRunning?.[u.unitId] ?? null,
          healthObserved2xx:
            world.planInput.observed?.healthObserved2xx?.[u.unitId] ?? null,
          gatewayActive: u.gatewayStatus === 'ACTIVE',
          dnsObservedCorrect:
            world.planInput.observed?.dnsObservedCorrect?.[u.unitId] ?? null,
        })),
        certificateValid: world.planInput.observed?.certificateObservedValid ?? null,
        accessEntryActive: freshPlan.publicEntryReady,
      },
    });

    return {
      ...gate,
      status: run.status,
      messageZh: gate.canExecute
        ? '上线执行器已准备，真实执行暂未开放'
        : gate.blockers[0]?.messageZh ?? '无法执行',
      code: gate.canExecute ? STEP30_PHASE2_REAL_EXECUTION_LOCKED : gate.blockers[0]?.code,
    };
  }

  async startLaunch(
    userId: string,
    projectId: string,
    body: {
      dryRun?: boolean;
      confirm?: boolean;
      environmentId?: string;
      launchRunId?: string;
    },
  ) {
    await this.workspaceAccess.requireProjectAccess(userId, projectId);

    if (body.confirm === true || body.dryRun === false) {
      throw new ForbiddenException({
        code: STEP30_REAL_EXECUTION_LOCKED,
        message: launchErrorUserMessage(STEP30_REAL_EXECUTION_LOCKED),
      });
    }

    if (body.launchRunId) {
      return this.getLaunchRun(userId, projectId, body.launchRunId);
    }
    return this.createPlan(userId, projectId, { environmentId: body.environmentId });
  }

  async cancelLaunchRun(userId: string, projectId: string, launchRunId: string) {
    await this.workspaceAccess.requireProjectAccess(userId, projectId);
    const run = await this.prisma.launchRun.findFirst({
      where: { id: launchRunId, projectId },
      include: { steps: true },
    });
    if (!run) throw new NotFoundException('上线计划不存在');

    const policy = evaluateCancelPolicy({
      runStatus: run.status,
      steps: run.steps.map((s) => ({
        status: s.status,
        billable: Boolean((s.metadataJson as { billable?: boolean } | null)?.billable),
        writeClass: (s.metadataJson as { writeClass?: string } | null)?.writeClass,
      })),
    });

    if (policy.status === 'CANCELLATION_PENDING_RECONCILE') {
      return {
        launchRunId: run.id,
        status: 'CANCELLATION_PENDING_RECONCILE',
        cancellationPending: true,
        messageZh: policy.messageZh,
        WRITE_COMMANDS_EXECUTED_THIS_RUN: STEP30_PHASE2_WRITE_COMMANDS,
      };
    }

    if (!policy.allowed) {
      throw new BadRequestException(policy.messageZh);
    }

    const updated = await this.prisma.launchRun.update({
      where: { id: run.id },
      data: {
        status: LaunchRunStatus.CANCELLED,
        finishedAt: new Date(),
      },
    });
    return {
      launchRunId: updated.id,
      status: updated.status,
      cancellationPending: false,
      messageZh: policy.messageZh,
      WRITE_COMMANDS_EXECUTED_THIS_RUN: STEP30_PHASE2_WRITE_COMMANDS,
    };
  }

  async resumeLaunchRun(userId: string, projectId: string, launchRunId: string) {
    await this.workspaceAccess.requireProjectAccess(userId, projectId);
    const run = await this.prisma.launchRun.findFirst({
      where: { id: launchRunId, projectId },
      include: { steps: { orderBy: { executionOrder: 'asc' } } },
    });
    if (!run) throw new NotFoundException('上线计划不存在');

    const world = await this.loadWorldState(userId, projectId, run.environmentId);
    const stale = detectPlanStale((run.inputSnapshot as Record<string, unknown>) ?? {}, {
      serverId: world.planInput.declared.server?.id ?? null,
      postgresqlStatus: world.planInput.declared.postgresql.status,
      redisStatus: world.planInput.declared.redis.status,
      accessEntryStatus: world.planInput.declared.accessEntryStatus ?? null,
      unitIds: world.planInput.units.map((u) => u.id),
    });

    const stepActions = run.steps.map((s) => {
      const meta = (s.metadataJson ?? {}) as { billable?: boolean };
      return {
        stepType: s.stepType,
        status: s.status,
        action: planResumeStep({
          stepType: s.stepType,
          stepStatus: s.status,
          billable: Boolean(meta.billable),
          failureCode: s.failureCode,
        }),
      };
    });

    const reconcile = reconcileRunningSteps(
      run.steps.map((s) => ({
        id: s.id,
        stage: s.stage,
        stepType: s.stepType,
        status: s.status,
        decision: s.decision as 'EXECUTE' | 'REUSE' | 'SKIP' | 'BLOCK',
        dependsOn: s.dependsOn,
        reconcileKey: s.reconcileKey,
        resourceType: s.resourceType,
        resourceId: s.resourceId,
        metadata: (s.metadataJson ?? {}) as Record<string, unknown>,
      })),
      {
        launchRunId: run.id,
        projectId,
        environmentId: run.environmentId,
        confirmationSatisfied: Boolean(withConfirm(run).confirmedPlanHash),
      },
    );

    this.emitSafe('LAUNCH_RESUMED', {
      launchRunId: run.id,
      projectId,
      stale: stale.stale,
    });

    return {
      launchRunId: run.id,
      status: run.status,
      planStale: stale.stale,
      staleReasons: stale.reasons,
      stepActions,
      reconcile,
      realExecutionLocked: true,
      code: STEP30_PHASE2_REAL_EXECUTION_LOCKED,
      messageZh: launchErrorUserMessage(STEP30_PHASE2_REAL_EXECUTION_LOCKED),
      WRITE_COMMANDS_EXECUTED_THIS_RUN: STEP30_PHASE2_WRITE_COMMANDS,
    };
  }

  async buildPlanOnly(
    userId: string,
    projectId: string,
    opts?: { environmentId?: string; observed?: ObservedFacts | null },
  ): Promise<LaunchPlanResult> {
    await this.workspaceAccess.requireProjectAccess(userId, projectId);
    const environment = await this.resolveEnvironment(projectId, opts?.environmentId);
    const world = await this.loadWorldState(userId, projectId, environment.id, opts?.observed);
    return buildLaunchPlan(world.planInput);
  }

  private async assertNoActiveLaunch(projectId: string, environmentId: string) {
    const running = await this.prisma.launchRun.findFirst({
      where: {
        projectId,
        environmentId,
        status: {
          in: [LaunchRunStatus.RUNNING, LaunchRunStatus.VERIFYING] as LaunchRunStatus[],
        },
      },
      select: { id: true, status: true },
    });
    if (running) {
      throw new ConflictException({
        code: 'DUPLICATE_LAUNCH_LOCK',
        message: launchErrorUserMessage('DUPLICATE_LAUNCH_LOCK'),
        lockKey: launchProjectLockKey(projectId, environmentId),
        activeLaunchRunId: running.id,
      });
    }
    // Open DRAFT/PLANNING/READY/WAITING_CONFIRMATION runs are reconciled in createPlan
    // (Step 31.7) — do not cancel them here.
  }

  private async assertAccountCanLaunch(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { accountStatus: true } });
    const decision = assertAccountCanUseProduct(user?.accountStatus ?? 'ACTIVE');
    if (!decision.allowed) throw new ForbiddenException(decision.message);
  }

  private async resolveEnvironment(projectId: string, environmentId?: string) {
    if (environmentId) {
      const env = await this.prisma.projectEnvironment.findFirst({
        where: { id: environmentId, projectId },
      });
      if (!env) throw new NotFoundException('环境不存在');
      return env;
    }
    const env =
      (await this.prisma.projectEnvironment.findFirst({
        where: { projectId, name: 'production' },
      })) ??
      (await this.prisma.projectEnvironment.findFirst({
        where: { projectId },
        orderBy: { createdAt: 'asc' },
      }));
    if (env) {
      return env;
    }
    // Historical / onboarding projects may lack a control-plane environment.
    return this.environments.ensureDefaultProduction(projectId);
  }

  private async loadWorldState(
    userId: string,
    projectId: string,
    environmentId: string,
    observedOverride?: ObservedFacts | null,
  ): Promise<{ planInput: BuildLaunchPlanInput }> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        workspaceId: true,
        deployableUnits: {
          select: {
            id: true,
            name: true,
            type: true,
            deployable: true,
            status: true,
            framework: true,
          },
        },
      },
    });
    if (!project) throw new NotFoundException('应用不存在');

    const depSummary = await this.dependencies.getProjectSummary(userId, projectId);

    const units: LaunchUnitInput[] = [];
    let requiresPg = false;
    let requiresRedis = false;
    let pgStatus = 'NOT_REQUIRED';
    let pgConnectionId: string | null = null;
    let redisStatus = 'NOT_REQUIRED';
    let redisConnectionId: string | null = null;

    for (const unit of project.deployableUnits) {
      const unitDeps = depSummary.units.find((u) => u.unitId === unit.id);
      const pg = unitDeps?.dependencies.find((d) => d.type === 'POSTGRESQL');
      const redis = unitDeps?.dependencies.find((d) => d.type === 'REDIS');
      const unitRequiresPg = Boolean(pg?.required);
      const unitRequiresRedis = Boolean(redis?.required);
      if (unitRequiresPg) {
        requiresPg = true;
        if (pg?.status === 'CONNECTED') {
          pgStatus = 'CONNECTED';
          pgConnectionId = pg.connectionId;
        } else if (pgStatus !== 'CONNECTED') {
          pgStatus = pg?.status ?? 'MISSING';
          pgConnectionId = pg?.connectionId ?? null;
        }
      }
      if (unitRequiresRedis) {
        requiresRedis = true;
        if (redis?.status === 'CONNECTED') {
          redisStatus = 'CONNECTED';
          redisConnectionId = redis.connectionId;
        } else if (redisStatus !== 'CONNECTED') {
          redisStatus = redis?.status ?? 'MISSING';
          redisConnectionId = redis?.connectionId ?? null;
        }
      }
      units.push({
        id: unit.id,
        name: unit.name,
        type: unit.type,
        deployable: unit.deployable,
        status: unit.status,
        requiresPostgresql: unitRequiresPg,
        requiresRedis: unitRequiresRedis,
      });
    }

    if (!requiresPg) pgStatus = 'NOT_REQUIRED';
    if (!requiresRedis) redisStatus = 'NOT_REQUIRED';

    const servers = await this.prisma.serverInstance.findMany({
      where: { workspaceId: project.workspaceId, scope: 'WORKSPACE_OWNED' },
      orderBy: { updatedAt: 'desc' },
    });
    let readyServer =
      servers.find(
        (s) =>
          (s.status === 'READY' || s.status === 'RUNNING' || s.dockerStatus === 'READY') &&
          s.status !== 'FAILED',
      ) ?? null;

    // Step 31.7 — External Alpha: allocate PLATFORM_MANAGED shared capacity when
    // workspace has no owned READY server. Never reassign WORKSPACE_OWNED across workspaces.
    let platformManaged = false;
    if (!readyServer) {
      const allocated = await this.managedHosting.allocate();
      if (!('code' in allocated)) {
        const managed = await this.prisma.serverInstance.findFirst({
          where: { id: allocated.serverInstanceId, scope: 'PLATFORM_MANAGED' },
        });
        if (
          managed &&
          (managed.status === 'READY' ||
            managed.status === 'RUNNING' ||
            managed.dockerStatus === 'READY') &&
          managed.status !== 'FAILED'
        ) {
          readyServer = managed;
          platformManaged = true;
        }
      }
    }

    const serviceInstances = await this.prisma.serviceInstance.findMany({
      where: { projectId, environmentId },
      orderBy: { updatedAt: 'desc' },
    });
    const liveUnitIds = new Set(
      serviceInstances
        .filter((service) => service.status === 'RUNNING' && service.deployableUnitId)
        .map((service) => service.deployableUnitId as string),
    );
    // First-time / incomplete multi-unit launch must keep WEB+API together.
    // Only narrow to currently-live units when every launchable unit is already live.
    const launchableUnits = units.filter(
      (unit) => unit.type === 'WEB' || unit.type === 'API' || unit.type === 'ADMIN',
    );
    const multiUnitIncomplete =
      launchableUnits.length > 0 &&
      launchableUnits.some((unit) => !liveUnitIds.has(unit.id));
    const plannedUnits =
      liveUnitIds.size > 0 && !multiUnitIncomplete
        ? units.filter((unit) => liveUnitIds.has(unit.id))
        : units;
    if (liveUnitIds.size > 0 && !multiUnitIncomplete) {
      requiresPg = plannedUnits.some((unit) => unit.requiresPostgresql);
      requiresRedis = plannedUnits.some((unit) => unit.requiresRedis);
      if (!requiresPg) pgStatus = 'NOT_REQUIRED';
      if (!requiresRedis) redisStatus = 'NOT_REQUIRED';
    }
    const deployments = await this.prisma.deployment.findMany({
      where: { projectId, environmentId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        deployableUnitId: true,
        status: true,
        artifacts: { select: { id: true, status: true }, take: 1, orderBy: { createdAt: 'desc' } },
      },
    });
    const gatewayRoutes = await this.prisma.gatewayRoute.findMany({
      where: { projectId },
    });

    const analysis = await this.prisma.projectAnalysis.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    const declaredUnits = plannedUnits.map((unit) => {
      const si = serviceInstances.find((s) => s.deployableUnitId === unit.id);
      const route = gatewayRoutes.find((g) => g.unitId === unit.id);
      const dep = deployments.find((d) => d.deployableUnitId === unit.id);
      const art = dep?.artifacts[0];
      return {
        unitId: unit.id,
        type: unit.type,
        artifactReady: Boolean(art) || Boolean(si),
        artifactId: art?.id ?? null,
        serviceStatus: si?.status ?? null,
        healthStatus: si?.healthStatus ?? null,
        serviceInstanceId: si?.id ?? null,
        gatewayStatus: route?.status ?? null,
        gatewayHostname: route?.hostname ?? null,
        dnsStatus: route?.status === 'ACTIVE' ? 'ACTIVE' : null,
        certificateValid: route?.status === 'ACTIVE' ? true : null,
      };
    });

    const allRoutesActive =
      gatewayRoutes.length > 0 &&
      units
        .filter((u) => plannedUnits.some((unit) => unit.id === u.id))
        .every((u) => gatewayRoutes.some((g) => g.unitId === u.id && g.status === 'ACTIVE'));

    const declared: DeclaredWorldState = {
      analysisReady: Boolean(analysis) || project.deployableUnits.length > 0,
      postgresql: {
        required: requiresPg,
        status: pgStatus,
        connectionId: pgConnectionId,
      },
      redis: {
        required: requiresRedis,
        status: redisStatus,
        connectionId: redisConnectionId,
      },
      server: readyServer
        ? {
            id: readyServer.id,
            status: readyServer.status,
            dockerStatus: readyServer.dockerStatus,
            compatible: true,
          }
        : null,
      units: declaredUnits,
      accessEntryStatus: allRoutesActive ? 'ACTIVE' : null,
    };

    return {
      planInput: {
        projectId,
        environmentId,
        units: plannedUnits,
        declared,
        observed: observedOverride ?? (platformManaged ? { serverObservedReady: true } : null),
        planVersion: LAUNCH_PLAN_VERSION,
      },
    };
  }

  private toPlanSnapshot(plan: LaunchPlanResult) {
    const primaryDeployableUnitId =
      plan.steps.find((s) => s.unitId && (s.stepType.includes('WEB') || s.stepType === 'BUILD_UNIT'))
        ?.unitId ??
      plan.steps.find((s) => s.unitId)?.unitId ??
      null;
    return {
      stages: plan.stages,
      resourcesToReuse: plan.resourcesToReuse,
      resourcesToCreate: plan.resourcesToCreate,
      billableActions: plan.billableActions,
      requiresConfirmation: plan.requiresConfirmation,
      estimatedCostAvailable: plan.estimatedCostAvailable,
      executionSteps: plan.executionSteps,
      reuseSteps: plan.reuseSteps,
      skipSteps: plan.skipSteps,
      blockers: plan.blockers,
      canLaunch: plan.canLaunch,
      currentDesiredStateSatisfied: plan.currentDesiredStateSatisfied,
      progress: plan.progress,
      desiredState: plan.desiredState,
      primaryDeployableUnitId,
    };
  }

  private toPublicPlanResponse(
    launchRunId: string,
    plan: LaunchPlanResult,
    extra: Record<string, unknown>,
  ) {
    return {
      launchRunId,
      projectId: plan.projectId,
      environmentId: plan.environmentId,
      launchRunStatus:
        plan.suggestedRunStatus === 'WAITING_CONFIRMATION'
          ? 'WAITING_CONFIRMATION'
          : 'READY',
      status:
        plan.suggestedRunStatus === 'WAITING_CONFIRMATION'
          ? 'WAITING_CONFIRMATION'
          : 'READY',
      planVersion: plan.planVersion,
      stages: plan.stages,
      dependenciesReady: plan.dependenciesReady,
      serverReady: plan.serverReady,
      apiReady: plan.apiReady,
      webReady: plan.webReady,
      publicEntryReady: plan.publicEntryReady,
      resourcesToReuse: plan.resourcesToReuse,
      resourcesToCreate: plan.resourcesToCreate,
      billableActions: plan.billableActions,
      requiresConfirmation: plan.requiresConfirmation,
      estimatedCostAvailable: plan.estimatedCostAvailable,
      executionSteps: plan.executionSteps,
      reuseSteps: plan.reuseSteps,
      skipSteps: plan.skipSteps,
      currentDesiredStateSatisfied: plan.currentDesiredStateSatisfied,
      canLaunch: plan.canLaunch,
      blockers: plan.blockers,
      progress: plan.progress,
      desiredState: plan.desiredState,
      steps: plan.steps.map((s) => ({
        stepType: s.stepType,
        stage: s.stage,
        decision: s.decision,
        reasonZh: s.reasonZh,
        billable: s.billable,
        requiresConfirmation: s.requiresConfirmation,
        unitId: s.unitId,
      })),
      realExecutionLocked: true,
      confirmDisabledReasonZh: '上线执行器已准备，真实执行暂未开放',
      ...extra,
    };
  }

  private emitSafe(event: string, metadata: Record<string, unknown>) {
    try {
      assertLaunchEventSafe(metadata);
      // eslint-disable-next-line no-console
      console.info(`[launch-audit] ${event}`, metadata);
    } catch {
      // eslint-disable-next-line no-console
      console.warn(`[launch-audit] dropped unsafe event ${event}`);
    }
  }
}
