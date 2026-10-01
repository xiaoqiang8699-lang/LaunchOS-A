import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  applyHealthCheckpoint,
  applyLaunchObservation,
  assertAlphaRecordSafe,
  bindAlphaProject,
  buildAlphaTimeline,
  buildModeratorChecklist,
  canSeeInternalTestRecords,
  classifyAlphaIssue,
  computeAlphaDurations,
  createAlphaSession,
  foldServiceHealth,
  healthFollowUpSchedule,
  isFirstWaveTesterScope,
  markAlphaUserStarted,
  recordAlphaDebrief,
  recordAlphaFriction,
  recordAlphaIntervention,
  submitAlphaFeedback,
  summarizeAlphaSessions,
  type AlphaDependencyTag,
  type AlphaFailureCause,
  type AlphaFrameworkTag,
  type AlphaHealthMark,
  type AlphaIssueSeverity,
  type AlphaProductEventName,
  type AlphaProjectType,
  type AlphaSessionState,
} from '@launchos/domain';
import { type AlphaTestSession, type Prisma } from '@launchos/database';
import { PrismaService } from '../database/prisma.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';

const PROJECT_TYPES = new Set(['WEB', 'API', 'WEB_API']);
const FRAMEWORKS = new Set(['VITE', 'NEXTJS', 'NODE', 'OTHER_SUPPORTED']);
const DEPENDENCIES = new Set(['POSTGRESQL', 'REDIS', 'NONE']);
const CATEGORIES = new Set([
  'SECURITY',
  'DATA_LEAK',
  'UNCONFIRMED_BILLING',
  'PRODUCTION_DAMAGE',
  'CANNOT_COMPLETE',
  'NEEDS_HELP',
  'EXPERIENCE',
  'SUGGESTION',
]);

function toState(row: AlphaTestSession): AlphaSessionState {
  return {
    id: row.id,
    userId: row.userId,
    projectId: row.projectId,
    launchRunId: row.launchRunId,
    sessionStatus: row.sessionStatus,
    projectType: row.projectType,
    framework: row.framework,
    dependencies: row.dependencies,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    launchSucceeded: row.launchSucceeded,
    totalDurationMs: row.totalDurationMs,
    blockedStage: row.blockedStage,
    blockedStep: row.blockedStep,
    manualInterventionCount: row.manualInterventionCount,
    primaryFailureCode: row.primaryFailureCode,
    publicUrl: row.publicUrl,
    health10m: row.health10m,
    health1h: row.health1h,
    health24h: row.health24h,
    sessionStartedAt: row.sessionStartedAt?.toISOString() ?? null,
    planCreatedAt: row.planCreatedAt?.toISOString() ?? null,
    launchStartedAt: row.launchStartedAt?.toISOString() ?? null,
    launchCompletedAt: row.launchCompletedAt?.toISOString() ?? null,
    publicVerifiedAt: row.publicVerifiedAt?.toISOString() ?? null,
    knewNextStep: row.knewNextStep,
    billingClear: row.billingClear,
    failureUnderstandable: row.failureUnderstandable,
    neededHelp: row.neededHelp,
    wouldContinue: row.wouldContinue,
    freeFeedback: row.freeFeedback,
  };
}

function toPersistence(session: AlphaSessionState): Prisma.AlphaTestSessionUncheckedUpdateInput {
  return {
    projectId: session.projectId,
    launchRunId: session.launchRunId,
    sessionStatus: session.sessionStatus,
    projectType: session.projectType,
    framework: session.framework,
    dependencies: session.dependencies,
    startedAt: session.startedAt ? new Date(session.startedAt) : null,
    completedAt: session.completedAt ? new Date(session.completedAt) : null,
    launchSucceeded: session.launchSucceeded,
    totalDurationMs: session.totalDurationMs,
    blockedStage: session.blockedStage,
    blockedStep: session.blockedStep,
    manualInterventionCount: session.manualInterventionCount,
    primaryFailureCode: session.primaryFailureCode,
    publicUrl: session.publicUrl,
    health10m: session.health10m,
    health1h: session.health1h,
    health24h: session.health24h,
    sessionStartedAt: session.sessionStartedAt ? new Date(session.sessionStartedAt) : null,
    planCreatedAt: session.planCreatedAt ? new Date(session.planCreatedAt) : null,
    launchStartedAt: session.launchStartedAt ? new Date(session.launchStartedAt) : null,
    launchCompletedAt: session.launchCompletedAt ? new Date(session.launchCompletedAt) : null,
    publicVerifiedAt: session.publicVerifiedAt ? new Date(session.publicVerifiedAt) : null,
    knewNextStep: session.knewNextStep,
    billingClear: session.billingClear,
    failureUnderstandable: session.failureUnderstandable,
    neededHelp: session.neededHelp,
    wouldContinue: session.wouldContinue,
    freeFeedback: session.freeFeedback,
  };
}

