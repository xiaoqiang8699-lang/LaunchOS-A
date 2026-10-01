import { BadRequestException, Injectable } from '@nestjs/common';
import { SourceType, type Prisma } from '@launchos/database';
import {
  assertOnboardingEventSafe,
  buildOnboardingProjectInput,
  buildOnboardingPublicRepoInput,
  describeDetectedApplication,
  isOrdinaryUserProject,
  markOnboardingCompleted,
  presentOnboardingPlan,
  resolveOnboardingStage,
  shouldEnterOnboarding,
  type OnboardingEventName,
} from '@launchos/domain';
import { GitService, assertSafeRemoteUrl } from '@launchos/git';
import { randomUUID } from 'node:crypto';
import { AnalysesService } from '../analyses/analyses.service';
import { PrismaService } from '../database/prisma.service';
import { LaunchService } from '../launch/launch.service';
import { ProjectsService } from '../projects/projects.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import { extractOnboardingZip, persistZipUpload } from './zip-intake.util';

@Injectable()
export class OnboardingService {
  private readonly git = new GitService();

  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaceAccess: WorkspaceAccessService,
    private readonly projects: ProjectsService,
    private readonly analyses: AnalysesService,
    private readonly launch: LaunchService,
  ) {}

  async trackSourceViewed(userId: string) {
    await this.recordEvents(userId, null, ['ONBOARDING_SOURCE_VIEWED'], {});
    return { ok: true };
  }

  async getState(userId: string) {
    const context = await this.load(userId);
    if (context.launchStatus === 'SUCCESS' && context.onboardingStatus === 'IN_PROGRESS') {
      await this.complete(userId, 'SUCCESS');
      return { ...(await this.load(userId)), redirectedBecause: 'SUCCESS' as const };
    }
    return context;
  }

  async connectPublicSource(
    userId: string,
    body: { cloneUrl: string; branch?: string },
  ) {
    const cloneUrl = body.cloneUrl?.trim();
    if (!cloneUrl) throw new BadRequestException('请填写公开仓库地址');
    try {
      assertSafeRemoteUrl(cloneUrl);
    } catch {
      throw new BadRequestException('仓库地址无效，请使用 https://github.com/owner/repo.git 形式');
    }
    const input = buildOnboardingPublicRepoInput({
      cloneUrl,
      branch: body.branch,
    });
    const project = await this.projects.create(userId, {
      name: input.name,
      source: {
        type: SourceType.GITHUB,
        url: input.source.url,
        branch: input.source.branch,
        fullName: input.source.fullName,
        isPrivate: false,
      },
    });
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    await this.prisma.user.update({
      where: { id: userId },
      data: { onboardingStatus: 'IN_PROGRESS', hasCompletedOnboarding: false },
    });
    const events: OnboardingEventName[] = ['SOURCE_CONNECTED', 'PUBLIC_REPO_SELECTED'];
    if (user.onboardingStatus === 'NOT_STARTED') events.unshift('ONBOARDING_STARTED');
    await this.recordEvents(userId, project.id, events, {
      fullName: input.source.fullName,
      branch: input.source.branch,
    });
    return this.getState(userId);
  }

  async connectZipSource(
    userId: string,
    file: { buffer: Buffer; originalname?: string; size?: number } | undefined,
  ) {
    if (!file?.buffer?.byteLength) {
      throw new BadRequestException('请选择 ZIP 文件');
    }
    if (!/\.zip$/i.test(file.originalname || 'upload.zip')) {
      throw new BadRequestException('仅支持 .zip 文件');
    }
    await this.recordEvents(userId, null, ['LOCAL_ZIP_UPLOAD_STARTED'], {
      size: file.size ?? file.buffer.byteLength,
    });

    const uploadId = randomUUID();
    let extracted;
    try {
      await persistZipUpload(uploadId, file.buffer);
      // Create project first so we have a stable workspace directory id.
      const draftName = deriveTempName(file.originalname);
      const project = await this.projects.create(userId, {
        name: draftName,
        source: {
          type: SourceType.UPLOAD,
          url: `local://${draftName}`,
          branch: 'local',
          fullName: draftName,
          isPrivate: false,
        },
      });
      const workspaceDir = this.git.workspaceDir(project.id);
      extracted = await extractOnboardingZip({
        projectId: project.id,
        zipBuffer: file.buffer,
        originalName: file.originalname,
        workspaceDir,
      });
      if (extracted.appName && extracted.appName !== draftName) {
        await this.prisma.project.update({
          where: { id: project.id },
          data: { name: extracted.appName.slice(0, 80) },
        });
        await this.prisma.sourceRepository.updateMany({
          where: { projectId: project.id },
          data: {
            fullName: extracted.appName.slice(0, 80),
            url: `local://${extracted.appName}`,
          },
        });
      }
      const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
      await this.prisma.user.update({
        where: { id: userId },
        data: { onboardingStatus: 'IN_PROGRESS', hasCompletedOnboarding: false },
      });
      const events: OnboardingEventName[] = ['SOURCE_CONNECTED', 'LOCAL_ZIP_UPLOAD_SUCCEEDED'];
      if (user.onboardingStatus === 'NOT_STARTED') events.unshift('ONBOARDING_STARTED');
      await this.recordEvents(userId, project.id, events, {
        fileCount: extracted.fileCount,
        appName: extracted.appName,
      });
      return this.getState(userId);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'ZIP_FAILED';
      const message =
        code === 'ZIP_TOO_LARGE'
          ? 'ZIP 文件过大，请压缩后再试。'
          : code === 'ZIP_TOO_MANY_FILES' || code === 'ZIP_EXTRACTED_TOO_LARGE'
            ? '项目文件过多或过大，请精简后再上传。'
            : code === 'ZIP_EMPTY' || code === 'ZIP_EMPTY_CONTENT'
              ? 'ZIP 内容为空。'
              : code === 'ZIP_INVALID'
                ? 'ZIP 文件无法读取。'
                : '上传失败，请重新尝试。';
      throw new BadRequestException(message);
    }
  }

  async connectSource(
    userId: string,
    body: {
      fullName: string;
      cloneUrl: string;
      branch?: string;
      connectionId: string;
      providerRepositoryId: string;
      isPrivate?: boolean;
    },
  ) {
    if (!body.fullName?.trim() || !body.cloneUrl?.trim() || !body.connectionId || !body.providerRepositoryId) {
      throw new BadRequestException('请选择代码仓库');
    }
    const input = buildOnboardingProjectInput({
      fullName: body.fullName.trim(),
      cloneUrl: body.cloneUrl.trim(),
      branch: body.branch?.trim() || 'main',
      connectionId: body.connectionId,
      providerRepositoryId: body.providerRepositoryId,
      isPrivate: Boolean(body.isPrivate),
    });
    const project = await this.projects.create(userId, {
      name: input.name,
      source: {
        type: SourceType.GITHUB,
        url: input.source.url,
        branch: input.source.branch,
        connectionId: input.source.connectionId,
        providerRepositoryId: input.source.providerRepositoryId,
        fullName: input.source.fullName,
        isPrivate: input.source.isPrivate,
      },
    });
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    await this.prisma.user.update({
      where: { id: userId },
      data: { onboardingStatus: 'IN_PROGRESS', hasCompletedOnboarding: false },
    });
    const events: OnboardingEventName[] = ['SOURCE_CONNECTED', 'GITHUB_REPOSITORY_SELECTED'];
    if (user.onboardingStatus === 'NOT_STARTED') events.unshift('ONBOARDING_STARTED');
    await this.recordEvents(userId, project.id, events, { fullName: input.source.fullName, branch: input.source.branch });
    return this.getState(userId);
  }

  async analyze(userId: string) {
    const current = await this.load(userId);
    if (!current.projectId) throw new BadRequestException('请先连接代码');
    await this.analyses.analyzeCode(userId, current.projectId);
    const described = await this.describe(current.projectId);
    await this.recordEvents(userId, current.projectId, ['ANALYSIS_COMPLETED'], {
      findings: described.findings.join(','),
    });
    return { ...described, ...(await this.getState(userId)) };
  }

  async chooseRoot(userId: string, rootPath: string) {
    const current = await this.load(userId);
    if (!current.projectId || !rootPath?.trim()) throw new BadRequestException('请选择网页应用所在目录');
    assertOnboardingEventSafe({ rootPath: rootPath.trim() });
    await this.prisma.productEvent.create({
      data: {
        name: 'ONBOARDING_ROOT_CHOSEN',
        userId,
        projectId: current.projectId,
        metadata: { rootPath: rootPath.trim() },
      },
    });
    return this.getState(userId);
  }

  async viewPlan(userId: string) {
    const current = await this.load(userId);
    if (!current.projectId) throw new BadRequestException('请先完成检测');
    const plan = await this.launch.createPlan(userId, current.projectId);
    const ready = [
      plan.serverReady ? '服务器' : null,
      plan.webReady ? '网页应用' : null,
      plan.apiReady ? '后端接口' : null,
      plan.publicEntryReady ? '访问入口' : null,
    ].filter((item): item is string => Boolean(item));
    const softNeedsBilling = Boolean(
      plan.requiresConfirmation ||
        (plan as { platformManagedRuntime?: boolean }).platformManagedRuntime,
    );
    const presented = presentOnboardingPlan({
      readyLabels: ready,
      resourcesToCreate: plan.resourcesToCreate.map((item) => ({
        kind: item.kind,
        profileHint: null,
      })),
      requiresConfirmation: softNeedsBilling,
    });
    const specs = plan.billableActions
      .map((action) => action.profileHint)
      .filter((item): item is string => Boolean(item));
    await this.recordEvents(userId, current.projectId, ['LAUNCH_PLAN_VIEWED'], {
      launchRunId: plan.launchRunId,
      needsBilling: presented.needsBilling || softNeedsBilling,
    });
    return {
      ...presented,
      needsBilling: presented.needsBilling || softNeedsBilling,
      primaryLabel: softNeedsBilling || presented.needsBilling ? '确认费用并上线' : presented.primaryLabel,
      noNewBillable: plan.resourcesToCreate.length === 0 && plan.billableActions.length === 0,
      readyNoteZh: (plan as { platformManagedLabelZh?: string | null }).platformManagedLabelZh ?? null,
      launchRunId: plan.launchRunId,
      specs,
      estimatedCostAvailable: plan.estimatedCostAvailable,
    };
  }

  async confirmPlan(userId: string) {
    const current = await this.requireLaunch(userId);
    return this.launch.confirmLaunch(userId, current.projectId, current.launchRunId, {
      planVersion: current.planVersion,
      acceptance: true,
    });
  }

  async startLaunch(userId: string) {
    const current = await this.requireLaunch(userId);
    const started = await this.launch.executeLaunch(userId, current.projectId, current.launchRunId, {});
    await this.recordEvents(userId, current.projectId, ['LAUNCH_STARTED'], { launchRunId: current.launchRunId });
    return started;
  }

  async launchStatus(userId: string) {
    const current = await this.requireLaunch(userId);
    return this.launch.getLaunchRun(userId, current.projectId, current.launchRunId);
  }

  async complete(userId: string, reason: 'SUCCESS' | 'SKIP') {
    const marked = markOnboardingCompleted({ reason, now: new Date().toISOString() });
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        onboardingStatus: marked.onboardingStatus,
        onboardingCompletedAt: new Date(marked.onboardingCompletedAt),
        hasCompletedOnboarding: true,
      },
    });
    const project = await this.latestProject(userId);
    await this.recordEvents(userId, project?.id ?? null, marked.events, { reason });
    return { onboardingStatus: marked.onboardingStatus };
  }

  async defer(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return { onboardingStatus: user.onboardingStatus, deferred: true };
  }

  private async requireLaunch(userId: string) {
    const current = await this.load(userId);
    if (!current.projectId || !current.launchRunId || !current.planVersion) {
      throw new BadRequestException('请先查看上线方案');
    }
    return {
      projectId: current.projectId,
      launchRunId: current.launchRunId,
      planVersion: current.planVersion,
    };
  }

  private async latestProject(userId: string) {
    const membership = await this.workspaceAccess.requireCurrentWorkspace(userId);
    const projects = await this.prisma.project.findMany({
      where: { workspaceId: membership.workspaceId },
      orderBy: { createdAt: 'desc' },
      include: { sources: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    return projects.find((project) => isOrdinaryUserProject(project)) ?? null;
  }

  private async load(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const project = await this.latestProject(userId);
    const source = project?.sources[0] ?? null;
    const sourceBound = Boolean(source?.url);
    const analysis = project
      ? await this.prisma.projectAnalysis.findFirst({
          where: { projectId: project.id },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        })
      : null;
    const described = project ? await this.describe(project.id) : { findings: [], uncertainties: [], uncertainWebRoots: [] as string[] };
    const chosen = project
      ? await this.prisma.productEvent.findFirst({
          where: { projectId: project.id, name: 'ONBOARDING_ROOT_CHOSEN' },
          orderBy: { createdAt: 'desc' },
        })
      : null;
    const analysisCompleted = Boolean(analysis) && (described.uncertainWebRoots.length < 2 || Boolean(chosen));
    const launch = project
      ? await this.prisma.launchRun.findFirst({
          where: {
            projectId: project.id,
            status: { in: ['SUCCESS', 'FAILED', 'RUNNING', 'VERIFYING', 'READY', 'WAITING_CONFIRMATION'] },
          },
          orderBy: { createdAt: 'desc' },
          select: { id: true, status: true, planVersion: true },
        })
      : null;
    const route = project
      ? await this.prisma.gatewayRoute.findFirst({
          where: { projectId: project.id, status: 'ACTIVE' },
          select: { hostname: true },
        })
      : null;
    const realProjectCount = project ? 1 : 0;
    return {
      onboardingStatus: user.onboardingStatus,
      isFirstTimeUser: user.onboardingStatus !== 'COMPLETED' && realProjectCount === 0,
      shouldEnterOnboarding: shouldEnterOnboarding(user.onboardingStatus),
      stage: resolveOnboardingStage({
        sourceBound,
        analysisCompleted,
        launchStatus: launch?.status ?? null,
      }),
      projectId: project?.id ?? null,
      sourceBound,
      findings: described.findings,
      uncertainties: described.uncertainties,
      launchRunId: launch?.id ?? null,
      planVersion: launch?.planVersion ?? null,
      launchStatus: launch?.status ?? null,
      publicUrl: route ? `https://${route.hostname}` : null,
      hidesTestControls: true,
    };
  }

  private async describe(projectId: string) {
    const units = await this.prisma.deployableUnit.findMany({
      where: { projectId },
      select: { type: true, rootPath: true, confidence: true },
    });
    const requirements = await this.prisma.runtimeConfigRequirement.findMany({
      where: { projectId },
      select: { key: true },
    });
    const webRoots = units.filter((unit) => unit.type === 'WEB').map((unit) => unit.rootPath);
    const described = describeDetectedApplication({
      unitTypes: units.map((unit) => unit.type),
      needsDatabase: requirements.some((item) => item.key === 'DATABASE_URL'),
      needsCache: requirements.some((item) => item.key === 'REDIS_URL'),
      uncertainWebRoots: webRoots,
    });
    return { ...described, uncertainWebRoots: webRoots };
  }

  private async recordEvents(
    userId: string,
    projectId: string | null,
    names: OnboardingEventName[],
    metadata: Record<string, unknown>,
  ) {
    assertOnboardingEventSafe(metadata);
    if (names.length === 0) return;
    await this.prisma.productEvent.createMany({
      data: names.map((name) => ({
        name,
        userId,
        projectId,
        metadata: metadata as Prisma.InputJsonValue,
      })),
    });
  }
}

function deriveTempName(fileName?: string): string {
  const base = String(fileName || 'my-app')
    .replace(/\.zip$/i, '')
    .replace(/[^\w.\u4e00-\u9fff-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (base || 'my-app').slice(0, 80);
}
