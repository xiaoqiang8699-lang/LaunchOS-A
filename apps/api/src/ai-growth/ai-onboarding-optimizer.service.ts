import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@launchos/database';
import { PrismaService } from '../database/prisma.service';
import { AIProviderRouter } from './ai-provider';
import { redactText, sanitizeAiMetadata } from './ai-sanitize';
import { ActivationProjectionService } from './activation-projection.service';
import { ActivationBackfillService } from './activation-backfill.service';
import { UserActivationScoreService } from './user-activation-score.service';
import {
  ACTIVATION_STAGES,
  BLOCKER_LABELS,
  STAGE_LABELS,
  STATUS_LABELS,
  stageRank,
} from './onboarding-thresholds';

@Injectable()
export class AIOnboardingOptimizerService {
  private readonly logger = new Logger(AIOnboardingOptimizerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AIProviderRouter,
    private readonly projection: ActivationProjectionService,
    private readonly backfill: ActivationBackfillService,
    private readonly score: UserActivationScoreService,
  ) {}

  async analyzePlatformOnboarding(options?: { backfill?: boolean }) {
    if (options?.backfill !== false) {
      const count = await this.prisma.userActivationState.count();
      if (count < 5) {
        await this.backfill.backfillAll(500).catch((error) => {
          this.logger.warn(`auto-backfill: ${error instanceof Error ? error.message : 'unknown'}`);
        });
      }
    }

    const states = await this.prisma.userActivationState.findMany({
      take: 5000,
      select: {
        userId: true,
        status: true,
        currentStage: true,
        activatedAt: true,
        firstProjectAt: true,
        firstDeployStartedAt: true,
        firstDeploySucceededAt: true,
        firstPublicSuccessAt: true,
        primaryBlocker: true,
        blockerCategory: true,
        activationScore: true,
        lastProgressAt: true,
        createdAt: true,
        user: { select: { email: true, name: true, createdAt: true } },
      },
    });

    const registered = states.length || (await this.prisma.user.count());
    const funnel = ACTIVATION_STAGES.map((stage) => {
      const count = states.filter((s) => stageRank(s.currentStage) >= stageRank(stage)).length;
      return { stage, label: STAGE_LABELS[stage] || stage, count };
    });

    // Enrich funnel with conversion / dropoff
    const funnelWithRates = funnel.map((row, i) => {
      const prev = i === 0 ? registered : funnel[i - 1]!.count;
      const conversion = prev === 0 ? 0 : row.count / prev;
      const drop = Math.max(0, prev - row.count);
      const dropRate = prev === 0 ? 0 : drop / prev;
      return { ...row, conversion, drop, dropRate };
    });

    const maxDrop = funnelWithRates
      .slice(1)
      .sort((a, b) => b.dropRate - a.dropRate || b.drop - a.drop)[0];

    const activated = states.filter((s) => s.status === 'ACTIVATED').length;
    const blocked = states.filter((s) => s.status === 'BLOCKED').length;
    const activationRate = registered === 0 ? 0 : activated / registered;

    // First deployment success among users who started first deploy
    const startedFirst = states.filter((s) => s.firstDeployStartedAt != null);
    const firstSuccessUsers = states.filter((s) => s.firstDeploySucceededAt != null);
    const firstDeploymentSuccessRate =
      startedFirst.length === 0 ? 0 : firstSuccessUsers.length / startedFirst.length;

    // Align note with M7-7: M7-7 is deployment-attempt based; M7-8 is user-first-attempt based
    const m7Success = await this.prisma.deploymentSuccessSnapshot
      .findMany({
        take: 5000,
        select: { success: true, attemptCount: true },
      })
      .catch(() => [] as Array<{ success: boolean; attemptCount: number }>);
    const m7First = m7Success.filter((s) => s.attemptCount === 1);
    const m7FirstRate =
      m7First.length === 0 ? null : m7First.filter((s) => s.success).length / m7First.length;
    const m7AllRate =
      m7Success.length === 0 ? null : m7Success.filter((s) => s.success).length / m7Success.length;

    const ttfds = states
      .filter((s) => s.firstDeployStartedAt && s.user.createdAt)
      .map((s) => (s.firstDeployStartedAt!.getTime() - s.user.createdAt.getTime()) / 60_000);
    const ttfpss = states
      .filter((s) => s.firstPublicSuccessAt && s.user.createdAt)
      .map((s) => (s.firstPublicSuccessAt!.getTime() - s.user.createdAt.getTime()) / 60_000);

    const blockerCategories = aggregateBlockers(states);
    const recommendations = await this.generateOptimizationRecommendations({
      funnel: funnelWithRates,
      maxDrop,
      blockerCategories,
      activationRate,
      firstDeploymentSuccessRate,
      blocked,
    });

    const facts = JSON.stringify(
      sanitizeAiMetadata({
        activationRate: Number(activationRate.toFixed(3)),
        firstDeploymentSuccessRate: Number(firstDeploymentSuccessRate.toFixed(3)),
        maxDropStage: maxDrop?.stage || '',
        blocked,
        activated,
        registered,
      }),
    );
    const summary = await this.ai
      .generateText(
        `你是 LaunchOS 用户激活分析助手。用两三句中文总结激活漏斗与优先优化点，不要密钥，不要建议自动改代码/自动部署/自动营销。\nFACTS:\n${facts}`,
      )
      .catch(() => '');

    return {
      activationDefinition: 'FIRST_PUBLIC_DEPLOYMENT_SUCCESS',
      activationDefinitionNote:
        '需同时满足：已创建 Project、至少一次 Deployment 成功、Runtime 可达、Public Entry（域名 ACTIVE + DNS ACTIVE）可访问。',
      metrics: {
        registeredUsers: registered,
        activatedUsers: activated,
        activationRate,
        firstDeploymentSuccessRate,
        firstDeployStartedUsers: startedFirst.length,
        firstDeploySucceededUsers: firstSuccessUsers.length,
        publicSuccessUsers: states.filter((s) => s.firstPublicSuccessAt != null).length,
        blockedUsers: blocked,
        atRiskUsers: states.filter((s) => s.status === 'AT_RISK').length,
        medianTimeToFirstDeploymentMinutes: percentile(ttfds, 0.5),
        p75TimeToFirstDeploymentMinutes: percentile(ttfds, 0.75),
        p90TimeToFirstDeploymentMinutes: percentile(ttfds, 0.9),
        medianTimeToFirstPublicSuccessMinutes: percentile(ttfpss, 0.5),
        p75TimeToFirstPublicSuccessMinutes: percentile(ttfpss, 0.75),
        p90TimeToFirstPublicSuccessMinutes: percentile(ttfpss, 0.9),
        sampleNote:
          ttfds.length < 5 || ttfpss.length < 5 ? '样本不足，时长指标仅供参考' : null,
      },
      m7Comparison: {
        m7FirstDeploymentSuccessRate: m7FirstRate,
        m7AllDeploymentSuccessRate: m7AllRate,
        m8FirstDeploymentSuccessRate: firstDeploymentSuccessRate,
        note:
          'M7-7 按「部署尝试」统计首次/全部成功率；M7-8 按「用户是否完成首次部署成功」统计。口径不同，不必强行对齐。',
      },
      funnel: funnelWithRates,
      dropoff: maxDrop
        ? {
            stage: maxDrop.stage,
            label: maxDrop.label,
            drop: maxDrop.drop,
            dropRate: maxDrop.dropRate,
            message: `${maxDrop.label}（${maxDrop.stage}）是当前较大流失节点，相对上一步转化率 ${(maxDrop.conversion * 100).toFixed(1)}%。`,
          }
        : null,
      blockerCategories,
      recommendations,
      summary:
        redactText(summary).slice(0, 600) ||
        `激活率 ${(activationRate * 100).toFixed(1)}%，首次部署成功率（用户口径） ${(firstDeploymentSuccessRate * 100).toFixed(1)}%。`,
      note: '仅分析与建议，不会自动修改产品流程、用户项目或触发支付。',
    };
  }

