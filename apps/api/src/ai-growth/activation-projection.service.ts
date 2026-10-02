import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@launchos/database';
import { PrismaService } from '../database/prisma.service';
import { UserActivationScoreService } from './user-activation-score.service';
import {
  ACTIVATION_STAGES,
  maxStage,
  ONBOARDING_THRESHOLDS,
  stageRank,
  type ActivationStage,
} from './onboarding-thresholds';

type DerivedFacts = {
  workspaceId: string | null;
  projectId: string | null;
  stage: ActivationStage;
  firstProjectAt: Date | null;
  firstDeployStartedAt: Date | null;
  firstDeploySucceededAt: Date | null;
  firstPublicSuccessAt: Date | null;
  lastProgressAt: Date | null;
  missingRequiredConfig: boolean;
  preflightHigh: boolean;
  failedDeployCount: number;
  primaryBlocker: string | null;
  blockerCategory:
    | 'SOURCE'
    | 'CONFIG'
    | 'PREFLIGHT'
    | 'BUILD'
    | 'RUNTIME'
    | 'DOMAIN'
    | 'PERMISSION'
    | 'QUOTA'
    | 'UNKNOWN'
    | null;
};

@Injectable()
export class ActivationProjectionService {
  private readonly logger = new Logger(ActivationProjectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly score: UserActivationScoreService,
  ) {}

