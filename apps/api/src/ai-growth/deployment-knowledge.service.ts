import { ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@launchos/database';
import { PrismaService } from '../database/prisma.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import { AIProviderRouter } from './ai-provider';
import { redactText, sanitizeAiMetadata } from './ai-sanitize';

export type KnowledgeCategory =
  | 'BUILD_ERROR'
  | 'CONFIG_ERROR'
  | 'DEPENDENCY_ERROR'
  | 'DOCKER_ERROR'
  | 'RUNTIME_ERROR'
  | 'NETWORK_ERROR'
  | 'DATABASE_ERROR'
  | 'UNKNOWN';

export type KnowledgeMatch = {
  id: string;
  title: string;
  reason: string;
  solution: string;
  solutionSteps: string[];
  category: KnowledgeCategory;
  confidence: number;
  successRate: number;
  usageCount: number;
};

const SEED_KNOWLEDGE: Array<{
  category: KnowledgeCategory;
  title: string;
  problemPattern: string;
  description: string;
  rootCause: string;
  solutionSteps: string[];
}> = [
  {
    category: 'DATABASE_ERROR',
    title: 'Prisma Schema 缺失',
    problemPattern: 'Could not find Prisma Schema|schema\\.prisma|P1012',
    description: '构建阶段无法找到 Prisma Schema。',
    rootCause: 'Docker 构建上下文未按正确顺序 COPY prisma 目录。',
    solutionSteps: [
      '确认仓库包含 prisma/schema.prisma',
      '调整 Dockerfile，在 prisma generate 前 COPY schema',
      '重新触发部署',
    ],
  },
  {
    category: 'CONFIG_ERROR',
    title: '运行配置缺失',
    problemPattern: 'RUNTIME_CONFIG_MISSING|missing required|CONFIG_MISSING',
    description: '缺少必需运行配置导致启动失败。',
    rootCause: '必需环境变量未在配置中心补齐。',
    solutionSteps: ['打开配置中心', '补齐缺失配置键（勿粘贴密钥到聊天）', '保存后重新上线'],
  },
  {
    category: 'DEPENDENCY_ERROR',
    title: '依赖安装失败',
    problemPattern: 'npm ERR|pnpm ERR|yarn error|ERESOLVE',
    description: '包管理器安装依赖失败。',
    rootCause: 'package.json 与 lockfile 不一致或私有源不可达。',
    solutionSteps: ['检查 package.json 与 lockfile', '本地复现安装', '修复后重新上线'],
  },
  {
    category: 'DOCKER_ERROR',
    title: 'Docker 构建失败',
    problemPattern: 'docker build|Dockerfile|failed to solve|BUILD_FAILED',
    description: 'Docker 镜像构建未完成。',
    rootCause: 'Dockerfile 指令或构建上下文错误。',
    solutionSteps: ['查看构建日志首个 ERROR', '检查 Dockerfile COPY/CMD/EXPOSE', '修复后重新上线'],
  },
  {
    category: 'RUNTIME_ERROR',
    title: '端口启动异常',
    problemPattern: 'connection refused|ECONNREFUSED|EADDRINUSE|failed to bind',
    description: '应用未正确监听端口。',
    rootCause: 'PORT 配置或启动命令异常。',
    solutionSteps: ['确认应用监听 PORT', '检查启动命令与健康检查', '重新上线'],
  },
];

@Injectable()
export class DeploymentKnowledgeService implements OnModuleInit {
  private readonly logger = new Logger(DeploymentKnowledgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaceAccess: WorkspaceAccessService,
  ) {}

  async onModuleInit() {
    await this.ensureSeedKnowledge().catch((error) => {
      this.logger.warn(
        `ensureSeedKnowledge failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    });
  }

  async ensureSeedKnowledge() {
    for (const item of SEED_KNOWLEDGE) {
      const existing = await this.prisma.deploymentKnowledgeItem.findFirst({
        where: { title: item.title },
        select: { id: true },
      });
      if (existing) continue;
      await this.prisma.deploymentKnowledgeItem.create({
        data: {
          category: item.category,
          title: item.title,
          problemPattern: item.problemPattern,
          description: item.description,
          rootCause: item.rootCause,
          solutionStepsJson: item.solutionSteps,
          sourceType: 'RULE',
          confidence: 0.8,
          usageCount: 0,
          successCount: 0,
          failCount: 0,
          successRate: 0,
          enabled: true,
        },
      });
    }
  }

  async findRelevantKnowledge(input: {
    errorMessage?: string | null;
    category?: string | null;
    failureCode?: string | null;
    framework?: string | null;
    logHints?: string | null;
  }): Promise<KnowledgeMatch[]> {
    const haystack = redactText(
      [input.failureCode, input.errorMessage, input.category, input.framework, input.logHints]
        .filter(Boolean)
        .join('\n'),
    ).slice(0, 6000);

    const items = await this.prisma.deploymentKnowledgeItem.findMany({
      where: { enabled: true },
      orderBy: [{ successRate: 'desc' }, { usageCount: 'desc' }, { confidence: 'desc' }],
      take: 200,
    });

    const matched: KnowledgeMatch[] = [];
    for (const item of items) {
      let hit = false;
      try {
        hit = new RegExp(item.problemPattern, 'i').test(haystack);
      } catch {
        hit = haystack.toLowerCase().includes(item.problemPattern.toLowerCase());
      }
      if (!hit && input.category) {
        hit = mapInsightCategory(input.category) === item.category;
      }
      if (!hit) continue;
      const confidence = scoreKnowledge({
        successRate: item.successRate,
        usageCount: item.usageCount,
        baseConfidence: item.confidence,
        updatedAt: item.updatedAt,
      });
      const steps = Array.isArray(item.solutionStepsJson)
        ? (item.solutionStepsJson as unknown[]).map((s) => String(s))
        : [];
      matched.push({
        id: item.id,
        title: item.title,
        reason: item.rootCause,
        solution: steps.join(' → ') || item.description,
        solutionSteps: steps,
        category: item.category as KnowledgeCategory,
        confidence,
        successRate: item.successRate,
        usageCount: item.usageCount,
      });
    }

    matched.sort((a, b) => b.confidence - a.confidence || b.successRate - a.successRate);
    const top = matched.slice(0, 5);
    if (top.length) {
      await this.prisma.deploymentKnowledgeItem.updateMany({
        where: { id: { in: top.map((t) => t.id) } },
        data: { usageCount: { increment: 1 } },
      });
    }
    return top;
  }

  async listPublic(query?: { category?: string; q?: string }) {
    const where: Prisma.DeploymentKnowledgeItemWhereInput = {
      enabled: true,
      ...(query?.category ? { category: query.category as KnowledgeCategory } : {}),
      ...(query?.q
        ? {
            OR: [
              { title: { contains: query.q, mode: 'insensitive' } },
              { description: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const items = await this.prisma.deploymentKnowledgeItem.findMany({
      where,
      orderBy: [{ successRate: 'desc' }, { usageCount: 'desc' }],
      take: 100,
    });
    return {
      items: items.map((item) => this.presentItem(item)),
      note: '知识库仅保存错误类型与通用方案，不含密钥或用户代码。',
    };
  }

  async listAdmin(query?: { category?: string; q?: string; status?: string }) {
    const items = await this.prisma.deploymentKnowledgeItem.findMany({
      where: {
        ...(query?.category ? { category: query.category as KnowledgeCategory } : {}),
        ...(query?.q
          ? {
              OR: [
                { title: { contains: query.q, mode: 'insensitive' } },
                { description: { contains: query.q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ updatedAt: 'desc' }],
      take: 200,
    });
    const candidates = await this.prisma.deploymentKnowledgeCandidate.findMany({
      where: {
        ...(query?.status
          ? { status: query.status as 'PENDING' | 'APPROVED' | 'REJECTED' }
          : { status: 'PENDING' }),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        deployment: {
          select: { id: true, projectId: true, failureCode: true, status: true },
        },
      },
    });
    return {
      items: items.map((item) => this.presentItem(item)),
      candidates: candidates.map((c) => ({
        id: c.id,
        deploymentId: c.deploymentId,
        projectId: c.deployment.projectId,
        category: c.category,
        summary: c.summary,
        solution: c.solution,
        status: c.status,
        reviewedBy: c.reviewedBy,
        knowledgeId: c.knowledgeId,
        createdAt: c.createdAt,
      })),
    };
  }

  async getItem(id: string) {
    const item = await this.prisma.deploymentKnowledgeItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Knowledge not found');
    return this.presentItem(item);
  }

  async submitFeedback(
    userId: string,
    knowledgeId: string,
    body: { deploymentId: string; result: 'SUCCESS' | 'FAILED' },
  ) {
    await this.workspaceAccess.requireDeploymentAccess(userId, body.deploymentId);
    const knowledge = await this.prisma.deploymentKnowledgeItem.findUnique({
      where: { id: knowledgeId },
    });
    if (!knowledge) throw new NotFoundException('Knowledge not found');

    await this.prisma.deploymentKnowledgeFeedback.upsert({
      where: {
        knowledgeId_deploymentId: {
          knowledgeId,
          deploymentId: body.deploymentId,
        },
      },
      create: {
        knowledgeId,
        deploymentId: body.deploymentId,
        userId,
        result: body.result,
      },
      update: { result: body.result, userId },
    });

    const [successCount, failCount] = await Promise.all([
      this.prisma.deploymentKnowledgeFeedback.count({
        where: { knowledgeId, result: 'SUCCESS' },
      }),
      this.prisma.deploymentKnowledgeFeedback.count({
        where: { knowledgeId, result: 'FAILED' },
      }),
    ]);
    const total = successCount + failCount;
    const successRate = total === 0 ? 0 : successCount / total;
    const confidence = scoreKnowledge({
      successRate,
      usageCount: knowledge.usageCount,
      baseConfidence: knowledge.confidence,
      updatedAt: new Date(),
    });
    await this.prisma.deploymentKnowledgeItem.update({
      where: { id: knowledgeId },
      data: { successCount, failCount, successRate, confidence },
    });

    return { ok: true, successRate, confidence };
  }

  async reviewCandidate(
    adminUserId: string,
    candidateId: string,
    decision: 'APPROVED' | 'REJECTED',
  ) {
    const candidate = await this.prisma.deploymentKnowledgeCandidate.findUnique({
      where: { id: candidateId },
    });
    if (!candidate) throw new NotFoundException('Candidate not found');
    if (candidate.status !== 'PENDING') {
      throw new ForbiddenException('Candidate already reviewed');
    }

    if (decision === 'REJECTED') {
      return this.prisma.deploymentKnowledgeCandidate.update({
        where: { id: candidateId },
        data: { status: 'REJECTED', reviewedBy: adminUserId },
      });
    }

    const steps = candidate.solution
      .split(/[|；;\n]/)
      .map((s) => redactText(s.trim()))
      .filter(Boolean)
      .slice(0, 8);

    const item = await this.prisma.deploymentKnowledgeItem.create({
      data: {
        category: candidate.category,
        title: redactText(candidate.summary).slice(0, 120),
        problemPattern: escapeRegex(redactText(candidate.summary).slice(0, 80)),
        description: redactText(candidate.summary).slice(0, 500),
        rootCause: redactText(candidate.summary).slice(0, 500),
        solutionStepsJson: steps.length ? steps : [redactText(candidate.solution).slice(0, 200)],
        sourceType: 'LEARNED_FROM_SUCCESS',
        confidence: 0.7,
        enabled: true,
      },
    });

    return this.prisma.deploymentKnowledgeCandidate.update({
      where: { id: candidateId },
      data: {
        status: 'APPROVED',
        reviewedBy: adminUserId,
        knowledgeId: item.id,
      },
    });
  }

  async analytics(days = 30) {
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const [knowledgeCount, feedbackSuccess, items, top] = await Promise.all([
      this.prisma.deploymentKnowledgeItem.count({ where: { enabled: true } }),
      this.prisma.deploymentKnowledgeFeedback.count({
        where: { result: 'SUCCESS', createdAt: { gte: since } },
      }),
      this.prisma.deploymentKnowledgeItem.findMany({
        where: { enabled: true },
        select: { successRate: true, category: true, title: true, usageCount: true },
        take: 500,
      }),
      this.prisma.deploymentKnowledgeItem.findMany({
        where: { enabled: true },
        orderBy: [{ usageCount: 'desc' }, { successRate: 'desc' }],
        take: 5,
        select: { title: true, category: true, usageCount: true, successRate: true },
      }),
    ]);
    const maxSuccess = items.reduce((m, i) => Math.max(m, i.successRate || 0), 0);
    const categoryBuckets = new Map<string, number>();
    for (const item of items) {
      categoryBuckets.set(item.category, (categoryBuckets.get(item.category) || 0) + item.usageCount);
    }
    const topProblems = Array.from(categoryBuckets.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([reason, count]) => ({ reason: categoryLabel(reason as KnowledgeCategory), count }));

    return {
      windowDays: days,
      knowledgeCount,
      resolvedDeployments: feedbackSuccess,
      maxSuccessRate: maxSuccess,
      topProblems:
        topProblems.length > 0
          ? topProblems
          : top.map((t) => ({ reason: t.title, count: t.usageCount })),
      topKnowledge: top,
      summary:
        knowledgeCount === 0
          ? `知识库为空`
          : `知识数量：${knowledgeCount}\n解决部署次数：${feedbackSuccess}\n最高成功率：${Math.round(maxSuccess * 100)}%`,
      note: '知识库仅用于分析建议，不会自动修改代码。',
    };
  }

  private presentItem(item: {
    id: string;
    category: string;
    title: string;
    problemPattern: string;
    description: string;
    rootCause: string;
    solutionStepsJson: Prisma.JsonValue;
    sourceType: string;
    confidence: number;
    usageCount: number;
    successCount: number;
    failCount: number;
    successRate: number;
    enabled: boolean;
    createdAt: Date;
    updatedAt: Date;
  }) {
    const steps = Array.isArray(item.solutionStepsJson)
      ? (item.solutionStepsJson as unknown[]).map((s) => String(s))
      : [];
    return {
      id: item.id,
      category: item.category,
      title: item.title,
      problemPattern: item.problemPattern,
      description: item.description,
      rootCause: item.rootCause,
      solutionSteps: steps,
      sourceType: item.sourceType,
      confidence: item.confidence,
      usageCount: item.usageCount,
      successCount: item.successCount,
      failCount: item.failCount,
      successRate: item.successRate,
      enabled: item.enabled,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }
}

@Injectable()
export class KnowledgeExtractionService {
  private readonly logger = new Logger(KnowledgeExtractionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AIProviderRouter,
  ) {}

  /**
   * After a SUCCESS deployment, try to extract a knowledge candidate from a prior failed deploy
   * on the same project that has a clear insight/solution and no secrets.
   */
  async extractFromSuccessfulDeployment(successDeploymentId: string) {
    const success = await this.prisma.deployment.findUnique({
      where: { id: successDeploymentId },
      select: {
        id: true,
        status: true,
        projectId: true,
        createdAt: true,
        project: { select: { framework: true } },
      },
    });
    if (!success || success.status !== 'SUCCESS') return null;

    const priorFail = await this.prisma.deployment.findFirst({
      where: {
        projectId: success.projectId,
        status: 'FAILED',
        createdAt: { lt: success.createdAt },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        failureCode: true,
        errorMessage: true,
        insights: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            category: true,
            summary: true,
            rootCause: true,
            fixActionsJson: true,
          },
        },
      },
    });
    if (!priorFail) return null;
    const insight = priorFail.insights[0];
    if (!insight) return null;

    const summary = redactText(insight.summary || '').slice(0, 200);
    const rootCause = redactText(insight.rootCause || '').slice(0, 800);
    const steps = Array.isArray(insight.fixActionsJson)
      ? (insight.fixActionsJson as Array<{ title?: string }>)
          .map((s) => redactText(String(s.title || '')))
          .filter(Boolean)
      : [];
    if (!summary || !rootCause || steps.length === 0) return null;
    if (!isSafeKnowledgeText(`${summary}\n${rootCause}\n${steps.join('\n')}`)) return null;

    const existing = await this.prisma.deploymentKnowledgeCandidate.findFirst({
      where: { deploymentId: priorFail.id, status: { in: ['PENDING', 'APPROVED'] } },
      select: { id: true },
    });
    if (existing) return existing;

    const facts = JSON.stringify(
      sanitizeAiMetadata({
        category: insight.category,
        summary,
        framework: success.project.framework || '',
        failureCode: priorFail.failureCode || '',
      }),
    );
    const aiText = await this.ai
      .generateText(
        `你是 LaunchOS 知识库助手。仅基于 FACTS 用一句话归纳通用解决方案标题，不要输出密钥或代码。\nFACTS:\n${facts}`,
      )
      .catch(() => '');

    const candidate = await this.prisma.deploymentKnowledgeCandidate.create({
      data: {
        deploymentId: priorFail.id,
        category: mapInsightCategory(insight.category),
        summary: redactText(aiText || summary).slice(0, 160),
        solution: steps.join('|').slice(0, 1000),
        status: 'PENDING',
      },
    });
    this.logger.log(`Knowledge candidate created from ${priorFail.id} -> ${candidate.id}`);
    return candidate;
  }

  /** Manual/admin trigger: scan recent success deploys for extractable candidates. */
  async scanRecentSuccesses(limit = 20) {
    const successes = await this.prisma.deployment.findMany({
      where: { status: 'SUCCESS' },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true },
    });
    let created = 0;
    for (const row of successes) {
      const beforeIds = new Set(
        (
          await this.prisma.deploymentKnowledgeCandidate.findMany({
            where: { status: 'PENDING' },
            select: { id: true },
            take: 5000,
          })
        ).map((c) => c.id),
      );
      const result = await this.extractFromSuccessfulDeployment(row.id).catch(() => null);
      if (result?.id && !beforeIds.has(result.id)) created += 1;
    }
    return { scanned: successes.length, created };
  }
}

export function scoreKnowledge(input: {
  successRate: number;
  usageCount: number;
  baseConfidence: number;
  updatedAt: Date;
}): number {
  const recentBoost =
    Date.now() - input.updatedAt.getTime() < 14 * 24 * 3600 * 1000 ? 0.05 : 0;
  const usageBoost = Math.min(0.15, (input.usageCount || 0) * 0.01);
  const rateBoost = (input.successRate || 0) * 0.25;
  return Math.max(
    0.2,
    Math.min(0.98, (input.baseConfidence || 0.5) * 0.6 + rateBoost + usageBoost + recentBoost),
  );
}

export function mapInsightCategory(category: string | null | undefined): KnowledgeCategory {
  const c = String(category || '').toUpperCase();
  if (c === 'BUILD_ERROR') return 'BUILD_ERROR';
  if (c === 'CONFIG_ERROR') return 'CONFIG_ERROR';
  if (c === 'DEPENDENCY_ERROR') return 'DEPENDENCY_ERROR';
  if (c === 'RUNTIME_ERROR') return 'RUNTIME_ERROR';
  if (c === 'NETWORK_ERROR') return 'NETWORK_ERROR';
  if (c.includes('DOCKER')) return 'DOCKER_ERROR';
  if (c.includes('DATABASE') || c.includes('PRISMA')) return 'DATABASE_ERROR';
  if (c === 'PLATFORM_ERROR') return 'UNKNOWN';
  return 'UNKNOWN';
}

function categoryLabel(category: KnowledgeCategory): string {
  const map: Record<KnowledgeCategory, string> = {
    BUILD_ERROR: '构建失败',
    CONFIG_ERROR: '环境变量缺失',
    DEPENDENCY_ERROR: '依赖安装失败',
    DOCKER_ERROR: 'Docker配置错误',
    RUNTIME_ERROR: '启动/端口异常',
    NETWORK_ERROR: '网络/超时',
    DATABASE_ERROR: '数据库/Prisma',
    UNKNOWN: '其他问题',
  };
  return map[category];
}

function isSafeKnowledgeText(text: string): boolean {
  if (/postgres(ql)?:\/\//i.test(text)) return false;
  if (/sk-[A-Za-z0-9]{20,}/.test(text)) return false;
  if (/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(text)) return false;
  if (/BEGIN (RSA |OPENSSH )?PRIVATE KEY/i.test(text)) return false;
  if (/password\s*[:=]\s*\S+/i.test(text)) return false;
  return true;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
