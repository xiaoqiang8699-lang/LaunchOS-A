import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { BadRequestException, Injectable } from '@nestjs/common';
import { DeployableUnitStatus, DeployableUnitType, Prisma } from '@launchos/database';
import { DeploymentAnalyzer } from '@launchos/ai';
import {
  ProjectAnalyzer,
  isMobileFramework,
  type AnalyzedDeployableUnit,
  type ProjectAnalysisResult,
} from '@launchos/analyzer';
import { GitError, GitService, isPlaceholderGitUrl } from '@launchos/git';
import { GitHubAppError } from '@launchos/github';
import { PrismaService } from '../database/prisma.service';
import { GitHubConnectionsService } from '../github-connections/github-connections.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';

const CODE_READ_FAILED = '代码读取失败，请重新连接 GitHub 或稍后重试。';

const planSelect = {
  id: true,
  projectId: true,
  runtime: true,
  buildCommand: true,
  startCommand: true,
  port: true,
  config: true,
  createdAt: true,
  updatedAt: true,
} as const;

const analysisSelect = {
  id: true,
  projectId: true,
  result: true,
  model: true,
  createdAt: true,
} as const;

const projectAnalysisSelect = {
  id: true,
  projectId: true,
  repositoryPath: true,
  framework: true,
  packageManager: true,
  buildCommand: true,
  startCommand: true,
  port: true,
  confidence: true,
  createdAt: true,
} as const;

