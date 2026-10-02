import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AIProviderRouter } from './ai-provider';
import { redactText, sanitizeAiMetadata } from './ai-sanitize';

export type SuccessMetrics = {
  windowDays: number;
  deploymentCount: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  firstDeploymentSuccessRate: number;
  firstDeploymentCount: number;
  firstDeploymentSuccessCount: number;
  avgAttemptsToSuccess: number | null;
};

@Injectable()
export class AIProductRecommendationService {
  private readonly logger = new Logger(AIProductRecommendationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AIProviderRouter,
  ) {}

  async listOrGenerate(
    metrics: SuccessMetrics,
    topBlockers: Array<{ reason: string; count: number }>,
    frameworks: Array<{ framework: string; successRate: number; deploymentCount: number }>,
  ) {
    const existing = await this.prisma.deploymentOptimizationRecommendation.findMany({
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
      take: 20,
    });
    if (existing.length >= 3) {
      return existing.map(presentRecommendation);
    }

    return this.generateOptimizationRecommendations(metrics, topBlockers, frameworks);
  }

  async generateOptimizationRecommendations(
    metrics?: SuccessMetrics,
    topBlockers?: Array<{ reason: string; count: number }>,
    frameworks?: Array<{ framework: string; successRate: number; deploymentCount: number }>,
  ) {
    const m =
      metrics ||
      ({
        windowDays: 30,
        deploymentCount: 0,
        successCount: 0,
        failureCount: 0,
        successRate: 0,
        firstDeploymentSuccessRate: 0,
        firstDeploymentCount: 0,
        firstDeploymentSuccessCount: 0,
        avgAttemptsToSuccess: null,
      } satisfies SuccessMetrics);

    const blockers =
      topBlockers ||
      topFailureCategories(
        await this.prisma.deploymentSuccessSnapshot.findMany({
          take: 2000,
          select: {
            success: true,
            failureCategory: true,
            attemptCount: true,
            projectId: true,
            createdAt: true,
            framework: true,
          },
        }),
      );

    const seeds: Array<{
      category: 'ONBOARDING' | 'CONFIG' | 'BUILD' | 'RUNTIME' | 'DOCUMENTATION';
      title: string;
      description: string;
      impact: string;
      priority: number;
    }> = [];

    if (
      blockers[0]?.reason?.includes('环境') ||
      blockers[0]?.reason === 'CONFIG_ERROR' ||
      /CONFIG/.test(blockers[0]?.reason || '')
    ) {
      seeds.push({
        category: 'CONFIG',
        title: '首次部署失败主要来自环境变量',
        description: '创建项目与上线前增加运行配置引导，避免用户带着缺失配置进入构建。',
        impact: '可提升首次部署成功率',
        priority: 10,
      });
    }
    if ((m.firstDeploymentSuccessRate ?? 1) < 0.85) {
      seeds.push({
        category: 'ONBOARDING',
        title: '强化首次上线引导',
        description: '在 go-live 前突出 Preflight 结果与常见阻塞点，降低首次失败后的流失。',
        impact: '降低首次失败后的弃用率',
        priority: 20,
      });
    }
    const weakFw = (frameworks || []).find((f) => f.deploymentCount >= 3 && f.successRate < 0.8);
    if (weakFw) {
      seeds.push({
        category: 'BUILD',
        title: `${weakFw.framework} 框架成功率偏低`,
        description: `针对 ${weakFw.framework} 补充构建检查与知识库条目，降低重复失败。`,
        impact: `目标提升 ${weakFw.framework} 成功率`,
        priority: 30,
      });
    }
    if (seeds.length === 0) {
      seeds.push({
        category: 'DOCUMENTATION',
        title: '持续沉淀部署知识',
        description: '将高频失败方案审核入库，并在 Copilot 优先展示历史验证方案。',
        impact: '缩短二次部署修复时间',
        priority: 40,
      });
    }

    const facts = JSON.stringify(
      sanitizeAiMetadata({
        successRate: m.successRate ?? 0,
        firstSuccessRate: m.firstDeploymentSuccessRate ?? 0,
        topBlocker: blockers[0]?.reason || '',
      }),
    );
    const aiText = await this.ai
      .generateText(
        `基于 FACTS 给出一条简短中文产品优化建议标题（不超过30字），不要密钥。\nFACTS:\n${facts}`,
      )
      .catch(() => '');
    if (aiText) {
      seeds.push({
        category: 'ONBOARDING',
        title: redactText(aiText).slice(0, 60) || '优化上线体验',
        description: '由 AI 基于近期成功率统计归纳，仅供运营参考，不会自动改产品规则。',
        impact: '运营可评估后人工落地',
        priority: 50,
      });
    }

    const out = [];
    for (const seed of seeds.slice(0, 8)) {
      const existing = await this.prisma.deploymentOptimizationRecommendation.findFirst({
        where: { title: seed.title },
        select: { id: true },
      });
      if (existing) {
        const row = await this.prisma.deploymentOptimizationRecommendation.findUnique({
          where: { id: existing.id },
        });
        if (row) out.push(presentRecommendation(row));
        continue;
      }
      const created = await this.prisma.deploymentOptimizationRecommendation.create({ data: seed });
      out.push(presentRecommendation(created));
    }

    await this.updateKnowledgeSuccessImpact().catch((error) => {
      this.logger.warn(
        `updateKnowledgeSuccessImpact failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    });

    return out;
  }

  async updateKnowledgeSuccessImpact() {
    const items = await this.prisma.deploymentKnowledgeItem.findMany({
      where: { enabled: true },
      select: { id: true, successRate: true, usageCount: true },
      take: 200,
    });
    for (const item of items) {
      const impact = Math.max(
        0,
        Math.min(0.5, (item.successRate || 0) * 0.2 + Math.min(item.usageCount, 20) * 0.005),
      );
      await this.prisma.deploymentKnowledgeItem.update({
        where: { id: item.id },
        data: { successImpact: impact },
      });
    }
  }

  async listRecommendations() {
    const rows = await this.prisma.deploymentOptimizationRecommendation.findMany({
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
      take: 50,
    });
    if (rows.length === 0) {
      return this.generateOptimizationRecommendations();
    }
    return rows.map(presentRecommendation);
  }
}

function presentRecommendation(row: {
  id: string;
  category: string;
  title: string;
  description: string;
  impact: string;
  priority: number;
  createdAt: Date;
}) {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    description: row.description,
    impact: row.impact,
    priority: row.priority,
    createdAt: row.createdAt,
  };
}

export function topFailureCategories(
  snapshots: Array<{ success: boolean; failureCategory: string | null }>,
) {
  const map = new Map<string, number>();
  for (const row of snapshots) {
    if (row.success) continue;
    const key = row.failureCategory || 'UNKNOWN';
    map.set(key, (map.get(key) || 0) + 1);
  }
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([reason, count]) => ({
      reason: humanFailure(reason),
      code: reason,
      count,
    }));
}

function humanFailure(code: string): string {
  const map: Record<string, string> = {
    CONFIG_ERROR: '环境变量缺失',
    BUILD_ERROR: 'Docker/构建问题',
    DEPENDENCY_ERROR: '依赖安装失败',
    RUNTIME_ERROR: '启动/端口异常',
    NETWORK_ERROR: '网络/超时',
    DATABASE_ERROR: '数据库/Prisma',
    DOCKER_ERROR: 'Docker配置',
    UNKNOWN: '其他失败',
  };
  return map[code] || code;
}