  async analyzeUserActivation(userId: string) {
    const state = await this.projection.projectUser(userId);
    if (!state) throw new NotFoundException('User not found');

    const steps = await this.prisma.onboardingStepSnapshot.findMany({
      where: { userId },
      orderBy: [{ enteredAt: 'asc' }],
      take: 40,
    });

    const scored = this.score.calculateFromFacts({
      stage: state.currentStage,
      status: state.status,
      primaryBlocker: state.primaryBlocker,
      blockerCategory: state.blockerCategory,
      projectId: state.projectId,
    });

    const timeline = buildTimeline(state, steps);

    return {
      userId,
      stage: state.currentStage,
      stageLabel: STAGE_LABELS[state.currentStage] || state.currentStage,
      status: state.status,
      statusLabel: STATUS_LABELS[state.status] || state.status,
      score: state.activationScore,
      explanation: Array.isArray(state.scoreExplanationJson)
        ? state.scoreExplanationJson
        : scored.explanation,
      blockers: scored.blockers,
      primaryBlocker: state.primaryBlocker,
      blockerCategory: state.blockerCategory,
      blockerLabel: state.blockerCategory
        ? BLOCKER_LABELS[state.blockerCategory] || state.blockerCategory
        : null,
      nextActions: [scored.recommendedNextAction],
      timestamps: {
        firstProjectAt: state.firstProjectAt,
        firstDeployStartedAt: state.firstDeployStartedAt,
        firstDeploySucceededAt: state.firstDeploySucceededAt,
        firstPublicSuccessAt: state.firstPublicSuccessAt,
        activatedAt: state.activatedAt,
        lastProgressAt: state.lastProgressAt,
        blockedSince: state.blockedSince,
      },
      workspaceId: state.workspaceId,
      projectId: state.projectId,
      timeline,
      activated: state.status === 'ACTIVATED',
      progress: {
        completedSteps: Math.min(stageRank(state.currentStage) + 1, ACTIVATION_STAGES.length),
        totalSteps: ACTIVATION_STAGES.length,
      },
      note: '仅辅助继续完成流程，不会自动部署或修改项目。',
    };
  }