  async ensureState(userId: string) {
    const existing = await this.prisma.userActivationState.findUnique({ where: { userId } });
    if (existing) return existing;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, createdAt: true },
    });
    if (!user) return null;
    return this.prisma.userActivationState.create({
      data: {
        userId,
        currentStage: 'REGISTERED',
        status: 'NOT_STARTED',
        activationScore: 10,
        lastProgressAt: user.createdAt,
        scoreExplanationJson: ['注册基础分 10'] as Prisma.InputJsonValue,
      },
    });
  }

  async projectUser(userId: string) {
    const facts = await this.deriveFacts(userId);
    if (!facts) return null;

    const hoursSinceProgress =
      facts.lastProgressAt != null
        ? (Date.now() - facts.lastProgressAt.getTime()) / 3600_000
        : null;

    let status:
      | 'NOT_STARTED'
      | 'IN_PROGRESS'
      | 'BLOCKED'
      | 'AT_RISK'
      | 'ACTIVATED'
      | 'DORMANT' = 'IN_PROGRESS';

    if (facts.stage === 'REGISTERED' && !facts.projectId) status = 'NOT_STARTED';
    if (facts.stage === 'ACTIVATED' || facts.stage === 'PUBLIC_ENTRY_READY') {
      // PUBLIC_ENTRY_READY maps to activated status
      status = 'ACTIVATED';
      if (facts.stage === 'PUBLIC_ENTRY_READY') {
        facts.stage = 'ACTIVATED';
      }
    }

    const hardBlocked =
      facts.preflightHigh ||
      facts.missingRequiredConfig ||
      facts.failedDeployCount >= ONBOARDING_THRESHOLDS.consecutiveFailuresForBlocked ||
      (facts.blockerCategory === 'DOMAIN' && stageRank(facts.stage) >= stageRank('FIRST_DEPLOY_SUCCEEDED'));

    if (status !== 'ACTIVATED') {
      if (hardBlocked && facts.primaryBlocker) status = 'BLOCKED';
      else if (this.isAtRisk(facts, hoursSinceProgress)) status = 'AT_RISK';
      else if (
        hoursSinceProgress != null &&
        hoursSinceProgress >= ONBOARDING_THRESHOLDS.hoursInactiveForDormant &&
        stageRank(facts.stage) < stageRank('FIRST_DEPLOY_SUCCEEDED')
      ) {
        status = 'DORMANT';
      }
    }

    const scored = this.score.calculateFromFacts({
      stage: facts.stage,
      status,
      primaryBlocker: facts.primaryBlocker,
      blockerCategory: facts.blockerCategory,
      failedDeployCount: facts.failedDeployCount,
      hoursSinceProgress,
      missingRequiredConfig: facts.missingRequiredConfig,
      preflightHigh: facts.preflightHigh,
      projectId: facts.projectId,
    });

    const activatedAt =
      status === 'ACTIVATED'
        ? facts.firstPublicSuccessAt || facts.firstDeploySucceededAt || new Date()
        : null;

    const state = await this.prisma.userActivationState.upsert({
      where: { userId },
      create: {
        userId,
        workspaceId: facts.workspaceId,
        projectId: facts.projectId,
        currentStage: facts.stage,
        status,
        activatedAt,
        firstProjectAt: facts.firstProjectAt,
        firstDeployStartedAt: facts.firstDeployStartedAt,
        firstDeploySucceededAt: facts.firstDeploySucceededAt,
        firstPublicSuccessAt: facts.firstPublicSuccessAt,
        lastProgressAt: facts.lastProgressAt,
        blockedSince: status === 'BLOCKED' ? facts.lastProgressAt || new Date() : null,
        primaryBlocker: status === 'ACTIVATED' ? null : facts.primaryBlocker,
        blockerCategory: status === 'ACTIVATED' ? null : facts.blockerCategory,
        activationScore: scored.score,
        scoreExplanationJson: scored.explanation as Prisma.InputJsonValue,
      },
      update: {
        workspaceId: facts.workspaceId,
        projectId: facts.projectId,
        currentStage: facts.stage,
        status,
        activatedAt,
        firstProjectAt: facts.firstProjectAt,
        firstDeployStartedAt: facts.firstDeployStartedAt,
        firstDeploySucceededAt: facts.firstDeploySucceededAt,
        firstPublicSuccessAt: facts.firstPublicSuccessAt,
        lastProgressAt: facts.lastProgressAt,
        blockedSince:
          status === 'BLOCKED'
            ? undefined // keep existing if already set via raw query below
            : null,
        primaryBlocker: status === 'ACTIVATED' ? null : facts.primaryBlocker,
        blockerCategory: status === 'ACTIVATED' ? null : facts.blockerCategory,
        activationScore: scored.score,
        scoreExplanationJson: scored.explanation as Prisma.InputJsonValue,
      },
    });

    if (status === 'BLOCKED' && !state.blockedSince) {
      await this.prisma.userActivationState.update({
        where: { id: state.id },
        data: { blockedSince: new Date() },
      });
    }

    await this.upsertStepProgress(userId, facts);

    // Soft sync lifecycle tags (facts vs tags)
    await this.syncLifecycleTags(userId, status).catch((error) => {
      this.logger.warn(`syncLifecycleTags: ${error instanceof Error ? error.message : 'unknown'}`);
    });

    return this.prisma.userActivationState.findUnique({ where: { userId } });
  }

  private isAtRisk(facts: DerivedFacts, hoursSinceProgress: number | null): boolean {
    if (hoursSinceProgress == null) return false;
    if (
      facts.stage === 'PROJECT_CREATED' &&
      hoursSinceProgress >= ONBOARDING_THRESHOLDS.hoursAfterProjectWithoutSource
    ) {
      return true;
    }
    if (
      stageRank(facts.stage) >= stageRank('SOURCE_CONNECTED') &&
      stageRank(facts.stage) < stageRank('FIRST_DEPLOY_STARTED') &&
      hoursSinceProgress >= ONBOARDING_THRESHOLDS.hoursAfterSourceWithoutDeploy
    ) {
      return true;
    }
    if (
      facts.failedDeployCount >= 1 &&
      stageRank(facts.stage) === stageRank('FIRST_DEPLOY_STARTED') &&
      hoursSinceProgress >= ONBOARDING_THRESHOLDS.hoursAfterFailedDeployWithoutRetry
    ) {
      return true;
    }
    if (
      facts.preflightHigh &&
      hoursSinceProgress >= ONBOARDING_THRESHOLDS.hoursPreflightHighUnresolved
    ) {
      return true;
    }
    return false;
  }

  private async upsertStepProgress(userId: string, facts: DerivedFacts) {
    const reached = ACTIVATION_STAGES.filter((s) => stageRank(s) <= stageRank(facts.stage));
    for (const stage of reached) {
      const existing = await this.prisma.onboardingStepSnapshot.findFirst({
        where: { userId, stage, status: 'COMPLETED' },
        select: { id: true },
      });
      if (existing) continue;
      const at =
        stage === 'PROJECT_CREATED'
          ? facts.firstProjectAt
          : stage === 'FIRST_DEPLOY_STARTED'
            ? facts.firstDeployStartedAt
            : stage === 'FIRST_DEPLOY_SUCCEEDED'
              ? facts.firstDeploySucceededAt
              : stage === 'PUBLIC_ENTRY_READY' || stage === 'ACTIVATED'
                ? facts.firstPublicSuccessAt
                : facts.lastProgressAt;
      await this.prisma.onboardingStepSnapshot
        .create({
          data: {
            userId,
            workspaceId: facts.workspaceId,
            projectId: facts.projectId,
            stage,
            status: 'COMPLETED',
            enteredAt: at || new Date(),
            completedAt: at || new Date(),
            durationSeconds: 0,
            source: 'PROJECTION',
          },
        })
        .catch(async () => {
          // unique conflict — ignore (idempotent)
        });
    }

    if (facts.primaryBlocker && facts.blockerCategory && facts.stage !== 'ACTIVATED') {
      const blocked = await this.prisma.onboardingStepSnapshot.findFirst({
        where: { userId, stage: facts.stage, status: 'BLOCKED' },
        select: { id: true },
      });
      if (!blocked) {
        await this.prisma.onboardingStepSnapshot
          .create({
            data: {
              userId,
              workspaceId: facts.workspaceId,
              projectId: facts.projectId,
              stage: facts.stage,
              status: 'BLOCKED',
              blockerCategory: facts.blockerCategory,
              enteredAt: facts.lastProgressAt || new Date(),
              source: 'PROJECTION',
            },
          })
          .catch(() => undefined);
      }
    }
  }

  private async syncLifecycleTags(userId: string, status: string) {
    const desired: string[] = [];
    if (status === 'NOT_STARTED' || status === 'IN_PROGRESS' || status === 'AT_RISK') {
      desired.push('NEEDS_ONBOARDING');
    }
    if (status === 'BLOCKED') desired.push('DEPLOY_BLOCKED');
    if (status === 'AT_RISK') desired.push('ACTIVATION_AT_RISK');
    if (status === 'ACTIVATED') desired.push('ACTIVATED');

    const existing = await this.prisma.userTag.findMany({
      where: {
        userId,
        tag: { in: ['NEEDS_ONBOARDING', 'DEPLOY_BLOCKED', 'ACTIVATION_AT_RISK', 'ACTIVATED'] },
      },
    });

    for (const tag of desired) {
      if (existing.some((e) => e.tag === tag)) continue;
      await this.prisma.userTag
        .create({
          data: { userId, tag, source: 'SYSTEM' },
        })
        .catch(() => undefined);
    }
    for (const row of existing) {
      if (desired.includes(row.tag)) continue;
      // Keep ACTIVATED once set; clear transient tags when activated
      if (status === 'ACTIVATED' && row.tag !== 'ACTIVATED') {
        await this.prisma.userTag.delete({ where: { id: row.id } }).catch(() => undefined);
      }
    }
  }

  async deriveFacts(userId: string): Promise<DerivedFacts | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, createdAt: true },
    });
    if (!user) return null;

    const membership = await this.prisma.workspaceMember.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: { workspaceId: true, createdAt: true },
    });
    const owned = await this.prisma.workspace.findFirst({
      where: { ownerId: userId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, createdAt: true },
    });
    const workspaceId = membership?.workspaceId || owned?.id || null;

    const project = workspaceId
      ? await this.prisma.project.findFirst({
          where: { workspaceId },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            createdAt: true,
            sources: { select: { id: true }, take: 1 },
            configRequirements: {
              where: { required: true },
              select: {
                id: true,
                key: true,
                values: { select: { id: true }, take: 1 },
              },
              take: 30,
            },
            deploymentPreflights: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { status: true, riskLevel: true, createdAt: true },
            },
            deployments: {
              orderBy: { createdAt: 'asc' },
              take: 50,
              select: {
                id: true,
                status: true,
                createdAt: true,
                finishedAt: true,
                failureCode: true,
                usageClass: true,
              },
            },
            applicationDomains: {
              select: {
                id: true,
                status: true,
                dnsStatus: true,
                domain: true,
                createdAt: true,
              },
              take: 10,
            },
            projectAnalyses: {
              select: { id: true, createdAt: true },
              take: 1,
              orderBy: { createdAt: 'asc' },
            },
          },
        })
      : null;

    let stage: ActivationStage = 'REGISTERED';
    let lastProgressAt: Date | null = user.createdAt;
    const touch = (d: Date | null | undefined) => {
      if (d && (!lastProgressAt || d > lastProgressAt)) lastProgressAt = d;
    };

    if (workspaceId) {
      stage = maxStage(stage, 'WORKSPACE_READY');
      touch(membership?.createdAt || owned?.createdAt);
    }

    let firstProjectAt: Date | null = null;
    let firstDeployStartedAt: Date | null = null;
    let firstDeploySucceededAt: Date | null = null;
    let firstPublicSuccessAt: Date | null = null;
    let missingRequiredConfig = false;
    let preflightHigh = false;
    let failedDeployCount = 0;
    let primaryBlocker: string | null = null;
    let blockerCategory: DerivedFacts['blockerCategory'] = null;

    if (project) {
      firstProjectAt = project.createdAt;
      stage = maxStage(stage, 'PROJECT_CREATED');
      touch(project.createdAt);

      if (project.sources.length > 0) {
        stage = maxStage(stage, 'SOURCE_CONNECTED');
        touch(project.createdAt);
      } else {
        primaryBlocker = '尚未连接代码源';
        blockerCategory = 'SOURCE';
      }

      if (project.projectAnalyses.length > 0) {
        stage = maxStage(stage, 'ANALYSIS_COMPLETED');
        touch(project.projectAnalyses[0]?.createdAt);
      }

      const missing = project.configRequirements.filter((r) => r.values.length === 0);
      missingRequiredConfig = missing.length > 0;
      if (!missingRequiredConfig && project.sources.length > 0) {
        stage = maxStage(stage, 'CONFIG_COMPLETED');
      } else if (missingRequiredConfig && project.sources.length > 0) {
        primaryBlocker = `缺少运行配置（${missing
          .slice(0, 3)
          .map((m) => m.key)
          .join('、')}）`;
        blockerCategory = 'CONFIG';
      }

      const pf = project.deploymentPreflights[0];
      if (pf) {
        touch(pf.createdAt);
        if (pf.status === 'PASSED' || pf.riskLevel === 'LOW' || pf.riskLevel === 'MEDIUM') {
          if (!missingRequiredConfig) stage = maxStage(stage, 'PREFLIGHT_PASSED');
        }
        if (pf.riskLevel === 'HIGH' || pf.status === 'BLOCKED') {
          preflightHigh = true;
          primaryBlocker = '预检存在高风险项';
          blockerCategory = 'PREFLIGHT';
        }
      }

      const deploys = project.deployments;
      if (deploys.length > 0) {
        firstDeployStartedAt = deploys[0]!.createdAt;
        stage = maxStage(stage, 'FIRST_DEPLOY_STARTED');
        touch(deploys[0]!.createdAt);
      }

      // consecutive failures from the end until a success
      for (let i = deploys.length - 1; i >= 0; i--) {
        const d = deploys[i]!;
        if (d.status === 'FAILED') failedDeployCount += 1;
        else if (d.status === 'SUCCESS') break;
      }

      const firstSuccess = deploys.find((d) => d.status === 'SUCCESS');
      if (firstSuccess) {
        firstDeploySucceededAt = firstSuccess.finishedAt || firstSuccess.createdAt;
        stage = maxStage(stage, 'FIRST_DEPLOY_SUCCEEDED');
        touch(firstDeploySucceededAt);
      } else if (deploys.some((d) => d.status === 'FAILED')) {
        primaryBlocker = primaryBlocker || '首次部署失败';
        blockerCategory = blockerCategory || 'BUILD';
      }

      const publicDomain = project.applicationDomains.find(
        (d) => d.status === 'ACTIVE' && d.dnsStatus === 'ACTIVE',
      );
      const anyActive = project.applicationDomains.find((d) => d.status === 'ACTIVE');
      if (firstSuccess && publicDomain) {
        firstPublicSuccessAt = publicDomain.createdAt;
        if (firstDeploySucceededAt && firstPublicSuccessAt < firstDeploySucceededAt) {
          firstPublicSuccessAt = firstDeploySucceededAt;
        }
        stage = maxStage(stage, 'PUBLIC_ENTRY_READY');
        stage = maxStage(stage, 'ACTIVATED');
        touch(firstPublicSuccessAt);
        primaryBlocker = null;
        blockerCategory = null;
      } else if (firstSuccess && !publicDomain) {
        primaryBlocker = '公网入口尚未就绪';
        blockerCategory = 'DOMAIN';
        if (anyActive) touch(anyActive.createdAt);
      }
    }

    return {
      workspaceId,
      projectId: project?.id || null,
      stage,
      firstProjectAt,
      firstDeployStartedAt,
      firstDeploySucceededAt,
      firstPublicSuccessAt,
      lastProgressAt,
      missingRequiredConfig,
      preflightHigh,
      failedDeployCount,
      primaryBlocker,
      blockerCategory,
    };
  }
}
