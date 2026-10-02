import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@launchos/database';
import { PrismaService } from '../database/prisma.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import { AIProviderRouter } from './ai-provider';
import { categorizeFailure, redactText, sanitizeAiMetadata } from './ai-sanitize';
import {
  DeploymentKnowledgeService,
  KnowledgeExtractionService,
  type KnowledgeMatch,
} from './deployment-knowledge.service';

export type DeploymentInsightCategory =
  | 'BUILD_ERROR'
  | 'DEPENDENCY_ERROR'
  | 'CONFIG_ERROR'
  | 'RUNTIME_ERROR'
  | 'NETWORK_ERROR'
  | 'PLATFORM_ERROR'
  | 'UNKNOWN';

type FixAction = { step: number; title: string; detail?: string };

type CopilotResult = {
  category: DeploymentInsightCategory;
  summary: string;
  rootCause: string;
  impact: string;
  fixActions: FixAction[];
  confidence: number;
  source: 'KNOWLEDGE' | 'RULE' | 'AI' | 'FALLBACK';
  failedStage: string | null;
  failureCode: string | null;
  insightId?: string;
  matchedRule?: string | null;
  timeline: Array<{ key: string; label: string; status: 'DONE' | 'FAILED' | 'AI' | 'PENDING' }>;
  similarCount?: number;
  knowledgeReferences?: Array<{
    id: string;
    title: string;
    successRate: number;
    usageCount: number;
    confidence: number;
  }>;
};

const DEFAULT_RULES: Array<{
  name: string;
  pattern: string;
  category: DeploymentInsightCategory;
  explanation: string;
  fixTemplate: string;
}> = [
  {
    name: 'Prisma Schema 缺失',
    pattern: 'Could not find Prisma Schema|prisma/?schema|P1012|schema\\.prisma',
    category: 'BUILD_ERROR',
    explanation: '构建环境缺少 Prisma Schema。请检查 Dockerfile COPY 顺序，确保 schema 在 generate/build 之前被复制进镜像。',
    fixTemplate: '检查 Dockerfile COPY 顺序|确认 prisma/schema.prisma 已包含在构建上下文|重新触发部署',
  },
  {
    name: '环境变量缺失',
    pattern: 'RUNTIME_CONFIG_MISSING|missing required (env|config)|environment variable .* (is )?required|CONFIG_MISSING',
    category: 'CONFIG_ERROR',
    explanation: '缺少运行配置。请补充配置后重新上线。',
    fixTemplate: '打开应用运行配置|补齐缺失的环境变量（勿粘贴密钥到聊天）|保存后重新上线',
  },
  {
    name: 'npm install 失败',
    pattern: 'npm ERR|pnpm ERR|yarn error|ERESOLVE|npm install failed|dependency.*fail',
    category: 'DEPENDENCY_ERROR',
    explanation: '依赖安装失败。检查 package.json 和 lockfile 是否一致，以及私有源/版本约束。',
    fixTemplate: '检查 package.json 依赖声明|确认 lockfile 已提交且版本匹配|本地复现安装后重新上线',
  },
  {
    name: '端口启动失败',
    pattern: 'connection refused|ECONNREFUSED|listen EADDRINUSE|port .* (in use|unavailable)|failed to bind',
    category: 'RUNTIME_ERROR',
    explanation: '应用启动端口异常。检查 PORT 配置与进程是否真正监听。',
    fixTemplate: '确认应用监听 PORT 环境变量|检查启动命令与健康检查路径|重新上线',
  },
  {
    name: 'Docker/构建失败',
    pattern: 'docker build|Dockerfile|failed to solve|build failed|BUILD_FAILED',
    category: 'BUILD_ERROR',
    explanation: 'Docker 构建未完成。请检查 Dockerfile 指令与构建日志中的首个错误行。',
    fixTemplate: '查看构建日志首个 ERROR|检查 Dockerfile 与 .dockerignore|修复后重新上线',
  },
  {
    name: '网络/超时',
    pattern: 'ETIMEDOUT|ENETUNREACH|network|timeout|TLS handshake',
    category: 'NETWORK_ERROR',
    explanation: '网络或超时导致部署中断。可能是拉镜像、拉依赖或健康检查超时。',
    fixTemplate: '稍后重试部署|检查外部依赖可达性|若持续失败联系平台管理员',
  },
];