  async getCurrentUserActivation(userId: string) {
    return this.analyzeUserActivation(userId);
  }

  async getProjectActivation(userId: string, projectId: string) {
    const activation = await this.analyzeUserActivation(userId);
    return {
      ...activation,
      projectId,
      scopedNote: '激活状态按用户首次价值体验统计，不因多项目重置。',
    };
  }

  async listBlockedUsers(query: {
    page?: number;
    pageSize?: number;
    status?: string;
    stage?: string;
    blocker?: string;
    q?: string;
  }) {
    const page = Math.max(1, query.page || 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize || 20));
    const where: Prisma.UserActivationStateWhereInput = {
      status: query.status
        ? (query.status as never)
        : { in: ['BLOCKED', 'AT_RISK', 'IN_PROGRESS', 'DORMANT'] },
    };
    if (query.stage) where.currentStage = query.stage as never;
    if (query.blocker) where.blockerCategory = query.blocker as never;
    if (query.q) {
      where.user = {
        OR: [
          { email: { contains: query.q, mode: 'insensitive' } },
          { name: { contains: query.q, mode: 'insensitive' } },
        ],
      };
    }

    const [total, rows] = await Promise.all([
      this.prisma.userActivationState.count({ where }),
      this.prisma.userActivationState.findMany({
        where,
        orderBy: [{ status: 'asc' }, { lastProgressAt: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          user: { select: { id: true, email: true, name: true, lastLoginAt: true } },
        },
      }),
    ]);

    return {
      total,
      page,
      pageSize,
      items: rows.map((r) => ({
        userId: r.userId,
        email: r.user.email,
        name: r.user.name,
        workspaceId: r.workspaceId,
        projectId: r.projectId,
        stage: r.currentStage,
        stageLabel: STAGE_LABELS[r.currentStage] || r.currentStage,
        status: r.status,
        statusLabel: STATUS_LABELS[r.status] || r.status,
        primaryBlocker: r.primaryBlocker,
        blockerCategory: r.blockerCategory,
        blockerLabel: r.blockerCategory
          ? BLOCKER_LABELS[r.blockerCategory] || r.blockerCategory
          : null,
        activationScore: r.activationScore,
        lastProgressAt: r.lastProgressAt,
        blockedSince: r.blockedSince,
        stuckHours:
          r.lastProgressAt != null
            ? Math.round((Date.now() - r.lastProgressAt.getTime()) / 3600_000)
            : null,
      })),
    };
  }

