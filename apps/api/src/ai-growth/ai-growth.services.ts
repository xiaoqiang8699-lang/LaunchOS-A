import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@launchos/database';
import { PrismaService } from '../database/prisma.service';
import { AIProviderRouter } from './ai-provider';
import { categorizeFailure, redactText, sanitizeAiMetadata } from './ai-sanitize';

const DEFAULT_PROMPTS: Array<{ name: string; template: string }> = [
  {
    name: 'daily_ops_summary',
    template:
      '你是 LaunchOS 内部运营分析助手。仅基于 FACTS 生成运营摘要、风险与建议。不要编造数据，不要建议自动扣费或自动发消息。\n\nFACTS:\n{{facts}}',
  },
  {
    name: 'user_insight',
    template:
      '基于用户业务元数据，输出用户画像、当前阶段、风险与建议。禁止使用密钥/密码信息。\n\nFACTS:\n{{facts}}',
  },
  {
    name: 'deployment_issues',
    template:
      '总结近 7 天部署失败原因与产品改进建议。不要建议自动修改用户数据。\n\nFACTS:\n{{facts}}',
  },
];

@Injectable()
export class AIGrowthService implements OnModuleInit {
  private readonly logger = new Logger(AIGrowthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AIProviderRouter,
  ) {}

  async onModuleInit() {
    await this.ensurePromptTemplates().catch((error) => {
      this.logger.warn(
        `ensurePromptTemplates failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    });
  }

  async ensurePromptTemplates() {
    for (const item of DEFAULT_PROMPTS) {
      await this.prisma.aIPromptTemplate.upsert({
        where: { name: item.name },
        create: { name: item.name, template: item.template, version: 1 },
        update: {},
      });
    }
  }

  async generateDailySummary() {
    const startOfToday = startOfDay(new Date());
    const [
      newUsers,
      newProjects,
      deploySuccess,
      deployFailed,
      needsHelpTags,
      pendingActions,
      upgradeTags,
      dormantTags,
    ] = await Promise.all([
      this.prisma.user.count({ where: { createdAt: { gte: startOfToday } } }),
      this.prisma.project.count({ where: { createdAt: { gte: startOfToday } } }),
      this.prisma.deployment.count({
        where: { createdAt: { gte: startOfToday }, status: 'SUCCESS' },
      }),
      this.prisma.deployment.count({
        where: { createdAt: { gte: startOfToday }, status: 'FAILED' },
      }),
      this.prisma.userTag.count({
        where: { tag: { in: ['NEEDS_ONBOARDING', 'DEPLOY_BLOCKED'] } },
      }),
      this.prisma.lifecycleAction.count({ where: { status: 'PENDING' } }),
      this.prisma.userTag.count({ where: { tag: 'UPGRADE_POTENTIAL' } }),
      this.prisma.userTag.count({ where: { tag: 'DORMANT' } }),
    ]);

    const keyMetrics = {
      newUsers,
      newProjects,
      deploySuccess,
      deployFailed,
      usersNeedingHelp: needsHelpTags,
      pendingLifecycleActions: pendingActions,
      upgradePotentialUsers: upgradeTags,
      dormantUsers: dormantTags,
    };

    const risks: Array<{ code: string; title: string; priority: 'HIGH' | 'MEDIUM' | 'LOW' }> = [];
    if (deployFailed > 0) {
      risks.push({
        code: 'DEPLOY_FAILURES_TODAY',
        title: `今日部署失败 ${deployFailed} 次`,
        priority: deployFailed >= 5 ? 'HIGH' : 'MEDIUM',
      });
    }
    if (needsHelpTags > 0) {
      risks.push({
        code: 'USERS_NEED_HELP',
        title: `有 ${needsHelpTags} 个用户可能需要帮助`,
        priority: needsHelpTags >= 5 ? 'HIGH' : 'MEDIUM',
      });
    }
    if (dormantTags > 10) {
      risks.push({
        code: 'DORMANT_USERS',
        title: `沉默用户 ${dormantTags} 人`,
        priority: 'LOW',
      });
    }

    const recommendations: Array<{
      type: 'USER_RISK' | 'PRODUCT_ISSUE' | 'GROWTH_OPPORTUNITY' | 'SYSTEM_WARNING';
      title: string;
      content: string;
      priority: 'HIGH' | 'MEDIUM' | 'LOW';
    }> = [];

    if (needsHelpTags > 0) {
      recommendations.push({
        type: 'USER_RISK',
        title: '关注需要帮助的用户',
        content: `当前有 ${needsHelpTags} 个用户带有 NEEDS_ONBOARDING 或 DEPLOY_BLOCKED 标签，建议在用户详情查看生命周期状态并人工跟进。`,
        priority: needsHelpTags >= 5 ? 'HIGH' : 'MEDIUM',
      });
    }
    if (deployFailed > 0) {
      recommendations.push({
        type: 'PRODUCT_ISSUE',
        title: '排查今日部署失败',
        content: `今日失败 ${deployFailed} 次。可前往 AI 问题分析页查看 TOP 失败原因，优化首次部署配置引导。`,
        priority: deployFailed >= 5 ? 'HIGH' : 'MEDIUM',
      });
    }
    if (upgradeTags > 0) {
      recommendations.push({
        type: 'GROWTH_OPPORTUNITY',
        title: '跟进升级潜力用户',
        content: `检测到 ${upgradeTags} 个高活跃 Free 用户，可在升级机会列表中查看，由管理员人工沟通（系统不会自动发消息或扣费）。`,
        priority: 'MEDIUM',
      });
    }
    if (recommendations.length === 0) {
      recommendations.push({
        type: 'SYSTEM_WARNING',
        title: '今日暂无紧急运营事项',
        content: '核心指标平稳。可继续观察增长漏斗与自动化规则触发情况。',
        priority: 'LOW',
      });
    }

    const facts = [
      `新增用户=${newUsers}`,
      `新增应用=${newProjects}`,
      `部署成功=${deploySuccess}`,
      `部署失败=${deployFailed}`,
      `需要帮助用户=${needsHelpTags}`,
      `升级潜力=${upgradeTags}`,
      `沉默用户=${dormantTags}`,
      `待处理生命周期动作=${pendingActions}`,
    ].join('\n');

    const prompt = await this.renderPrompt('daily_ops_summary', facts);
    const aiText = await this.ai.generateText(prompt).catch(() => '');

    const summary = [
      '今日 LaunchOS 状态',
      `新增用户：${newUsers}`,
      `新增应用：${newProjects}`,
      `部署成功：${deploySuccess}`,
      `部署失败：${deployFailed}`,
      needsHelpTags > 0 ? `主要关注：有 ${needsHelpTags} 个用户可能需要帮助` : '主要关注：暂无明显阻塞用户',
    ].join('\n');

    // Persist recommendations (best-effort, replace today's batch by source stamp)
    await this.persistRecommendations(recommendations).catch(() => undefined);

    return {
      summary,
      keyMetrics,
      risks,
      recommendations,
      aiNarrative: redactText(aiText),
      provider: this.ai.name,
      generatedAt: new Date().toISOString(),
      note: 'AI 仅提供分析与建议，不会自动修改数据、发消息或触发支付。',
    };
  }

  private async renderPrompt(name: string, facts: string) {
    const row = await this.prisma.aIPromptTemplate.findUnique({ where: { name } });
    const template =
      row?.template ||
      DEFAULT_PROMPTS.find((p) => p.name === name)?.template ||
      'FACTS:\n{{facts}}';
    return template.replace('{{facts}}', facts);
  }

  private async persistRecommendations(
    items: Array<{
      type: 'USER_RISK' | 'PRODUCT_ISSUE' | 'GROWTH_OPPORTUNITY' | 'SYSTEM_WARNING';
      title: string;
      content: string;
      priority: 'HIGH' | 'MEDIUM' | 'LOW';
    }>,
  ) {
    const start = startOfDay(new Date());
    await this.prisma.aIOperationRecommendation.deleteMany({
      where: { source: 'AI_GROWTH_DAILY', createdAt: { gte: start } },
    });
    if (items.length === 0) return;
    await this.prisma.aIOperationRecommendation.createMany({
      data: items.map((item) => ({
        type: item.type,
        title: item.title.slice(0, 200),
        content: item.content.slice(0, 2000),
        priority: item.priority,
        source: 'AI_GROWTH_DAILY',
        metadata: {} as Prisma.InputJsonValue,
      })),
    });
  }
}

@Injectable()
export class AIUserInsightService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AIProviderRouter,
  ) {}

  async analyzeUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
        lastLoginAt: true,
        onboardingStatus: true,
        userTags: { select: { tag: true, source: true, createdAt: true } },
        memberships: {
          select: {
            workspace: {
              select: {
                id: true,
                projects: {
                  select: {
                    id: true,
                    name: true,
                    framework: true,
                    deployments: {
                      orderBy: { createdAt: 'desc' },
                      take: 10,
                      select: {
                        id: true,
                        status: true,
                        failureCode: true,
                        errorMessage: true,
                        createdAt: true,
                      },
                    },
                  },
                },
                subscriptions: {
                  orderBy: { createdAt: 'desc' },
                  take: 1,
                  select: { status: true, plan: { select: { code: true, name: true } } },
                },
              },
            },
          },
        },
      },
    });
    if (!user) return null;

    const projects = user.memberships.flatMap((m) => m.workspace.projects);
    const deployments = projects.flatMap((p) => p.deployments);
    const failed = deployments.filter((d) => d.status === 'FAILED');
    const success = deployments.filter((d) => d.status === 'SUCCESS');
    const plan = user.memberships[0]?.workspace.subscriptions[0]?.plan ?? {
      code: 'free',
      name: 'Free',
    };
    const tags = user.userTags.map((t) => t.tag);

    let currentStage = '注册阶段';
    if (projects.length > 0) currentStage = '创建应用阶段';
    if (deployments.some((d) => d.status === 'SUCCESS' || d.status === 'FAILED' || d.status === 'RUNNING')) {
      currentStage = '部署阶段';
    }
    if (success.length > 0) currentStage = '运行阶段';
    if (tags.includes('UPGRADE_POTENTIAL')) currentStage = '增长/升级观察阶段';
    if (tags.includes('DORMANT')) currentStage = '沉默阶段';

    const profile = {
      type: inferUserType(projects.map((p) => p.framework)),
      plan: plan.name,
      planCode: plan.code,
      projectCount: projects.length,
      deploySuccessCount: success.length,
      deployFailedCount: failed.length,
      tags,
      onboardingStatus: user.onboardingStatus,
    };

    const risks: Array<{ code: string; title: string; detail?: string }> = [];
    const recentFails = failed.slice(0, 3);
    if (recentFails.length >= 2) {
      const cats = recentFails.map((f) =>
        categorizeFailure(f.failureCode, redactText(f.errorMessage || '')),
      );
      risks.push({
        code: 'RECENT_DEPLOY_FAILURES',
        title: `最近${recentFails.length}次部署失败`,
        detail: cats.join('；'),
      });
    }
    if (tags.includes('DEPLOY_BLOCKED')) {
      risks.push({ code: 'DEPLOY_BLOCKED', title: '用户被标记为部署阻塞' });
    }
    if (tags.includes('NEEDS_ONBOARDING')) {
      risks.push({ code: 'NEEDS_ONBOARDING', title: '用户尚未完成首次创建项目' });
    }
    if (tags.includes('DORMANT')) {
      risks.push({ code: 'DORMANT', title: '用户长期无活跃' });
    }

    const suggestions: string[] = [];
    if (risks.some((r) => r.code === 'RECENT_DEPLOY_FAILURES' || r.code === 'DEPLOY_BLOCKED')) {
      suggestions.push('提供配置引导，重点检查环境变量与构建配置');
    }
    if (tags.includes('NEEDS_ONBOARDING')) {
      suggestions.push('引导用户完成首次创建应用与部署');
    }
    if (tags.includes('UPGRADE_POTENTIAL')) {
      suggestions.push('可作为升级沟通候选人（仅人工跟进，系统不自动发消息）');
    }
    if (suggestions.length === 0) {
      suggestions.push('继续观察用户行为与部署成功率');
    }

    const safeFails = recentFails.map((f) => ({
      status: f.status,
      category: categorizeFailure(f.failureCode, f.errorMessage),
      failureCode: f.failureCode,
      createdAt: f.createdAt,
      // intentionally omit raw errorMessage secrets; keep redacted category only
    }));

    const facts = JSON.stringify(
      sanitizeAiMetadata({
        profileType: profile.type,
        stage: currentStage,
        projectCount: profile.projectCount,
        deploySuccess: profile.deploySuccessCount,
        deployFailed: profile.deployFailedCount,
        planCode: profile.planCode,
        tags: tags.join(','),
        recentFailCategories: safeFails.map((f) => f.category).join(','),
      }),
    );

    const template =
      (
        await this.prisma.aIPromptTemplate.findUnique({ where: { name: 'user_insight' } })
      )?.template || DEFAULT_PROMPTS[1]!.template;
    const aiNarrative = await this.ai
      .generateText(template.replace('{{facts}}', facts))
      .catch(() => '');

    return {
      profile,
      currentStage,
      risks,
      suggestions,
      recentFailures: safeFails,
      aiNarrative: redactText(aiNarrative),
      note: '分析仅供管理员参考，不会自动修改用户或触发支付。',
    };
  }
}

@Injectable()
export class DeploymentInsightService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AIProviderRouter,
  ) {}

  async analyzeDeploymentFailures() {
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const failed = await this.prisma.deployment.findMany({
      where: { status: 'FAILED', createdAt: { gte: since } },
      select: {
        id: true,
        failureCode: true,
        errorMessage: true,
        createdAt: true,
      },
      take: 500,
      orderBy: { createdAt: 'desc' },
    });

    const buckets = new Map<string, number>();
    for (const row of failed) {
      const cat = categorizeFailure(row.failureCode, row.errorMessage);
      buckets.set(cat, (buckets.get(cat) || 0) + 1);
    }
    const topReasons = Array.from(buckets.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([reason, count]) => ({ reason, count }));

    const suggestions: string[] = [];
    if (topReasons[0]?.reason.includes('环境变量')) {
      suggestions.push('优化首次部署配置流程，强化环境变量缺失提示');
    }
    if (topReasons.some((r) => r.reason.includes('Docker') || r.reason.includes('构建'))) {
      suggestions.push('完善构建失败诊断与可操作修复建议');
    }
    if (suggestions.length === 0) {
      suggestions.push('持续跟踪失败分类，优先处理出现频率最高的根因');
    }

    const facts = [
      `过去7天失败次数=${failed.length}`,
      ...topReasons.map((r, i) => `TOP${i + 1}=${r.reason}:${r.count}`),
    ].join('\n');
    const template =
      (
        await this.prisma.aIPromptTemplate.findUnique({ where: { name: 'deployment_issues' } })
      )?.template || DEFAULT_PROMPTS[2]!.template;
    const aiNarrative = await this.ai
      .generateText(template.replace('{{facts}}', facts))
      .catch(() => '');

    return {
      windowDays: 7,
      failureCount: failed.length,
      topReasons,
      suggestions,
      summary:
        failed.length === 0
          ? '过去 7 天暂无部署失败记录'
          : `过去7天部署分析\n失败次数：${failed.length}\nTOP原因：\n${topReasons
              .slice(0, 3)
              .map((r, i) => `${i + 1}. ${r.reason} ${r.count}次`)
              .join('\n')}`,
      aiNarrative: redactText(aiNarrative),
      note: 'AI 不自动修复部署；建议由管理员确认后改进产品流程。',
    };
  }
}

@Injectable()
export class UpgradeOpportunityService {
  constructor(private readonly prisma: PrismaService) {}

  async listOpportunities() {
    const tagged = await this.prisma.userTag.findMany({
      where: { tag: 'UPGRADE_POTENTIAL' },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            lastLoginAt: true,
            createdAt: true,
            memberships: {
              select: {
                workspace: {
                  select: {
                    projects: {
                      select: {
                        id: true,
                        _count: { select: { deployments: { where: { status: 'SUCCESS' } } } },
                      },
                    },
                    subscriptions: {
                      orderBy: { createdAt: 'desc' },
                      take: 1,
                      select: { plan: { select: { code: true, name: true } } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    // Also compute live candidates (free + projects>=3 + deploySuccess>=5 + active <7d)
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const freeUsers = await this.prisma.user.findMany({
      where: {
        accountStatus: 'ACTIVE',
        OR: [{ lastLoginAt: { gte: since } }, { createdAt: { gte: since } }],
        memberships: {
          some: {
            workspace: {
              subscriptions: {
                some: {
                  status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE', 'CANCEL_AT_PERIOD_END'] },
                  plan: { code: 'free' },
                },
              },
            },
          },
        },
      },
      take: 300,
      select: {
        id: true,
        email: true,
        name: true,
        lastLoginAt: true,
        memberships: {
          select: {
            workspace: {
              select: {
                projects: {
                  select: {
                    id: true,
                    _count: { select: { deployments: { where: { status: 'SUCCESS' } } } },
                  },
                },
                subscriptions: {
                  orderBy: { createdAt: 'desc' },
                  take: 1,
                  select: { plan: { select: { code: true, name: true } } },
                },
              },
            },
          },
        },
      },
    });

    const live = freeUsers
      .map((u) => {
        const projectCount = u.memberships.reduce((s, m) => s + m.workspace.projects.length, 0);
        const deploySuccess = u.memberships.reduce(
          (s, m) => s + m.workspace.projects.reduce((a, p) => a + p._count.deployments, 0),
          0,
        );
        const planCode = u.memberships[0]?.workspace.subscriptions[0]?.plan.code || 'free';
        return { user: u, projectCount, deploySuccess, planCode };
      })
      .filter((r) => r.planCode === 'free' && r.projectCount >= 3 && r.deploySuccess >= 5);

    const byId = new Map<string, PotentialUpgradeUser>();
    for (const row of tagged) {
      const projectCount = row.user.memberships.reduce((s, m) => s + m.workspace.projects.length, 0);
      const deploySuccess = row.user.memberships.reduce(
        (s, m) => s + m.workspace.projects.reduce((a, p) => a + p._count.deployments, 0),
        0,
      );
      byId.set(row.user.id, {
        userId: row.user.id,
        email: row.user.email,
        name: row.user.name,
        projectCount,
        deploySuccessCount: deploySuccess,
        planCode: row.user.memberships[0]?.workspace.subscriptions[0]?.plan.code || 'free',
        reason: `高频使用 · 成功部署${deploySuccess}次 · 标签 UPGRADE_POTENTIAL`,
        source: 'TAG',
      });
    }
    for (const row of live) {
      if (byId.has(row.user.id)) continue;
      byId.set(row.user.id, {
        userId: row.user.id,
        email: row.user.email,
        name: row.user.name,
        projectCount: row.projectCount,
        deploySuccessCount: row.deploySuccess,
        planCode: row.planCode,
        reason: `高频使用 · 项目${row.projectCount} · 成功部署${row.deploySuccess}次 · 近7天活跃`,
        source: 'LIVE',
      });
    }

    const items = Array.from(byId.values()).sort(
      (a, b) => b.deploySuccessCount - a.deploySuccessCount,
    );

    return {
      total: items.length,
      items,
      note: '仅展示升级机会，不会自动联系用户或变更套餐。',
    };
  }
}

type PotentialUpgradeUser = {
  userId: string;
  email: string;
  name: string;
  projectCount: number;
  deploySuccessCount: number;
  planCode: string;
  reason: string;
  source: 'TAG' | 'LIVE';
};

function startOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function inferUserType(frameworks: Array<string | null>): string {
  const joined = frameworks.filter(Boolean).join(' ').toLowerCase();
  if (/next|react|vue|nuxt|frontend|web/.test(joined)) return '前端开发者';
  if (/python|django|flask|fastapi/.test(joined)) return 'Python 开发者';
  if (/node|nest|express/.test(joined)) return 'Node 开发者';
  if (frameworks.length > 0) return '开发者';
  return '新用户';
}