@Injectable()
export class AnalysesService {
  private readonly analyzer = new DeploymentAnalyzer();
  private readonly projectAnalyzer = new ProjectAnalyzer();
  private readonly git = new GitService();

  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaceAccess: WorkspaceAccessService,
    private readonly githubConnections: GitHubConnectionsService,
  ) {}

  async analyze(userId: string, projectId: string) {
    const { membership, project } = await this.workspaceAccess.requireProjectAccess(
      userId,
      projectId,
    );
    this.workspaceAccess.requireWriteAccess(membership.role);

    const source = await this.prisma.sourceRepository.findFirst({
      where: { projectId: project.id },
      orderBy: { createdAt: 'desc' },
    });
    if (!source) {
      throw new BadRequestException('请先连接代码');
    }

    const result = await this.analyzer.analyzeProject({
      projectName: project.name,
      projectType: project.projectType,
      source: {
        type: source.type,
        url: source.url,
        branch: source.branch,
      },
    });
    const draft = await this.analyzer.generatePlan(result);

    const [analysis, plan] = await this.prisma.$transaction([
      this.prisma.aiAnalysis.create({
        data: {
          projectId: project.id,
          result: result as Prisma.InputJsonValue,
          model: this.analyzer.model,
        },
        select: analysisSelect,
      }),
      this.prisma.deploymentPlan.create({
        data: {
          projectId: project.id,
          runtime: draft.runtime,
          buildCommand: draft.buildCommand,
          startCommand: draft.startCommand,
          port: draft.port,
          config: draft.config as Prisma.InputJsonValue,
        },
        select: planSelect,
      }),
    ]);

    return { analysis, plan };
  }

  async getLatest(userId: string, projectId: string) {
    await this.workspaceAccess.requireProjectAccess(userId, projectId);

    const [analysis, plan] = await Promise.all([
      this.prisma.aiAnalysis.findFirst({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        select: analysisSelect,
      }),
      this.prisma.deploymentPlan.findFirst({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        select: planSelect,
      }),
    ]);

    return { analysis, plan };
  }

  async analyzeCode(userId: string, projectId: string) {
    const { membership, project } = await this.workspaceAccess.requireProjectAccess(
      userId,
      projectId,
    );
    this.workspaceAccess.requireWriteAccess(membership.role);

    const source = await this.prisma.sourceRepository.findFirst({
      where: { projectId: project.id },
      orderBy: { createdAt: 'desc' },
    });
    if (!source) {
      throw new BadRequestException('请先连接代码');
    }

    if (project.isDemo || isPlaceholderGitUrl(source.url)) {
      return {
        skipped: true,
        skipReason: 'demo' as const,
        analysis: null,
        result: null,
      };
    }

    const directory = this.git.workspaceDir(project.id);
    if (source.type === 'UPLOAD') {
      if (!(await pathExists(directory))) {
        throw new BadRequestException('本地代码尚未准备好，请重新上传 ZIP。');
      }
    } else if (!(await gitRepoExists(directory))) {
      try {
        if (source.isPrivate && !source.connectionId) {
          throw new BadRequestException(CODE_READ_FAILED);
        }
        const auth = await this.githubConnections.resolveAuthForSource({
          connectionId: source.connectionId,
          isPrivate: source.isPrivate,
        });
        await this.git.cloneRepository(source.url, directory, source.branch, auth);
        await this.git.checkoutBranch(directory, source.branch);
      } catch (error) {
        if (error instanceof BadRequestException) {
          throw error;
        }
        if (error instanceof GitHubAppError) {
          throw new BadRequestException(error.message || CODE_READ_FAILED);
        }
        if (error instanceof GitError) {
          throw new BadRequestException(CODE_READ_FAILED);
        }
        throw new BadRequestException(CODE_READ_FAILED);
      }
    }

    const result = await this.projectAnalyzer.analyzeRepository(directory);
    const units = result.units ?? [];
    await this.syncDeployableUnits(project.id, source.id, units);

    const primaryUnit =
      units.find((unit) => unit.rootPath === result.primaryUnitPath) ||
      units.find((unit) => unit.deployable) ||
      units[0] ||
      null;
    const primaryRecord = primaryUnit
      ? await this.prisma.deployableUnit.findUnique({
          where: {
            projectId_rootPath: {
              projectId: project.id,
              rootPath: primaryUnit.rootPath,
            },
          },
          select: { id: true },
        })
      : null;

    const analysis = await this.prisma.projectAnalysis.create({
      data: {
        projectId: project.id,
        repositoryPath: directory,
        framework: result.framework,
        packageManager: result.packageManager,
        buildCommand: result.buildCommand,
        startCommand: result.startCommand,
        port: result.port,
        confidence: result.confidence,
        primaryUnitId: primaryRecord?.id ?? null,
      },
      select: projectAnalysisSelect,
    });

    if (result.framework !== 'UNSUPPORTED') {
      await this.prisma.project.update({
        where: { id: project.id },
        data: { framework: result.framework },
      });
    }

    const storedUnits = await this.prisma.deployableUnit.findMany({
      where: {
        projectId: project.id,
        status: { not: DeployableUnitStatus.IGNORED },
      },
      orderBy: [{ deployable: 'desc' }, { rootPath: 'asc' }],
    });

    return {
      skipped: false,
      skipReason: null,
      analysis,
      result: {
        ...result,
        units: storedUnits.map((unit) => ({
          id: unit.id,
          name: unit.name,
          type: unit.type,
          rootPath: unit.rootPath,
          framework: unit.framework,
          packageManager: unit.packageManager,
          buildCommand: unit.buildCommand,
          startCommand: unit.startCommand,
          outputPath: unit.outputPath,
          port: unit.port,
          deployable: unit.deployable,
          confidence: unit.confidence,
          status: unit.status,
          reason: unit.deployable ? '可以上线。' : '当前版本暂不支持上线这一部分。',
        })),
      },
      units: storedUnits,
    };
  }

  async syncDeployableUnits(
    projectId: string,
    sourceRepositoryId: string | null,
    units: AnalyzedDeployableUnit[],
  ) {
    const keepPaths = new Set(units.map((unit) => unit.rootPath));
    for (const unit of units) {
      await this.prisma.deployableUnit.upsert({
        where: {
          projectId_rootPath: {
            projectId,
            rootPath: unit.rootPath,
          },
        },
        create: {
          projectId,
          sourceRepositoryId,
          name: unit.name,
          type: mapUnitType(unit.type),
          rootPath: unit.rootPath,
          framework: unit.framework,
          packageManager: unit.packageManager,
          buildCommand: unit.buildCommand,
          startCommand: unit.startCommand,
          outputPath: unit.outputPath,
          port: unit.port,
          deployable: unit.deployable,
          confidence: unit.confidence,
          status: unit.deployable
            ? DeployableUnitStatus.DETECTED
            : DeployableUnitStatus.UNSUPPORTED,
          metadata: {
            reason: unit.reason,
            installCommand: unit.installCommand,
          },
        },
        update: {
          sourceRepositoryId,
          name: unit.name,
          type: mapUnitType(unit.type),
          framework: unit.framework,
          packageManager: unit.packageManager,
          buildCommand: unit.buildCommand,
          startCommand: unit.startCommand,
          outputPath: unit.outputPath,
          port: unit.port,
          deployable: unit.deployable,
          confidence: unit.confidence,
          status: unit.deployable
            ? DeployableUnitStatus.DETECTED
            : DeployableUnitStatus.UNSUPPORTED,
          metadata: {
            reason: unit.reason,
            installCommand: unit.installCommand,
          },
        },
      });
    }

    if (keepPaths.size > 0) {
      await this.prisma.deployableUnit.updateMany({
        where: {
          projectId,
          rootPath: { notIn: [...keepPaths] },
          status: { not: DeployableUnitStatus.IGNORED },
        },
        data: { status: DeployableUnitStatus.UNSUPPORTED, deployable: false },
      });
    }
  }

  async getLatestCodeAnalysis(userId: string, projectId: string) {
    await this.workspaceAccess.requireProjectAccess(userId, projectId);
    const analysis = await this.prisma.projectAnalysis.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: projectAnalysisSelect,
    });
    return {
      skipped: false,
      skipReason: null,
      analysis,
      result: analysis ? toAnalysisResult(analysis) : null,
    };
  }
}