  async generateOptimizationRecommendations(context?: {
    funnel?: Array<{ stage: string; label: string; count: number; drop: number; dropRate: number }>;
    maxDrop?: { stage: string; label: string; drop: number; dropRate: number; conversion: number } | null;
    blockerCategories?: Array<{ category: string; label: string; count: number }>;
    activationRate?: number;
    firstDeploymentSuccessRate?: number;
    blocked?: number;
  }) {
    const existing = await this.prisma.onboardingOptimizationRecommendation.findMany({
      where: { status: { in: ['OPEN', 'REVIEWED'] } },
      orderBy: [{ priority: 'desc' }, { affectedUsers: 'desc' }],
      take: 20,
    });
    if (existing.length >= 3 && !context) {
      return existing.map(presentRec);
    }

    const seeds: Array<{
      category:
        | 'SOURCE_FLOW'
        | 'CONFIG_FLOW'
        | 'PREFLIGHT'
        | 'DEPLOYMENT'
        | 'PUBLIC_ENTRY'
        | 'ONBOARDING_COPY'
        | 'DOCUMENTATION'
        | 'UNKNOWN';
      title: string;
      description: string;
      evidenceJson: Record<string, unknown>;
      affectedUsers: number;
      estimatedImpact: string;
      priority: 'LOW' | 'MEDIUM' | 'HIGH';
    }> = [];

    const topBlocker = context?.blockerCategories?.[0];
    if (topBlocker?.category === 'CONFIG') {
      seeds.push({
        category: 'CONFIG_FLOW',
        title: '强化创建后的运行配置引导',
        description: '多数未激活用户卡在必填环境变量。建议在创建应用后突出配置清单，并在 go-live 前拦截。',
        evidenceJson: { topBlocker },
        affectedUsers: topBlocker.count,
        estimatedImpact: '提升首次部署成功率与激活率',
        priority: 'HIGH',
      });
    }
    if (topBlocker?.category === 'BUILD' || topBlocker?.category === 'PREFLIGHT') {
      seeds.push({
        category: topBlocker.category === 'PREFLIGHT' ? 'PREFLIGHT' : 'DEPLOYMENT',
        title: topBlocker.category === 'PREFLIGHT' ? '降低预检高风险卡点' : '加强首次失败后的诊断引导',
        description: '将 Preflight / Copilot / Knowledge 结果更早展示在概览“继续完成上线”卡片。',
        evidenceJson: { topBlocker },
        affectedUsers: topBlocker.count,
        estimatedImpact: '提高失败后恢复率',
        priority: 'HIGH',
      });
    }
    if (context?.maxDrop && context.maxDrop.dropRate >= 0.2) {
      seeds.push({
        category: 'ONBOARDING_COPY',
        title: `优化 ${context.maxDrop.label} 阶段引导`,
        description: `该阶段相对上一步流失 ${(context.maxDrop.dropRate * 100).toFixed(1)}%，建议检查文案与 CTA 是否清晰。`,
        evidenceJson: { maxDrop: context.maxDrop },
        affectedUsers: context.maxDrop.drop,
        estimatedImpact: '降低最大流失节点掉队率',
        priority: 'MEDIUM',
      });
    }
    if ((context?.firstDeploymentSuccessRate ?? 1) < 0.5) {
      seeds.push({
        category: 'DEPLOYMENT',
        title: '提升首次部署成功率',
        description: '用户口径首次部署成功率偏低，建议复用 M7-5 预检与 M7-6 知识库降低首败。',
        evidenceJson: {
          firstDeploymentSuccessRate: context?.firstDeploymentSuccessRate,
        },
        affectedUsers: context?.blocked || 0,
        estimatedImpact: '提高 FIRST_PUBLIC_DEPLOYMENT_SUCCESS 占比',
        priority: 'HIGH',
      });
    }
    if (seeds.length === 0) {
      seeds.push({
        category: 'DOCUMENTATION',
        title: '持续观察激活漏斗',
        description: '当前无明显单一阻塞，建议定期回看漏斗与 Blocked Users。',
        evidenceJson: { activationRate: context?.activationRate },
        affectedUsers: 0,
        estimatedImpact: '保持运营可见性',
        priority: 'LOW',
      });
    }

    const out = [];
    for (const seed of seeds.slice(0, 8)) {
      const found = await this.prisma.onboardingOptimizationRecommendation.findFirst({
        where: { title: seed.title, status: { in: ['OPEN', 'REVIEWED'] } },
      });
      if (found) {
        out.push(presentRec(found));
        continue;
      }
      const created = await this.prisma.onboardingOptimizationRecommendation.create({
        data: {
          category: seed.category,
          scope: 'PLATFORM',
          title: seed.title,
          description: seed.description,
          evidenceJson: seed.evidenceJson as Prisma.InputJsonValue,
          affectedUsers: seed.affectedUsers,
          estimatedImpact: seed.estimatedImpact,
          priority: seed.priority,
          status: 'OPEN',
        },
      });
      out.push(presentRec(created));
    }
    return out;
  }