@Injectable()
export class AlphaTestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaceAccess: WorkspaceAccessService,
  ) {}

  async list(userId: string) {
    const workspaceId = await this.requireInternal(userId);
    const rows = await this.prisma.alphaTestSession.findMany({
      where: { user: { memberships: { some: { workspaceId } } } },
      include: { project: { select: { id: true, name: true } }, interventions: { select: { severity: true, resolved: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const states = rows.map((row) => toState(row));
    const issues = rows.flatMap((row) =>
      row.interventions
        .filter((item): item is { severity: AlphaIssueSeverity; resolved: boolean } => item.severity != null)
        .map((item) => ({ severity: item.severity, resolved: item.resolved })),
    );
    return {
      summary: summarizeAlphaSessions(states, issues),
      sessions: rows.map((row) => ({
        id: row.id,
        projectId: row.projectId,
        projectName: row.project?.name ?? null,
        projectType: row.projectType,
        sessionStatus: row.sessionStatus,
        launchSucceeded: row.launchSucceeded,
        totalDurationMs: row.totalDurationMs,
        manualInterventionCount: row.manualInterventionCount,
        primaryFailureCode: row.primaryFailureCode,
        blockedStage: row.blockedStage,
        publicUrl: row.publicUrl,
        health24h: row.health24h,
        createdAt: row.createdAt,
      })),
    };
  }

  async get(userId: string, sessionId: string) {
    await this.requireInternal(userId);
    const row = await this.prisma.alphaTestSession.findUnique({
      where: { id: sessionId },
      include: {
        project: { select: { name: true } },
        interventions: { orderBy: { createdAt: 'asc' } },
        events: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!row) throw new NotFoundException('测试记录不存在');
    const state = toState(row);
    const debriefEvent = [...row.events].reverse().find((event) => event.name === 'ALPHA_DEBRIEF_RECORDED');
    return {
      session: state,
      projectName: row.project?.name ?? null,
      firstWave: isFirstWaveTesterScope({
        projectType: state.projectType,
        framework: state.framework,
        dependencies: state.dependencies,
      }),
      checklist: buildModeratorChecklist(state),
      healthFollowUp: healthFollowUpSchedule(state.publicVerifiedAt ?? state.launchCompletedAt),
      durations: computeAlphaDurations(state),
      timeline: buildAlphaTimeline(state, row.interventions.map((item) => item.stage)),
      frictions: row.events
        .filter((event) => event.name === 'ALPHA_FRICTION_NOTED')
        .map((event) => ({ id: event.id, createdAt: event.createdAt, ...(event.metadata as object) })),
      debrief: debriefEvent ? debriefEvent.metadata : null,
      interventions: row.interventions.map((item) => ({
        id: item.id,
        stage: item.stage,
        reason: item.reason,
        actionTaken: item.actionTaken,
        resolved: item.resolved,
        severity: item.severity,
        createdAt: item.createdAt,
      })),
      feedback: {
        knewNextStep: row.knewNextStep,
        billingClear: row.billingClear,
        failureUnderstandable: row.failureUnderstandable,
        neededHelp: row.neededHelp,
        wouldContinue: row.wouldContinue,
        freeFeedback: row.freeFeedback,
        submittedAt: row.feedbackSubmittedAt,
      },
    };
  }

  async create(
    userId: string,
    body: {
      projectId?: string;
      projectType?: string;
      framework?: string;
      dependencies?: string;
    },
  ) {
    await this.requireInternal(userId);
    if (body.projectId) await this.workspaceAccess.requireProjectAccess(userId, body.projectId);
    const tags = this.tags(body);
    const created = createAlphaSession({
      id: 'pending',
      userId,
      now: new Date().toISOString(),
      projectId: body.projectId ?? null,
      ...tags,
    });
    const row = await this.prisma.alphaTestSession.create({
      data: {
        userId,
        projectId: created.session.projectId,
        sessionStatus: created.session.sessionStatus,
        projectType: created.session.projectType,
        framework: created.session.framework,
        dependencies: created.session.dependencies,
        startedAt: null,
        sessionStartedAt: null,
      },
    });
    await this.recordEvents(row.id, row.userId, row.projectId, created.events, { sessionId: row.id });
    return { id: row.id, sessionStatus: row.sessionStatus };
  }

  async bindProject(
    userId: string,
    sessionId: string,
    body: { projectId: string; projectType?: string; framework?: string; dependencies?: string },
  ) {
    await this.requireInternal(userId);
    await this.workspaceAccess.requireProjectAccess(userId, body.projectId);
    const row = await this.requireSession(sessionId);
    const tags = this.tags(body);
    const next = bindAlphaProject(toState(row), { projectId: body.projectId, ...tags });
    await this.prisma.alphaTestSession.update({ where: { id: sessionId }, data: toPersistence(next) });
    return { id: sessionId, projectId: body.projectId, sessionStatus: next.sessionStatus, launchRunId: next.launchRunId };
  }

  async markStarted(userId: string, sessionId: string) {
    await this.requireInternal(userId);
    const row = await this.requireSession(sessionId);
    const next = markAlphaUserStarted(toState(row), new Date().toISOString());
    if (next.events.length > 0) {
      await this.prisma.alphaTestSession.update({ where: { id: sessionId }, data: toPersistence(next.session) });
      await this.recordEvents(sessionId, row.userId, row.projectId, next.events, { sessionId });
    }
    return { sessionStatus: next.session.sessionStatus, startedAt: next.session.startedAt };
  }

  async addFriction(userId: string, sessionId: string, body: { stage: string; note: string }) {
    await this.requireInternal(userId);
    const row = await this.requireSession(sessionId);
    const stage = body.stage?.trim();
    const note = body.note?.trim();
    if (!stage || !note) throw new BadRequestException('请填写阶段和观察到的卡住');
    try {
      recordAlphaFriction(toState(row), { stage, note });
    } catch {
      throw new BadRequestException('不能保存包含密钥的内容');
    }
    await this.recordEvents(sessionId, row.userId, row.projectId, ['ALPHA_FRICTION_NOTED'], {
      stage,
      note,
      classification: 'P1',
    });
    return { manualInterventionCount: row.manualInterventionCount };
  }

  /**
   * External Alpha P1 — Deployment failure gives no actionable reason.
   * Records friction against the latest open session for the given project when possible.
   */
  async noteDeploymentFailureDiagnosisP1(input: {
    userId: string;
    projectId: string;
    launchRunId: string;
    failureStage: string;
    failureCategory: string;
    userBlocked?: boolean;
  }) {
    let row = await this.prisma.alphaTestSession.findFirst({
      where: {
        userId: input.userId,
        projectId: input.projectId,
        sessionStatus: { in: ['PLANNED', 'IN_PROGRESS'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) {
      row = await this.prisma.alphaTestSession.findFirst({
        where: {
          projectId: input.projectId,
          sessionStatus: { in: ['PLANNED', 'IN_PROGRESS'] },
        },
        orderBy: { createdAt: 'desc' },
      });
    }
    if (!row) {
      row = await this.prisma.alphaTestSession.create({
        data: {
          userId: input.userId,
          projectId: input.projectId,
          sessionStatus: 'IN_PROGRESS',
          projectType: 'WEB',
          framework: 'OTHER_SUPPORTED',
          dependencies: 'NONE',
          startedAt: new Date(),
          sessionStartedAt: new Date(),
          launchRunId: input.launchRunId,
        },
      });
    }
    await this.recordEvents(row.id, row.userId, row.projectId, ['ALPHA_FRICTION_NOTED'], {
      stage: 'DEPLOYMENT_FAILURE_UX',
      note: 'External Alpha P1 — Deployment failure gives no actionable reason',
      classification: 'P1',
      session: row.id,
      project: input.projectId,
      launchRun: input.launchRunId,
      failureStage: input.failureStage,
      failureCategory: input.failureCategory,
      userBlocked: input.userBlocked !== false,
    });
    return {
      sessionId: row.id,
      projectId: input.projectId,
      launchRunId: input.launchRunId,
      failureStage: input.failureStage,
      failureCategory: input.failureCategory,
      userBlocked: input.userBlocked !== false,
    };
  }

  /** Record known External Alpha P1 source-connection frictions on the latest open session. */
  async noteSourceConnectionP1Frictions(userId: string) {
    await this.requireInternal(userId);
    let row = await this.prisma.alphaTestSession.findFirst({
      where: {
        sessionStatus: { in: ['PLANNED', 'IN_PROGRESS'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) {
      row = await this.prisma.alphaTestSession.create({
        data: {
          userId,
          sessionStatus: 'IN_PROGRESS',
          projectType: 'WEB',
          framework: 'OTHER_SUPPORTED',
          dependencies: 'NONE',
          startedAt: new Date(),
          sessionStartedAt: new Date(),
        },
      });
    }
    const notes = [
      {
        stage: 'CONNECT_GITHUB',
        note: 'GitHub 授权完成后未自动返回 LaunchOS，用户无法判断下一步。',
      },
      {
        stage: 'ONBOARDING_HOME',
        note: '首次入口同时出现创建应用和连接 GitHub，动作优先级不清晰',
      },
      {
        stage: 'SOURCE_SELECTION',
        note: '代码来源缺少本地上传入口',
      },
    ];
    for (const item of notes) {
      await this.recordEvents(row.id, row.userId, row.projectId, ['ALPHA_FRICTION_NOTED'], {
        ...item,
        classification: 'P1',
      });
    }
    return { recorded: notes.length, sessionId: row.id };
  }

  async recordDebrief(
    userId: string,
    sessionId: string,
    body: {
      biggestFriction: string;
      confusingCopy: string;
      explainedTechnicalConcept: boolean;
      viewedTechnicalDetails: boolean;
      failureCause?: string | null;
    },
  ) {
    await this.requireInternal(userId);
    const row = await this.requireSession(sessionId);
    const failureCause = body.failureCause ? (body.failureCause as AlphaFailureCause) : null;
    let recorded;
    try {
      recorded = recordAlphaDebrief({
        biggestFriction: body.biggestFriction?.trim() ?? '',
        confusingCopy: body.confusingCopy?.trim() ?? '',
        explainedTechnicalConcept: Boolean(body.explainedTechnicalConcept),
        viewedTechnicalDetails: Boolean(body.viewedTechnicalDetails),
        failureCause,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      throw new BadRequestException(message.includes('根因') ? '失败根因无效' : '不能保存包含密钥的内容');
    }
    await this.recordEvents(sessionId, row.userId, row.projectId, recorded.events, { ...recorded.debrief });
    return { recorded: true };
  }

  async addIntervention(
    userId: string,
    sessionId: string,
    body: { stage: string; reason: string; actionTaken: string; category?: string; resolved?: boolean },
  ) {
    await this.requireInternal(userId);
    const row = await this.requireSession(sessionId);
    const stage = body.stage?.trim();
    const reason = body.reason?.trim();
    const actionTaken = body.actionTaken?.trim();
    if (!stage || !reason || !actionTaken) throw new BadRequestException('请填写阶段、原因和做了什么');
    let next;
    try {
      next = recordAlphaIntervention(toState(row), { stage, reason, actionTaken, resolved: body.resolved });
    } catch {
      throw new BadRequestException('不能保存包含密钥的内容');
    }
    const severity = body.category && CATEGORIES.has(body.category) ? classifyAlphaIssue(body.category) : null;
    await this.prisma.$transaction([
      this.prisma.alphaIntervention.create({
        data: { sessionId, stage, reason, actionTaken, resolved: Boolean(body.resolved), severity },
      }),
      this.prisma.alphaTestSession.update({
        where: { id: sessionId },
        data: { manualInterventionCount: next.session.manualInterventionCount },
      }),
    ]);
    await this.recordEvents(sessionId, row.userId, row.projectId, next.events, { stage, severity });
    return { manualInterventionCount: next.session.manualInterventionCount, severity };
  }

  async submitFeedback(
    userId: string,
    sessionId: string,
    body: {
      knewNextStep: number;
      billingClear: number;
      failureUnderstandable: number;
      neededHelp: number;
      wouldContinue: number;
      freeFeedback?: string;
    },
  ) {
    await this.requireInternal(userId);
    const row = await this.requireSession(sessionId);
    let next;
    try {
      next = submitAlphaFeedback(toState(row), body);
    } catch (error) {
      const message = error instanceof Error && !error.message.includes('launch event') ? error.message : '不能保存包含密钥的内容';
      throw new BadRequestException(message.includes('1 到 5') ? message : '不能保存包含密钥的内容');
    }
    await this.prisma.alphaTestSession.update({
      where: { id: sessionId },
      data: {
        ...toPersistence(next.session),
        feedbackSubmittedAt: new Date(),
      },
    });
    await this.recordEvents(sessionId, row.userId, row.projectId, next.events, { sessionId });
    return { submitted: true };
  }

  async checkHealth(userId: string, sessionId: string) {
    await this.requireInternal(userId);
    const row = await this.requireSession(sessionId);
    const mark = await this.currentHealth(row.projectId, row.publicUrl);
    const applied = applyHealthCheckpoint(toState(row), { now: new Date().toISOString(), mark });
    if (applied.recorded.length > 0) {
      await this.prisma.alphaTestSession.update({ where: { id: sessionId }, data: toPersistence(applied.session) });
      await this.recordEvents(sessionId, row.userId, row.projectId, applied.events, {
        mark,
        checkpoints: applied.recorded.join(','),
      });
    }
    return { mark, recorded: applied.recorded, health10m: applied.session.health10m, health1h: applied.session.health1h, health24h: applied.session.health24h };
  }

  async observeLaunch(input: {
    userId: string;
    projectId: string;
    kind: 'PLAN_CREATED' | 'LAUNCH_STARTED' | 'LAUNCH_FINISHED';
    launchRunId: string;
    status?: string | null;
    at?: Date;
    failureCode?: string | null;
    failedStage?: string | null;
    failedStep?: string | null;
    publicUrl?: string | null;
  }): Promise<void> {
    const row = await this.prisma.alphaTestSession.findFirst({
      where: {
        userId: input.userId,
        projectId: input.projectId,
        sessionStatus: { in: ['PLANNED', 'IN_PROGRESS'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) return;
    let publicUrl = input.publicUrl ?? null;
    if (input.kind === 'LAUNCH_FINISHED' && input.status === 'SUCCESS' && !publicUrl) {
      const route = await this.prisma.gatewayRoute.findFirst({
        where: { projectId: input.projectId, status: 'ACTIVE' },
        select: { hostname: true },
      });
      publicUrl = route ? `https://${route.hostname}` : null;
    }
    const applied = applyLaunchObservation(toState(row), {
      kind: input.kind,
      launchRunId: input.launchRunId,
      at: (input.at ?? new Date()).toISOString(),
      status: input.status,
      failureCode: input.failureCode,
      failedStage: input.failedStage,
      failedStep: input.failedStep,
      publicUrl,
    });
    await this.prisma.alphaTestSession.update({ where: { id: row.id }, data: toPersistence(applied.session) });
    await this.recordEvents(row.id, row.userId, row.projectId, applied.events, {
      launchRunId: input.launchRunId,
      status: input.status ?? input.kind,
    });
  }

  private async currentHealth(projectId: string | null, publicUrl: string | null): Promise<AlphaHealthMark> {
    if (publicUrl) {
      try {
        const response = await fetch(publicUrl, { signal: AbortSignal.timeout(8000) });
        return response.ok ? 'HEALTHY' : 'UNHEALTHY';
      } catch {
        // Fall through to the existing service health record.
      }
    }
    if (!projectId) return 'UNKNOWN';
    const instances = await this.prisma.serviceInstance.findMany({
      where: { projectId, status: 'RUNNING' },
      select: { healthStatus: true },
    });
    return foldServiceHealth(instances.map((instance) => instance.healthStatus));
  }

  private async recordEvents(
    sessionId: string,
    userId: string,
    projectId: string | null,
    names: AlphaProductEventName[],
    metadata: Record<string, unknown>,
  ) {
    assertAlphaRecordSafe(metadata);
    if (names.length === 0) return;
    await this.prisma.productEvent.createMany({
      data: names.map((name) => ({
        name,
        userId,
        projectId,
        sessionId,
        metadata: metadata as Prisma.InputJsonValue,
      })),
    });
  }

  private tags(body: { projectType?: string; framework?: string; dependencies?: string }): {
    projectType: AlphaProjectType | null;
    framework: AlphaFrameworkTag | null;
    dependencies: AlphaDependencyTag | null;
  } {
    if (body.projectType && !PROJECT_TYPES.has(body.projectType)) throw new BadRequestException('项目类型无效');
    if (body.framework && !FRAMEWORKS.has(body.framework)) throw new BadRequestException('框架标签无效');
    if (body.dependencies && !DEPENDENCIES.has(body.dependencies)) throw new BadRequestException('依赖标签无效');
    return {
      projectType: (body.projectType as AlphaProjectType | undefined) ?? null,
      framework: (body.framework as AlphaFrameworkTag | undefined) ?? null,
      dependencies: (body.dependencies as AlphaDependencyTag | undefined) ?? null,
    };
  }

  private async requireSession(sessionId: string) {
    const row = await this.prisma.alphaTestSession.findUnique({ where: { id: sessionId } });
    if (!row) throw new NotFoundException('测试记录不存在');
    return row;
  }

  private async requireInternal(userId: string): Promise<string> {
    const membership = await this.workspaceAccess.requireCurrentWorkspace(userId);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isInternal: true, platformRole: true },
    });
    if (
      !canSeeInternalTestRecords({
        platformRole: user?.platformRole ?? 'USER',
        isInternalTester: Boolean(user?.isInternal),
      })
    ) {
      throw new ForbiddenException('只有内部人员可以查看测试记录');
    }
    return membership.workspaceId;
  }
}
