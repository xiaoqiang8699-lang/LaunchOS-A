import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@launchos/database';
import { PrismaService } from '../database/prisma.service';
import { RuntimeConfigService } from '../runtime-config/runtime-config.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import { AIProviderRouter } from './ai-provider';
import { redactText, sanitizeAiMetadata } from './ai-sanitize';

export type PreflightStatus = 'PASSED' | 'WARNING' | 'BLOCKED';
export type PreflightRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type PreflightCategory = 'CONFIG' | 'DEPENDENCY' | 'FRAMEWORK' | 'DOCKER' | 'RUNTIME';
export type PreflightSeverity = 'INFO' | 'WARNING' | 'BLOCKER';

export type PreflightCheck = {
  id: string;
  name: string;
  category: PreflightCategory;
  severity: PreflightSeverity;
  passed: boolean;
  title: string;
  reason: string;
  suggestion: string;
};

type PreflightResult = {
  id?: string;
  projectId: string;
  deployableUnitId: string | null;
  status: PreflightStatus;
  riskLevel: PreflightRiskLevel;
  checks: PreflightCheck[];
  recommendations: string[];
  summary: string;
  confidence: number;
  source: 'RULE' | 'AI' | 'FALLBACK';
  passedCount: number;
  riskCount: number;
  note?: string;
  allowDeploy: boolean;
  requireConfirm: boolean;
};

const DEFAULT_RULES: Array<{
  name: string;
  category: PreflightCategory;
  pattern: string;
  severity: PreflightSeverity;
  description: string;
  suggestion: string;
}> = [
  {
    name: '缺少必需运行配置',
    category: 'CONFIG',
    pattern: 'MISSING_REQUIRED_CONFIG',
    severity: 'BLOCKER',
    description: '运行配置缺失，部署后可能无法启动。',
    suggestion: '进入配置中心补充缺失的环境变量（勿粘贴密钥到聊天）。',
  },
  {
    name: 'Prisma Schema 风险',
    category: 'DOCKER',
    pattern: 'PRISMA_SCHEMA_RISK',
    severity: 'WARNING',
    description: '检测到 Prisma 相关配置，Docker 构建可能缺少 schema。',
    suggestion: '确认 Dockerfile COPY 顺序，确保 prisma/schema.prisma 在 generate 之前复制。',
  },
  {
    name: '依赖锁文件风险',
    category: 'DEPENDENCY',
    pattern: 'LOCKFILE_RISK',
    severity: 'WARNING',
    description: '依赖安装可能因缺少 lockfile 或不一致而失败。',
    suggestion: '确认 package-lock.json / pnpm-lock.yaml / yarn.lock 已提交。',
  },
  {
    name: '启动命令缺失',
    category: 'FRAMEWORK',
    pattern: 'START_COMMAND_MISSING',
    severity: 'WARNING',
    description: '启动配置可能异常，进程可能无法正确启动。',
    suggestion: '检查 startCommand / package.json scripts / PORT 配置。',
  },
  {
    name: 'Docker 配置不完整',
    category: 'DOCKER',
    pattern: 'DOCKER_CONFIG_RISK',
    severity: 'WARNING',
    description: 'Dockerfile 相关信息不足，构建或端口暴露可能异常。',
    suggestion: '检查 Dockerfile 的 COPY、CMD/ENTRYPOINT、EXPOSE 与 PORT。',
  },
];

