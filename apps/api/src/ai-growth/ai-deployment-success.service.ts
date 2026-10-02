import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@launchos/database';
import { PrismaService } from '../database/prisma.service';
import { AIProviderRouter } from './ai-provider';
import { redactText, sanitizeAiMetadata } from './ai-sanitize';
import {
  AIProductRecommendationService,
  type SuccessMetrics,
  topFailureCategories,
} from './ai-product-recommendation.service';

@Injectable()
export class AIDeploymentSuccessOptimizerService implements OnModuleInit {
  private readonly logger = new Logger(AIDeploymentSuccessOptimizerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AIProviderRouter,
    private readonly recommendations: AIProductRecommendationService,
  ) {}

  async onModuleInit() {
    await this.refreshSnapshots(30).catch((error) => {
      this.logger.warn(
        `refreshSnapshots failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    });
  }

  async refreshSnapshots(days = 30) {
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const deployments = await this.prisma.deployment.findMany({
      where: {
        createdAt: { gte: since },
        status: { in: ['SUCCESS', 'FAILED'] },
      },
      select: {
        id: true,
        status: true,
        failureCode: true,
        errorMessage: true,
        createdAt: true,
        startedAt: true,
        finishedAt: true,
        projectId: true,
        project: {
          select: {
            id: true,
            workspaceId: true,
            framework: true,
          },
        },
        insights: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { category: true },
        },
      },
      take: 2000,
      orderBy: { createdAt: 'asc' },
    });

    let written = 0;
    for (const d of deployments) {
      const existing = await this.prisma.deploymentSuccessSnapshot.findFirst({
        where: { deploymentId: d.id },
        select: { id: true },
      });
      if (existing) continue;

      const attemptCount = await this.prisma.deployment.count({
        where: {
          projectId: d.projectId,
          createdAt: { lte: d.createdAt },
          status: { in: ['SUCCESS', 'FAILED'] },
        },
      });
      const durationMs =
        d.startedAt && d.finishedAt
          ? Math.max(0, d.finishedAt.getTime() - d.startedAt.getTime())
          : d.finishedAt
            ? Math.max(0, d.finishedAt.getTime() - d.createdAt.getTime())
            : null;
      const success = d.status === 'SUCCESS';
      const failureCategory = success
        ? null
        : d.insights[0]?.category || classifyFailure(d.failureCode, d.errorMessage);

      await this.prisma.deploymentSuccessSnapshot.create({
        data: {
          workspaceId: d.project.workspaceId,
          projectId: d.projectId,
          framework: normalizeFramework(d.project.framework),
          language: inferLanguage(d.project.framework),
          deploymentStatus: success ? 'SUCCESS' : 'FAILED',
          attemptCount,
          success,
          failureCategory,
          deploymentDuration: durationMs,
          deploymentId: d.id,
          createdAt: d.createdAt,
        },
      });
      written += 1;
    }

    await this.refreshFunnelFromProduct(days).catch(() => undefined);
    await this.refreshPatterns().catch(() => undefined);
    return { scanned: deployments.length, written };
  }

  async refreshFunnelFromProduct(days = 30) {
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const events = await this.prisma.productEvent.findMany({
      where: { createdAt: { gte: since } },
      select: { name: true, workspaceId: true, projectId: true, createdAt: true, metadata: true },
      take: 3000,
      orderBy: { createdAt: 'desc' },
    });

    let written = 0;
    for (const ev of events) {
      const stage = mapProductEventToFunnel(ev.name, ev.metadata);
      if (!stage || !ev.workspaceId) continue;
      const dup = await this.prisma.deploymentFunnelEvent.findFirst({
        where: {
          workspaceId: ev.workspaceId,
          projectId: ev.projectId || null,
          stage,
          createdAt: {
            gte: new Date(ev.createdAt.getTime() - 60_000),
            lte: new Date(ev.createdAt.getTime() + 60_000),
          },
        },
        select: { id: true },
      });
      if (dup) continue;
      await this.prisma.deploymentFunnelEvent.create({
        data: {
          workspaceId: ev.workspaceId,
          projectId: ev.projectId || null,
          stage,
          status: 'OK',
          createdAt: ev.createdAt,
        },
      });
      written += 1;
    }

    const projects = await this.prisma.project.findMany({
      where: { createdAt: { gte: since } },
      select: {
        id: true,
        workspaceId: true,
        createdAt: true,
        sources: { select: { id: true }, take: 1 },
        configRequirements: { select: { id: true, required: true }, take: 20 },
        configValues: { select: { id: true }, take: 5 },
        deployments: {
          orderBy: { createdAt: 'asc' },
          take: 3,
          select: { id: true, status: true, createdAt: true },
        },
        deploymentPreflights: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, createdAt: true, status: true },
        },
      },
      take: 500,
    });

    for (const p of projects) {
      const ensure = async (
        stage:
          | 'SOURCE_CONNECTED'
          | 'CONFIG_COMPLETED'
          | 'PREFLIGHT_COMPLETED'
          | 'DEPLOY_STARTED'
          | 'BUILD_SUCCESS'
          | 'RUNTIME_HEALTHY',
        at: Date,
      ) => {
        const exists = await this.prisma.deploymentFunnelEvent.findFirst({
          where: { projectId: p.id, stage },
          select: { id: true },
        });
        if (exists) return;
        await this.prisma.deploymentFunnelEvent.create({
          data: {
            workspaceId: p.workspaceId,
            projectId: p.id,
            stage,
            status: 'OK',
            createdAt: at,
          },
        });
        written += 1;
      };

      if (p.sources.length > 0) await ensure('SOURCE_CONNECTED', p.createdAt);
      const required = p.configRequirements.filter((r) => r.required);
      if (required.length === 0 || p.configValues.length > 0) {
        await ensure('CONFIG_COMPLETED', p.createdAt);
      }
      if (p.deploymentPreflights[0]) {
        await ensure('PREFLIGHT_COMPLETED', p.deploymentPreflights[0].createdAt);
      }
      if (p.deployments[0]) {
        await ensure('DEPLOY_STARTED', p.deployments[0].createdAt);
        if (p.deployments.some((d) => d.status === 'SUCCESS')) {
          const ok = p.deployments.find((d) => d.status === 'SUCCESS')!;
          await ensure('BUILD_SUCCESS', ok.createdAt);
          await ensure('RUNTIME_HEALTHY', ok.createdAt);
        }
      }
    }

    return { written };
  }

  async refreshPatterns() {
    const snapshots = await this.prisma.deploymentSuccessSnapshot.findMany({
      take: 5000,
      select: { framework: true, success: true, failureCategory: true, attemptCount: true },
    });
    const byFw = new Map<string, { ok: number; total: number }>();
    for (const row of snapshots) {
      const fw = row.framework || 'unknown';
      const cur = byFw.get(fw) || { ok: 0, total: 0 };
      cur.total += 1;
      if (row.success) cur.ok += 1;
      byFw.set(fw, cur);
    }

    for (const [framework, stats] of byFw.entries()) {
      if (stats.total < 1) continue;
      const successRate = stats.ok / stats.total;
      const existing = await this.prisma.deploymentSuccessPattern.findFirst({
        where: { patternType: 'FRAMEWORK_PATTERN', framework },
        select: { id: true },
      });
      const data = {
        patternType: 'FRAMEWORK_PATTERN' as const,
        framework,
        conditionJson: { framework } as Prisma.InputJsonValue,
        successRate,
        sampleCount: stats.total,
        confidence: Math.min(0.95, 0.4 + Math.min(stats.total, 50) / 100),
      };
      if (existing) {
        await this.prisma.deploymentSuccessPattern.update({
          where: { id: existing.id },
          data,
        });
      } else {
        await this.prisma.deploymentSuccessPattern.create({ data });
      }
    }

    const configFails = snapshots.filter((s) => !s.success && s.failureCategory === 'CONFIG_ERROR');
    const configRate =
      snapshots.length === 0
        ? 0
        : 1 - configFails.length / Math.max(1, snapshots.filter((s) => !s.success).length || 1);
    await upsertNamedPattern(this.prisma, {
      patternType: 'CONFIG_PATTERN',
      framework: null,
      conditionJson: { failureCategory: 'CONFIG_ERROR' },
      successRate: Math.max(0, Math.min(1, configRate)),
      sampleCount: snapshots.length,
      confidence: 0.7,
    });

    return { frameworks: byFw.size };
  }

  async analyzeSuccessRate(days = 30) {
    await this.refreshSnapshots(days).catch(() => undefined);
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const snapshots = await this.prisma.deploymentSuccessSnapshot.findMany({
      where: { createdAt: { gte: since } },
      select: {
        success: true,
        framework: true,
        failureCategory: true,
        attemptCount: true,
        projectId: true,
        createdAt: true,
      },
      take: 5000,
    });

    const deploymentCount = snapshots.length;
    const successCount = snapshots.filter((s) => s.success).length;
    const failureCount = deploymentCount - successCount;
    const successRate = deploymentCount === 0 ? 0 : successCount / deploymentCount;

    const firstByProject = new Map<string, (typeof snapshots)[number]>();
    for (const row of snapshots) {
      const prev = firstByProject.get(row.projectId);
      if (!prev || row.createdAt < prev.createdAt || row.attemptCount < prev.attemptCount) {
        firstByProject.set(row.projectId, row);
      }
    }
    const firsts = Array.from(firstByProject.values()).map((row) => {
      const exact = snapshots.find((s) => s.projectId === row.projectId && s.attemptCount === 1);
      return exact || row;
    });
    const firstDeploymentCount = firsts.length;
    const firstDeploymentSuccessCount = firsts.filter((s) => s.success).length;
    const firstDeploymentSuccessRate =
      firstDeploymentCount === 0 ? 0 : firstDeploymentSuccessCount / firstDeploymentCount;

    const successAttempts = snapshots.filter((s) => s.success).map((s) => s.attemptCount);
    const avgAttemptsToSuccess =
      successAttempts.length === 0
        ? null
        : successAttempts.reduce((a, b) => a + b, 0) / successAttempts.length;

    const metrics: SuccessMetrics = {
      windowDays: days,
      deploymentCount,
      successCount,
      failureCount,
      successRate,
      firstDeploymentSuccessRate,
      firstDeploymentCount,
      firstDeploymentSuccessCount,
      avgAttemptsToSuccess,
    };

    const frameworks = await this.frameworkStats(days);
    const topBlockers = topFailureCategories(snapshots);
    const patterns = await this.prisma.deploymentSuccessPattern.findMany({
      orderBy: [{ successRate: 'desc' }, { sampleCount: 'desc' }],
      take: 20,
    });
    const funnel = await this.funnelStats(days);
    const risks = buildRisks(metrics, topBlockers, frameworks);
    const recommendations = await this.recommendations.listOrGenerate(
      metrics,
      topBlockers,
      frameworks,
    );

    const facts = JSON.stringify(
      sanitizeAiMetadata({
        successRate: Number(successRate.toFixed(3)),
        firstSuccessRate: Number(firstDeploymentSuccessRate.toFixed(3)),
        topBlocker: topBlockers[0]?.reason || '',
        topFrameworkRisk: frameworks.find((f) => f.successRate < 0.8)?.framework || '',
        deploymentCount,
      }),
    );
    const aiSummary = await this.ai
      .generateText(
        `你是 LaunchOS 成功率优化助手。仅基于 FACTS 用两三句中文总结平台部署健康与优先改进点，不要输出密钥，不要建议自动改代码或自动改产品流程。\nFACTS:\n${facts}`,
      )
      .catch(() => '');

    return {
      metrics,
      frameworks,
      topBlockers,
      patterns: patterns.map((p) => ({
        id: p.id,
        patternType: p.patternType,
        framework: p.framework,
        condition: p.conditionJson,
        successRate: p.successRate,
        sampleCount: p.sampleCount,
        confidence: p.confidence,
      })),
      funnel,
      risks,
      recommendations,
      summary:
        redactText(aiSummary).slice(0, 500) ||
        `过去${days}天部署成功率 ${(successRate * 100).toFixed(1)}%，首次部署成功率 ${(firstDeploymentSuccessRate * 100).toFixed(1)}%。`,
      note: '仅分析和建议，不会自动修改产品流程或用户项目。',
    };
  }

  async frameworkStats(days = 30) {
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const rows = await this.prisma.deploymentSuccessSnapshot.findMany({
      where: { createdAt: { gte: since } },
      select: { framework: true, success: true },
      take: 5000,
    });
    const map = new Map<string, { ok: number; total: number }>();
    for (const row of rows) {
      const fw = row.framework || 'unknown';
      const cur = map.get(fw) || { ok: 0, total: 0 };
      cur.total += 1;
      if (row.success) cur.ok += 1;
      map.set(fw, cur);
    }
    return Array.from(map.entries())
      .map(([framework, s]) => ({
        framework,
        deploymentCount: s.total,
        successCount: s.ok,
        successRate: s.total === 0 ? 0 : s.ok / s.total,
      }))
      .sort((a, b) => b.deploymentCount - a.deploymentCount);
  }

  async funnelStats(days = 30) {
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const stages = [
      'SOURCE_CONNECTED',
      'CONFIG_COMPLETED',
      'PREFLIGHT_COMPLETED',
      'DEPLOY_STARTED',
      'BUILD_SUCCESS',
      'RUNTIME_HEALTHY',
    ] as const;
    const counts: Array<{ stage: string; count: number }> = [];
    for (const stage of stages) {
      const count = await this.prisma.deploymentFunnelEvent
        .groupBy({
          by: ['projectId'],
          where: { stage, createdAt: { gte: since }, projectId: { not: null } },
        })
        .then((rows) => rows.length);
      counts.push({ stage, count });
    }
    return {
      stages: counts,
      dropoffs: counts.slice(0, -1).map((cur, i) => {
        const next = counts[i + 1]!;
        const drop = Math.max(0, cur.count - next.count);
        return {
          from: cur.stage,
          to: next.stage,
          drop,
          dropRate: cur.count === 0 ? 0 : drop / cur.count,
        };
      }),
    };
  }
}

function buildRisks(
  metrics: SuccessMetrics,
  topBlockers: Array<{ reason: string; count: number }>,
  frameworks: Array<{ framework: string; successRate: number; deploymentCount: number }>,
) {
  const risks: Array<{ level: 'HIGH' | 'MEDIUM' | 'LOW'; title: string; detail: string }> = [];
  if (metrics.firstDeploymentSuccessRate < 0.7 && metrics.firstDeploymentCount >= 3) {
    risks.push({
      level: 'HIGH',
      title: '首次部署成功率偏低',
      detail: `首次成功率 ${(metrics.firstDeploymentSuccessRate * 100).toFixed(1)}%`,
    });
  }
  if (topBlockers[0]) {
    risks.push({
      level: 'MEDIUM',
      title: `主要阻塞：${topBlockers[0].reason}`,
      detail: `近窗出现 ${topBlockers[0].count} 次`,
    });
  }
  const weak = frameworks.find((f) => f.deploymentCount >= 5 && f.successRate < 0.75);
  if (weak) {
    risks.push({
      level: 'MEDIUM',
      title: `${weak.framework} 成功率偏低`,
      detail: `${(weak.successRate * 100).toFixed(1)}%（n=${weak.deploymentCount}）`,
    });
  }
  if (risks.length === 0) {
    risks.push({
      level: 'LOW',
      title: '暂无明显系统性风险',
      detail: '继续观察首次成功率与配置类失败占比',
    });
  }
  return risks;
}

function normalizeFramework(raw: string | null | undefined): string {
  const s = String(raw || 'unknown').toLowerCase();
  if (s.includes('next')) return 'nextjs';
  if (s.includes('vite')) return 'vite';
  if (s.includes('nest')) return 'nestjs';
  if (s.includes('express') || s.includes('node')) return 'node';
  return s.slice(0, 40) || 'unknown';
}

function inferLanguage(framework: string | null | undefined): string {
  const fw = normalizeFramework(framework);
  if (fw === 'nestjs' || fw === 'node') return 'typescript';
  if (fw === 'nextjs' || fw === 'vite') return 'typescript';
  return 'unknown';
}

function classifyFailure(code: string | null | undefined, message: string | null | undefined): string {
  const raw = `${code || ''} ${message || ''}`.toLowerCase();
  if (/runtime_config|config_missing|env|environment|auth_secret/.test(raw)) return 'CONFIG_ERROR';
  if (/npm err|pnpm|yarn|eresolve|dependency/.test(raw)) return 'DEPENDENCY_ERROR';
  if (/prisma|schema\.prisma|database/.test(raw)) return 'DATABASE_ERROR';
  if (/docker|dockerfile|build_failed|failed to solve/.test(raw)) return 'BUILD_ERROR';
  if (/connection refused|eaddrinuse|port|health/.test(raw)) return 'RUNTIME_ERROR';
  if (/timeout|network|econn|tls/.test(raw)) return 'NETWORK_ERROR';
  return 'UNKNOWN';
}

function mapProductEventToFunnel(
  name: string,
  metadata: unknown,
):
  | 'SOURCE_CONNECTED'
  | 'CONFIG_COMPLETED'
  | 'PREFLIGHT_COMPLETED'
  | 'DEPLOY_STARTED'
  | 'BUILD_SUCCESS'
  | 'RUNTIME_HEALTHY'
  | null {
  const n = name.toLowerCase();
  const meta = metadata && typeof metadata === 'object' ? JSON.stringify(metadata).toLowerCase() : '';
  if (/source|git|repo|connect/.test(n) || /source_connected/.test(meta)) return 'SOURCE_CONNECTED';
  if (/config|env|runtime_config/.test(n)) return 'CONFIG_COMPLETED';
  if (/preflight/.test(n)) return 'PREFLIGHT_COMPLETED';
  if (/deploy_start|deployment_created|go_live/.test(n)) return 'DEPLOY_STARTED';
  if (/build_success|deploy_success/.test(n)) return 'BUILD_SUCCESS';
  if (/runtime_healthy|health_ok/.test(n)) return 'RUNTIME_HEALTHY';
  return null;
}

async function upsertNamedPattern(
  prisma: PrismaService,
  data: {
    patternType: 'FRAMEWORK_PATTERN' | 'CONFIG_PATTERN' | 'PROJECT_PATTERN' | 'USER_BEHAVIOR_PATTERN';
    framework: string | null;
    conditionJson: Record<string, unknown>;
    successRate: number;
    sampleCount: number;
    confidence: number;
  },
) {
  const existing = await prisma.deploymentSuccessPattern.findFirst({
    where: {
      patternType: data.patternType,
      framework: data.framework,
    },
    select: { id: true },
  });
  if (existing) {
    await prisma.deploymentSuccessPattern.update({
      where: { id: existing.id },
      data: {
        conditionJson: data.conditionJson as Prisma.InputJsonValue,
        successRate: data.successRate,
        sampleCount: data.sampleCount,
        confidence: data.confidence,
      },
    });
    return;
  }
  await prisma.deploymentSuccessPattern.create({
    data: {
      patternType: data.patternType,
      framework: data.framework,
      conditionJson: data.conditionJson as Prisma.InputJsonValue,
      successRate: data.successRate,
      sampleCount: data.sampleCount,
      confidence: data.confidence,
    },
  });
}