async function gitRepoExists(directory: string): Promise<boolean> {
  try {
    await access(join(directory, '.git'));
    return true;
  } catch {
    return false;
  }
}

async function pathExists(directory: string): Promise<boolean> {
  try {
    await access(directory);
    return true;
  } catch {
    return false;
  }
}

function installCommandFor(manager: string | null): string | null {
  if (manager === 'pnpm') {
    return 'pnpm install';
  }
  if (manager === 'yarn') {
    return 'yarn install';
  }
  if (manager === 'bun') {
    return 'bun install';
  }
  if (manager === 'npm') {
    return 'npm install';
  }
  return null;
}

function toAnalysisResult(analysis: {
  framework: string;
  packageManager: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  port: number | null;
  confidence: number;
}): ProjectAnalysisResult {
  const framework = analysis.framework as ProjectAnalysisResult['framework'];
  const unsupported = framework === 'UNSUPPORTED';
  const mobile = isMobileFramework(framework);
  return {
    projectType: unsupported ? 'UNSUPPORTED' : mobile ? 'IOS_NATIVE' : 'WEB',
    framework,
    packageManager: analysis.packageManager as ProjectAnalysisResult['packageManager'],
    installCommand: installCommandFor(analysis.packageManager),
    buildCommand: analysis.buildCommand,
    startCommand: analysis.startCommand,
    port: analysis.port,
    confidence: analysis.confidence,
  };
}

function mapUnitType(type: AnalyzedDeployableUnit['type']): DeployableUnitType {
  switch (type) {
    case 'WEB':
      return DeployableUnitType.WEB;
    case 'API':
      return DeployableUnitType.API;
    case 'ADMIN':
      return DeployableUnitType.ADMIN;
    case 'IOS':
      return DeployableUnitType.IOS;
    case 'ANDROID':
      return DeployableUnitType.ANDROID;
    case 'MINI_PROGRAM':
      return DeployableUnitType.MINI_PROGRAM;
    case 'MOBILE_CROSS_PLATFORM':
      return DeployableUnitType.MOBILE_CROSS_PLATFORM;
    default:
      return DeployableUnitType.OTHER;
  }
}