@Injectable()
export class AIDeploymentCopilotService implements OnModuleInit {
  private readonly logger = new Logger(AIDeploymentCopilotService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaceAccess: WorkspaceAccessService,
    private readonly ai: AIProviderRouter,
    private readonly knowledge: DeploymentKnowledgeService,
    private readonly knowledgeExtract: KnowledgeExtractionService,
  ) {}

  async onModuleInit() {
    await this.ensureDefaultRules().catch((error) => {
      this.logger.warn(
        `ensureDefaultRules failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    });
  }

  async ensureDefaultRules() {
    for (const rule of DEFAULT_RULES) {
      const existing = await this.prisma.deploymentDiagnosisRule.findFirst({
        where: { name: rule.name },
        select: { id: true },
      });
      if (existing) continue;
      await this.prisma.deploymentDiagnosisRule.create({
        data: {
          name: rule.name,
          pattern: rule.pattern,
          category: rule.category,
          explanation: rule.explanation,
          fixTemplate: rule.fixTemplate,
          enabled: true,
        },
      });
    }
  }

  async getCopilot(userId: string, deploymentId: string, opts?: { force?: boolean }) {
    await this.workspaceAccess.requireDeploymentAccess(userId, deploymentId);
    if (!opts?.force) {
      const latest = await this.prisma.deploymentInsight.findFirst({
        where: { deploymentId },
        orderBy: { createdAt: 'desc' },
      });
      if (latest) {
        return this.presentInsight(deploymentId, latest);
      }
    }
    return this.analyzeDeployment(userId, deploymentId);
  }

  async analyzeDeployment(userId: string, deploymentId: string) {
    await this.workspaceAccess.requireDeploymentAccess(userId, deploymentId);
    return this.analyzeDeploymentInternal(deploymentId);
  }

  async analyzeDeploymentAsAdmin(deploymentId: string) {
    return this.analyzeDeploymentInternal(deploymentId);
  }

  async getCopilotAsAdmin(deploymentId: string, opts?: { force?: boolean }) {
    if (!opts?.force) {
      const latest = await this.prisma.deploymentInsight.findFirst({
        where: { deploymentId },
        orderBy: { createdAt: 'desc' },
      });
      if (latest) return this.presentInsight(deploymentId, latest);
    }
    return this.analyzeDeploymentInternal(deploymentId);
  }

  async platformStats(days = 30) {
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const [failureCount, insights] = await Promise.all([
      this.prisma.deployment.count({
        where: { status: 'FAILED', createdAt: { gte: since } },
      }),
      this.prisma.deploymentInsight.findMany({
        where: { createdAt: { gte: since } },
        select: { category: true },
        take: 2000,
      }),
    ]);

    // Also classify raw failures without insight using failureCode/errorMessage
    const rawFailed = await this.prisma.deployment.findMany({
      where: { status: 'FAILED', createdAt: { gte: since } },
      select: { failureCode: true, errorMessage: true },
      take: 500,
      orderBy: { createdAt: 'desc' },
    });

    const buckets = new Map<string, number>();
    for (const row of insights) {
      buckets.set(row.category, (buckets.get(row.category) || 0) + 1);
    }
    for (const row of rawFailed) {
      const cat = mapCategoryFromText(row.failureCode, row.errorMessage);
      const label = categoryLabel(cat);
      buckets.set(label, (buckets.get(label) || 0) + 1);
    }

    const topReasons = Array.from(buckets.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([reason, count]) => ({ reason, count }));

    return {
      windowDays: days,
      failureCount,
      insightCount: insights.length,
      topReasons,
      summary:
        failureCount === 0
          ? `过去${days}天暂无部署失败`
          : `过去${days}天\n部署失败：${failureCount}\nTOP原因：\n${topReasons
              .slice(0, 3)
              .map((r, i) => `${i + 1}. ${r.reason}\n${r.count}`)
              .join('\n\n')}`,
      note: '统计仅供运营参考；AI 不会自动修复部署。',
    };
  }

  private async analyzeDeploymentInternal(deploymentId: string): Promise<CopilotResult> {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: {
        id: true,
        status: true,
        currentStage: true,
        failureCode: true,
        errorMessage: true,
        version: true,
        releaseLabel: true,
        sourceRevision: true,
        finishedAt: true,
        createdAt: true,
        projectId: true,
        stageHistory: true,
        logs: {
          orderBy: { createdAt: 'desc' },
          take: 40,
          select: { level: true, message: true, createdAt: true },
        },
        diagnoses: {
          orderBy: { createdAt: 'desc' },
          take: 3,
          select: { category: true, title: true, description: true, fixPrompt: true },
        },
      },
    });
    if (!deployment) throw new NotFoundException('Deployment not found');

    const safeLogs = deployment.logs
      .map((l) => redactText(String(l.message || '')))
      .filter(Boolean)
      .slice(0, 30);
    const haystack = [
      deployment.failureCode || '',
      redactText(deployment.errorMessage || ''),
      ...safeLogs,
      ...deployment.diagnoses.map((d) => `${d.category} ${d.title} ${redactText(d.description || '')}`),
    ]
      .join('\n')
      .slice(0, 8000);

    const project = await this.prisma.project.findUnique({
      where: { id: deployment.projectId },
      select: { framework: true },
    });

    // Layer 0: Knowledge match (historically validated solutions)
    const knowledgeHits = await this.knowledge.findRelevantKnowledge({
      errorMessage: deployment.errorMessage,
      failureCode: deployment.failureCode,
      category: deployment.diagnoses[0]?.category || null,
      framework: project?.framework || null,
      logHints: safeLogs.slice(0, 8).join(' | '),
    });
    const knowledgeReferences = knowledgeHits.map((k) => ({
      id: k.id,
      title: k.title,
      successRate: k.successRate,
      usageCount: k.usageCount,
      confidence: k.confidence,
    }));

    const rules = await this.prisma.deploymentDiagnosisRule.findMany({
      where: { enabled: true },
      orderBy: { createdAt: 'asc' },
    });
    let matched: (typeof rules)[number] | null = null;
    for (const rule of rules) {
      try {
        const re = new RegExp(rule.pattern, 'i');
        if (re.test(haystack)) {
          matched = rule;
          break;
        }
      } catch {
        if (haystack.toLowerCase().includes(rule.pattern.toLowerCase())) {
          matched = rule;
          break;
        }
      }
    }

    let result: CopilotResult;
    const topKnowledge: KnowledgeMatch | undefined = knowledgeHits[0];
    if (topKnowledge && topKnowledge.confidence >= 0.55) {
      result = {
        category: mapKnowledgeToInsight(topKnowledge.category),
        summary: topKnowledge.title,
        rootCause: topKnowledge.reason,
        impact: impactForCategory(mapKnowledgeToInsight(topKnowledge.category)),
        fixActions: topKnowledge.solutionSteps.map((title, index) => ({
          step: index + 1,
          title,
        })),
        confidence: Math.max(0.7, topKnowledge.confidence),
        source: 'KNOWLEDGE',
        failedStage: deployment.currentStage,
        failureCode: deployment.failureCode,
        matchedRule: topKnowledge.title,
        timeline: buildTimeline(deployment.currentStage, true),
        knowledgeReferences,
      };
    } else if (matched) {
      const fixActions = matched.fixTemplate
        .split('|')
        .map((t) => t.trim())
        .filter(Boolean)
        .map((title, index) => ({ step: index + 1, title }));
      result = {
        category: matched.category as DeploymentInsightCategory,
        summary: matched.name,
        rootCause: matched.explanation,
        impact: impactForCategory(matched.category as DeploymentInsightCategory),
        fixActions,
        confidence: 0.86,
        source: 'RULE',
        failedStage: deployment.currentStage,
        failureCode: deployment.failureCode,
        matchedRule: matched.name,
        timeline: buildTimeline(deployment.currentStage, true),
        knowledgeReferences,
      };
    } else {
      // Layer 2: optional AI narrative on sanitized facts
      const category = mapCategoryFromText(deployment.failureCode, deployment.errorMessage);
      const facts = JSON.stringify(
        sanitizeAiMetadata({
          status: deployment.status,
          stage: deployment.currentStage || '',
          failureCode: deployment.failureCode || '',
          errorHint: redactText(deployment.errorMessage || '').slice(0, 200),
          logHints: safeLogs.slice(0, 5).join(' | ').slice(0, 400),
          diagnosis: deployment.diagnoses[0]?.category || '',
          knowledgeHint: topKnowledge?.title || '',
        }),
      );
      const aiText = await this.ai
        .generateText(
          `你是 LaunchOS 部署诊断助手。仅基于 FACTS 给出简短根因与修复建议，不要输出密钥，不要建议自动改代码。\n\nFACTS:\n${facts}`,
        )
        .catch(() => '');

      const coarse = categorizeFailure(deployment.failureCode, deployment.errorMessage);
      result = {
        category,
        summary: coarse,
        rootCause:
          redactText(aiText).slice(0, 500) ||
          redactText(deployment.errorMessage || '') ||
          '未能匹配已知失败模式，请查看构建/运行日志中的首个错误。',
        impact: impactForCategory(category),
        fixActions: topKnowledge?.solutionSteps?.length
          ? topKnowledge.solutionSteps.map((title, index) => ({ step: index + 1, title }))
          : [
              { step: 1, title: '查看部署日志中的首个 ERROR' },
              { step: 2, title: '对照失败阶段检查配置或依赖' },
              { step: 3, title: '修复后重新上线' },
            ],
        confidence: aiText ? 0.55 : 0.35,
        source: aiText ? 'AI' : 'FALLBACK',
        failedStage: deployment.currentStage,
        failureCode: deployment.failureCode,
        matchedRule: null,
        timeline: buildTimeline(deployment.currentStage, deployment.status === 'FAILED'),
        knowledgeReferences,
      };
    }

    const similarCount = await this.prisma.deploymentInsight.count({
      where: {
        category: result.category,
        createdAt: { gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) },
      },
    });
    result.similarCount = similarCount;

    const saved = await this.prisma.deploymentInsight.create({
      data: {
        deploymentId,
        category: result.category,
        summary: result.summary.slice(0, 200),
        rootCause: result.rootCause.slice(0, 2000),
        impact: result.impact.slice(0, 500),
        fixActionsJson: result.fixActions as unknown as Prisma.InputJsonValue,
        confidence: result.confidence,
        source: result.source,
      },
    });
    result.insightId = saved.id;

    return {
      ...result,
      deployment: {
        id: deployment.id,
        status: deployment.status,
        failedStage: deployment.currentStage,
        finishedAt: deployment.finishedAt,
        version: deployment.releaseLabel || deployment.version,
        commit: deployment.sourceRevision,
        projectId: deployment.projectId,
        failureCode: deployment.failureCode,
      },
      note: 'AI 仅提供分析与建议，不会自动修改代码或执行修复。',
    } as CopilotResult & {
      deployment: Record<string, unknown>;
      note: string;
    };
  }

  private async presentInsight(
    deploymentId: string,
    latest: {
      id: string;
      category: string;
      summary: string;
      rootCause: string;
      impact: string;
      fixActionsJson: Prisma.JsonValue;
      confidence: number;
      source: string;
      createdAt: Date;
    },
  ) {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: {
        id: true,
        status: true,
        currentStage: true,
        failureCode: true,
        finishedAt: true,
        version: true,
        releaseLabel: true,
        sourceRevision: true,
        projectId: true,
      },
    });
    if (!deployment) throw new NotFoundException('Deployment not found');
    const fixActions = Array.isArray(latest.fixActionsJson)
      ? (latest.fixActionsJson as Array<{ step?: number; title?: string; detail?: string }>).map(
          (item, index) => ({
            step: item.step ?? index + 1,
            title: String(item.title || '检查日志'),
            detail: item.detail ? String(item.detail) : undefined,
          }),
        )
      : [];
    const similarCount = await this.prisma.deploymentInsight.count({
      where: {
        category: latest.category as DeploymentInsightCategory,
        createdAt: { gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) },
      },
    });
    const knowledgeHits = await this.knowledge.findRelevantKnowledge({
      category: latest.category,
      failureCode: deployment.failureCode,
      errorMessage: latest.rootCause,
    });
    return {
      category: latest.category,
      summary: latest.summary,
      rootCause: latest.rootCause,
      impact: latest.impact,
      fixActions,
      confidence: latest.confidence,
      source: latest.source,
      failedStage: deployment.currentStage,
      failureCode: deployment.failureCode,
      insightId: latest.id,
      matchedRule: latest.source === 'RULE' || latest.source === 'KNOWLEDGE' ? latest.summary : null,
      timeline: buildTimeline(deployment.currentStage, deployment.status === 'FAILED'),
      similarCount,
      knowledgeReferences: knowledgeHits.map((k) => ({
        id: k.id,
        title: k.title,
        successRate: k.successRate,
        usageCount: k.usageCount,
        confidence: k.confidence,
      })),
      deployment: {
        id: deployment.id,
        status: deployment.status,
        failedStage: deployment.currentStage,
        finishedAt: deployment.finishedAt,
        version: deployment.releaseLabel || deployment.version,
        commit: deployment.sourceRevision,
        projectId: deployment.projectId,
        failureCode: deployment.failureCode,
      },
      note: 'AI 仅提供分析与建议，不会自动修改代码或执行修复。',
      cached: true,
      createdAt: latest.createdAt,
    };
  }

  /** Called when a deployment succeeds — may create a knowledge candidate from prior failure. */
  async onDeploymentSucceeded(deploymentId: string) {
    return this.knowledgeExtract.extractFromSuccessfulDeployment(deploymentId);
  }
}

function buildTimeline(stage: string | null, failed: boolean) {
  const failedStage = (stage || 'BUILD').toUpperCase();
  return [
    { key: 'STAGE', label: failedStage, status: failed ? ('FAILED' as const) : ('DONE' as const) },
    { key: 'FAIL', label: '失败', status: failed ? ('FAILED' as const) : ('PENDING' as const) },
    { key: 'AI', label: 'AI分析', status: 'AI' as const },
    { key: 'FIX', label: '生成建议', status: 'DONE' as const },
  ];
}

function impactForCategory(category: DeploymentInsightCategory): string {
  switch (category) {
    case 'BUILD_ERROR':
      return 'Docker build 无法完成，应用未进入运行阶段';
    case 'DEPENDENCY_ERROR':
      return '依赖未安装成功，后续构建/启动无法继续';
    case 'CONFIG_ERROR':
      return '缺少运行配置，服务无法正确启动';
    case 'RUNTIME_ERROR':
      return '进程启动或端口监听异常，公网不可用';
    case 'NETWORK_ERROR':
      return '网络中断或超时，部署步骤未完成';
    case 'PLATFORM_ERROR':
      return '平台侧资源或调度异常';
    default:
      return '部署未成功完成，请按建议排查后重新上线';
  }
}

function mapCategoryFromText(
  code: string | null | undefined,
  message: string | null | undefined,
): DeploymentInsightCategory {
  const raw = `${code || ''} ${message || ''}`.toLowerCase();
  if (/prisma|schema|dockerfile|build_failed|docker build/.test(raw)) return 'BUILD_ERROR';
  if (/npm err|pnpm|yarn|dependency|eresolve/.test(raw)) return 'DEPENDENCY_ERROR';
  if (/runtime_config|config_missing|env|environment/.test(raw)) return 'CONFIG_ERROR';
  if (/connection refused|eaddrinuse|port|crash|health/.test(raw)) return 'RUNTIME_ERROR';
  if (/timeout|network|econn|tls/.test(raw)) return 'NETWORK_ERROR';
  if (/quota|capacity|platform|worker/.test(raw)) return 'PLATFORM_ERROR';
  return 'UNKNOWN';
}

function mapKnowledgeToInsight(
  category: string,
): DeploymentInsightCategory {
  switch (category) {
    case 'DOCKER_ERROR':
    case 'DATABASE_ERROR':
      return 'BUILD_ERROR';
    case 'BUILD_ERROR':
    case 'DEPENDENCY_ERROR':
    case 'CONFIG_ERROR':
    case 'RUNTIME_ERROR':
    case 'NETWORK_ERROR':
      return category;
    default:
      return 'UNKNOWN';
  }
}

function categoryLabel(category: DeploymentInsightCategory): string {
  const map: Record<DeploymentInsightCategory, string> = {
    BUILD_ERROR: 'Docker/构建问题',
    DEPENDENCY_ERROR: '依赖安装失败',
    CONFIG_ERROR: '环境变量缺失',
    RUNTIME_ERROR: '启动/端口异常',
    NETWORK_ERROR: '网络/超时',
    PLATFORM_ERROR: '平台问题',
    UNKNOWN: '其他失败',
  };
  return map[category];
}