@Injectable()
export class AIDeploymentPreflightService implements OnModuleInit {
  private readonly logger = new Logger(AIDeploymentPreflightService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaceAccess: WorkspaceAccessService,
    private readonly runtimeConfig: RuntimeConfigService,
    private readonly ai: AIProviderRouter,
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
      const existing = await this.prisma.deploymentPreflightRule.findFirst({
        where: { name: rule.name },
        select: { id: true },
      });
      if (existing) continue;
      await this.prisma.deploymentPreflightRule.create({
        data: {
          name: rule.name,
          category: rule.category,
          pattern: rule.pattern,
          severity: rule.severity,
          description: rule.description,
          suggestion: rule.suggestion,
          enabled: true,
        },
      });
    }
  }

  async getLatest(userId: string, projectId: string, unitId?: string | null) {
    await this.workspaceAccess.requireProjectAccess(userId, projectId);
    const latest = await this.prisma.deploymentPreflight.findFirst({
      where: {
        projectId,
        ...(unitId ? { deployableUnitId: unitId } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!latest) {
      return this.runPreflight(userId, projectId, { unitId: unitId || undefined });
    }
    return this.present(latest);
  }

  async runPreflight(
    userId: string,
    projectId: string,
    opts?: { unitId?: string | null; force?: boolean },
  ) {
    await this.workspaceAccess.requireProjectAccess(userId, projectId);
    return this.runInternal(projectId, opts?.unitId || null);
  }

  async runAsAdmin(projectId: string, unitId?: string | null) {
    return this.runInternal(projectId, unitId || null);
  }

  async platformStats(days = 30) {
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const rows = await this.prisma.deploymentPreflight.findMany({
      where: { createdAt: { gte: since } },
      select: { status: true, riskLevel: true },
      take: 5000,
    });
    const total = rows.length;
    const riskCount = rows.filter((r) => r.status !== 'PASSED').length;
    const blockedCount = rows.filter((r) => r.status === 'BLOCKED').length;
    const warningCount = rows.filter((r) => r.status === 'WARNING').length;
    // Heuristic: blocked preflights that would have failed deploy = "avoided failures"
    const avoidedFailures = blockedCount;

    return {
      windowDays: days,
      preflightCount: total,
      riskCount,
      warningCount,
      blockedCount,
      avoidedFailures,
      summary:
        total === 0
          ? `过去${days}天暂无预检记录`
          : `过去${days}天\n预检次数：${total}\n发现风险：${riskCount}\n阻止部署：${blockedCount}\n避免失败：${avoidedFailures}`,
      note: '预检仅分析和建议，不会自动修改代码或绕过用户确认。',
    };
  }

  private async runInternal(projectId: string, unitId: string | null): Promise<PreflightResult> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        framework: true,
        selectedDeployableUnitId: true,
        sources: { select: { id: true, type: true }, take: 5 },
        deployableUnits: {
          where: { status: { not: 'IGNORED' } },
          orderBy: { updatedAt: 'desc' },
          take: 20,
          select: {
            id: true,
            name: true,
            framework: true,
            packageManager: true,
            buildCommand: true,
            startCommand: true,
            port: true,
            rootPath: true,
            deployable: true,
            metadata: true,
            status: true,
          },
        },
      },
    });
    if (!project) throw new NotFoundException('Project not found');

    const unit =
      project.deployableUnits.find((u) => u.id === unitId) ||
      project.deployableUnits.find((u) => u.id === project.selectedDeployableUnitId) ||
      project.deployableUnits[0] ||
      null;

    const checks: PreflightCheck[] = [];
    const signals: string[] = [];

    // 1. Source / unit readiness
    if (project.sources.length === 0) {
      checks.push({
        id: 'source',
        name: '源码检查',
        category: 'RUNTIME',
        severity: 'BLOCKER',
        passed: false,
        title: '未连接代码源',
        reason: '项目尚未连接仓库或上传源码，无法构建。',
        suggestion: '先连接 Git 仓库或上传代码后再上线。',
      });
      signals.push('SOURCE_NOT_READY');
    } else {
      checks.push({
        id: 'source',
        name: '源码检查',
        category: 'RUNTIME',
        severity: 'INFO',
        passed: true,
        title: '已连接代码源',
        reason: `已检测到 ${project.sources.length} 个源。`,
        suggestion: '保持代码最新即可。',
      });
    }

    if (!unit) {
      checks.push({
        id: 'unit',
        name: '可上线单元',
        category: 'FRAMEWORK',
        severity: 'BLOCKER',
        passed: false,
        title: '未检测到可上线单元',
        reason: '需要先完成项目分析并选择可上线内容。',
        suggestion: '打开分析页扫描 Deployable Unit 后再上线。',
      });
      signals.push('MISSING_UNIT');
    } else {
      checks.push({
        id: 'unit',
        name: '可上线单元',
        category: 'FRAMEWORK',
        severity: 'INFO',
        passed: true,
        title: `单元：${unit.name}`,
        reason: `framework=${unit.framework || 'unknown'} · root=${unit.rootPath}`,
        suggestion: '确认所选单元正确。',
      });
    }

    // 2. Environment / runtime config
    if (unit) {
      const missing = await this.runtimeConfig.getMissingRequired(projectId, unit.id).catch(() => []);
      const missingKeys = (missing || [])
        .map((item: { key?: string; label?: string }) => String(item.key || item.label || ''))
        .filter(Boolean)
        .slice(0, 20);
      if (missingKeys.length > 0) {
        checks.push({
          id: 'config',
          name: '环境变量检查',
          category: 'CONFIG',
          severity: 'BLOCKER',
          passed: false,
          title: '缺少必需运行配置',
          reason: `缺少：${missingKeys.join(', ')}`,
          suggestion: '进入配置中心补充后重新预检（勿粘贴密钥到聊天）。',
        });
        signals.push('MISSING_REQUIRED_CONFIG');
      } else {
        checks.push({
          id: 'config',
          name: '环境变量检查',
          category: 'CONFIG',
          severity: 'INFO',
          passed: true,
          title: '运行配置完整',
          reason: '未发现缺失的必需配置键。',
          suggestion: '保持配置与环境一致。',
        });
      }

      const reqKeys = await this.prisma.runtimeConfigRequirement.findMany({
        where: { projectId, deployableUnitId: unit.id },
        select: { key: true },
        take: 100,
      });
      const keyBlob = reqKeys.map((r) => r.key).join(' ').toLowerCase();
      const meta = asRecord(unit.metadata);
      const metaText = JSON.stringify(sanitizeAiMetadata(meta)).toLowerCase();
      const prismaHint =
        /prisma|database_url|datasource/.test(keyBlob) ||
        /prisma|schema\.prisma/.test(metaText) ||
        /prisma/.test(String(unit.framework || '').toLowerCase());

      if (prismaHint) {
        checks.push({
          id: 'prisma',
          name: 'Prisma 检查',
          category: 'DOCKER',
          severity: 'WARNING',
          passed: false,
          title: 'Prisma Schema 可能缺失于构建上下文',
          reason: '检测到 Prisma/数据库相关配置，Docker 构建需包含 prisma/schema.prisma。',
          suggestion: '检查 Dockerfile COPY 顺序，确保 schema 在 prisma generate 之前复制。',
        });
        signals.push('PRISMA_SCHEMA_RISK');
      } else {
        checks.push({
          id: 'prisma',
          name: 'Prisma 检查',
          category: 'DOCKER',
          severity: 'INFO',
          passed: true,
          title: '未检测到 Prisma 风险',
          reason: '当前单元未见 Prisma 相关信号。',
          suggestion: '若实际使用 Prisma，请确认 schema 已纳入镜像。',
        });
      }

      // 3. Package / lockfile
      const pm = String(unit.packageManager || meta.packageManager || '').toLowerCase();
      const lockHint =
        Boolean(meta.lockfile) ||
        Boolean(meta.hasLockfile) ||
        /package-lock|pnpm-lock|yarn\.lock|lockfile/.test(metaText);
      if (pm && !lockHint) {
        checks.push({
          id: 'deps',
          name: '依赖检查',
          category: 'DEPENDENCY',
          severity: 'WARNING',
          passed: false,
          title: '可能缺少依赖锁文件',
          reason: `包管理器为 ${pm}，但未确认 lockfile 已纳入源码。`,
          suggestion: '确认 package-lock.json / pnpm-lock.yaml / yarn.lock 已提交。',
        });
        signals.push('LOCKFILE_RISK');
      } else {
        checks.push({
          id: 'deps',
          name: '依赖检查',
          category: 'DEPENDENCY',
          severity: 'INFO',
          passed: true,
          title: pm ? `依赖管理：${pm}` : '依赖检查通过',
          reason: lockHint ? '检测到 lockfile 信号。' : '暂无高风险依赖信号。',
          suggestion: '保持 lockfile 与 package.json 同步。',
        });
      }

      // 4. Framework / start command
      const fw = String(unit.framework || project.framework || '').toLowerCase();
      const start = String(unit.startCommand || '').trim();
      if (!start && /next|vite|nest|node|express/.test(fw || 'node')) {
        checks.push({
          id: 'framework',
          name: 'Framework 检查',
          category: 'FRAMEWORK',
          severity: 'WARNING',
          passed: false,
          title: '启动命令可能缺失',
          reason: `框架 ${fw || 'node'} 未配置明确 startCommand。`,
          suggestion: '检查启动命令与 PORT，确认健康检查路径可用。',
        });
        signals.push('START_COMMAND_MISSING');
      } else {
        checks.push({
          id: 'framework',
          name: 'Framework 检查',
          category: 'FRAMEWORK',
          severity: 'INFO',
          passed: true,
          title: fw ? `框架：${fw}` : '框架检测通过',
          reason: start ? `startCommand 已配置。` : '暂无框架启动风险。',
          suggestion: '确认生产启动命令与本地一致。',
        });
      }

      // 5. Docker heuristics
      const dockerOk =
        Boolean(meta.dockerfile) ||
        Boolean(meta.hasDockerfile) ||
        /dockerfile|expose|cmd|entrypoint/.test(metaText);
      const portOk = typeof unit.port === 'number' && unit.port > 0;
      if (!dockerOk || !portOk) {
        checks.push({
          id: 'docker',
          name: 'Docker 检查',
          category: 'DOCKER',
          severity: 'WARNING',
          passed: false,
          title: 'Docker/端口配置可能不完整',
          reason: [
            !dockerOk ? '未确认 Dockerfile（COPY/CMD/EXPOSE）信息' : null,
            !portOk ? '未配置有效 PORT' : null,
          ]
            .filter(Boolean)
            .join('；'),
          suggestion: '检查 Dockerfile COPY 顺序、CMD、EXPOSE 与应用 PORT。',
        });
        signals.push('DOCKER_CONFIG_RISK');
      } else {
        checks.push({
          id: 'docker',
          name: 'Docker 检查',
          category: 'DOCKER',
          severity: 'INFO',
          passed: true,
          title: 'Docker 配置信号正常',
          reason: `端口 ${unit.port}。`,
          suggestion: '保持 Dockerfile 与启动端口一致。',
        });
      }
    }

    const hasBlocker = checks.some((c) => !c.passed && c.severity === 'BLOCKER');
    const hasWarning = checks.some((c) => !c.passed && c.severity === 'WARNING');
    const status: PreflightStatus = hasBlocker ? 'BLOCKED' : hasWarning ? 'WARNING' : 'PASSED';
    const riskLevel: PreflightRiskLevel = hasBlocker ? 'HIGH' : hasWarning ? 'MEDIUM' : 'LOW';

    const recommendations = checks
      .filter((c) => !c.passed)
      .map((c) => c.suggestion)
      .filter(Boolean);

    let source: 'RULE' | 'AI' | 'FALLBACK' = 'RULE';
    let summary =
      status === 'PASSED'
        ? '预检通过，可以继续上线。'
        : status === 'BLOCKED'
          ? `检测到高风险（${recommendations[0] || '请处理阻塞项'}）。`
          : `检测到潜在问题（${recommendations[0] || '建议先处理警告项'}）。`;
    let confidence = 0.82;

    // Layer 2: optional AI narrative on sanitized facts only
    if (status !== 'PASSED') {
      const facts = JSON.stringify(
        sanitizeAiMetadata({
          status,
          riskLevel,
          framework: unit?.framework || project.framework || '',
          packageManager: unit?.packageManager || '',
          signals: signals.join(','),
          failedChecks: checks
            .filter((c) => !c.passed)
            .map((c) => c.id)
            .join(','),
          missingConfigCount: signals.includes('MISSING_REQUIRED_CONFIG') ? 1 : 0,
        }),
      );
      const aiText = await this.ai
        .generateText(
          `你是 LaunchOS 部署预检助手。仅基于 FACTS 用一两句总结风险与建议，不要输出密钥，不要建议自动改代码或自动部署。\n\nFACTS:\n${facts}`,
        )
        .catch(() => '');
      if (aiText) {
        summary = redactText(aiText).slice(0, 400) || summary;
        source = 'AI';
        confidence = 0.7;
      } else if (!signals.length) {
        source = 'FALLBACK';
        confidence = 0.4;
      }
    }

    const saved = await this.prisma.deploymentPreflight.create({
      data: {
        projectId,
        deployableUnitId: unit?.id || null,
        status,
        riskLevel,
        checksJson: checks as unknown as Prisma.InputJsonValue,
        recommendationsJson: recommendations as unknown as Prisma.InputJsonValue,
        summary: summary.slice(0, 1000),
        confidence,
        source,
      },
    });

    return {
      id: saved.id,
      projectId,
      deployableUnitId: unit?.id || null,
      status,
      riskLevel,
      checks,
      recommendations,
      summary,
      confidence,
      source,
      passedCount: checks.filter((c) => c.passed).length,
      riskCount: checks.filter((c) => !c.passed).length,
      allowDeploy: status !== 'BLOCKED',
      requireConfirm: status === 'WARNING',
      note: 'AI 仅提供分析与建议，不会自动修改代码、不会自动修复、不会绕过确认。',
    };
  }

  private present(row: {
    id: string;
    projectId: string;
    deployableUnitId: string | null;
    status: string;
    riskLevel: string;
    checksJson: Prisma.JsonValue;
    recommendationsJson: Prisma.JsonValue;
    summary: string;
    confidence: number;
    source: string;
    createdAt: Date;
  }): PreflightResult {
    const checks = Array.isArray(row.checksJson) ? (row.checksJson as PreflightCheck[]) : [];
    const recommendations = Array.isArray(row.recommendationsJson)
      ? (row.recommendationsJson as string[])
      : [];
    const status = row.status as PreflightStatus;
    return {
      id: row.id,
      projectId: row.projectId,
      deployableUnitId: row.deployableUnitId,
      status,
      riskLevel: row.riskLevel as PreflightRiskLevel,
      checks,
      recommendations,
      summary: row.summary,
      confidence: row.confidence,
      source: row.source as 'RULE' | 'AI' | 'FALLBACK',
      passedCount: checks.filter((c) => c.passed).length,
      riskCount: checks.filter((c) => !c.passed).length,
      allowDeploy: status !== 'BLOCKED',
      requireConfirm: status === 'WARNING',
      note: 'AI 仅提供分析与建议，不会自动修改代码、不会自动修复、不会绕过确认。',
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