  async listRecommendations() {
    const rows = await this.prisma.onboardingOptimizationRecommendation.findMany({
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
      take: 50,
    });
    if (rows.length === 0) return this.generateOptimizationRecommendations();
    return rows.map(presentRec);
  }
}

function presentRec(row: {
  id: string;
  category: string;
  scope: string;
  title: string;
  description: string;
  evidenceJson: unknown;
  affectedUsers: number;
  estimatedImpact: string;
  priority: string;
  status: string;
  createdAt: Date;
}) {
  return {
    id: row.id,
    category: row.category,
    scope: row.scope,
    title: row.title,
    description: row.description,
    evidence: row.evidenceJson,
    affectedUsers: row.affectedUsers,
    estimatedImpact: row.estimatedImpact,
    priority: row.priority,
    status: row.status,
    createdAt: row.createdAt,
  };
}

function aggregateBlockers(
  states: Array<{ blockerCategory: string | null; status: string }>,
) {
  const map = new Map<string, number>();
  for (const s of states) {
    if (s.status === 'ACTIVATED') continue;
    if (!s.blockerCategory) continue;
    map.set(s.blockerCategory, (map.get(s.blockerCategory) || 0) + 1);
  }
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => ({
      category,
      label: BLOCKER_LABELS[category] || category,
      count,
    }));
}

function percentile(values: number[], p: number): number | null {
  if (values.length < 3) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return Math.round(sorted[idx]! * 10) / 10;
}

function buildTimeline(
  state: {
    createdAt: Date;
    firstProjectAt: Date | null;
    firstDeployStartedAt: Date | null;
    firstDeploySucceededAt: Date | null;
    firstPublicSuccessAt: Date | null;
    activatedAt: Date | null;
  },
  steps: Array<{ stage: string; status: string; enteredAt: Date; completedAt: Date | null }>,
) {
  const items: Array<{ label: string; stage: string; at: Date }> = [];
  items.push({ label: '注册', stage: 'REGISTERED', at: state.createdAt });
  if (state.firstProjectAt) {
    items.push({ label: '创建应用', stage: 'PROJECT_CREATED', at: state.firstProjectAt });
  }
  if (state.firstDeployStartedAt) {
    items.push({
      label: '首次部署',
      stage: 'FIRST_DEPLOY_STARTED',
      at: state.firstDeployStartedAt,
    });
  }
  if (state.firstDeploySucceededAt) {
    items.push({
      label: '部署成功',
      stage: 'FIRST_DEPLOY_SUCCEEDED',
      at: state.firstDeploySucceededAt,
    });
  }
  if (state.firstPublicSuccessAt) {
    items.push({
      label: '公网可访问 / 激活',
      stage: 'ACTIVATED',
      at: state.firstPublicSuccessAt,
    });
  }
  for (const s of steps) {
    if (s.status === 'BLOCKED') {
      items.push({
        label: `卡在${STAGE_LABELS[s.stage] || s.stage}`,
        stage: s.stage,
        at: s.enteredAt,
      });
    }
  }
  return items
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map((i) => ({ ...i, at: i.at }));
}
