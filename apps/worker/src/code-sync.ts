import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CodeUpdateStatus, PrismaClient } from '@launchos/database';
import { GitService, isPlaceholderGitUrl, type GitAuthContext } from '@launchos/git';
import { createInstallationAccessToken, GitHubAppError } from '@launchos/github';

const DEFAULT_INTERVAL_MS = 60_000;

export function startCodeSyncMonitor(prisma: PrismaClient): () => void {
  const git = new GitService();
  const intervalMs = readIntervalMs();
  let running = false;

  const run = async (): Promise<void> => {
    if (running) {
      return;
    }
    running = true;
    try {
      await inspectProjects(prisma, git);
    } catch (error) {
      console.error('Code sync monitor failed', error);
    } finally {
      running = false;
    }
  };

  const initialTimer = setTimeout(() => void run(), 8_000);
  const interval = setInterval(() => void run(), intervalMs);
  console.log(`Code sync monitor started (every ${intervalMs}ms)`);

  return () => {
    clearTimeout(initialTimer);
    clearInterval(interval);
  };
}

async function inspectProjects(prisma: PrismaClient, git: GitService): Promise<void> {
  const projects = await prisma.project.findMany({
    where: { autoDeployEnabled: true, isDemo: false },
    select: {
      id: true,
      defaultBranch: true,
      sources: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: {
          url: true,
          branch: true,
          connectionId: true,
          isPrivate: true,
          authStatus: true,
        },
      },
      applicationVersions: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { commitSha: true, status: true },
      },
      deployments: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { sourceRevision: true },
      },
    },
  });

  await Promise.allSettled(projects.map((project) => inspectProject(prisma, git, project)));
}

async function inspectProject(
  prisma: PrismaClient,
  git: GitService,
  project: {
    id: string;
    defaultBranch: string | null;
    sources: {
      url: string;
      branch: string;
      connectionId: string | null;
      isPrivate: boolean;
      authStatus: string;
    }[];
    applicationVersions: { commitSha: string; status: string }[];
    deployments: { sourceRevision: string | null }[];
  },
): Promise<void> {
  const source = project.sources[0];
  if (!source?.url || isPlaceholderGitUrl(source.url)) {
    return;
  }

  const branch = source.branch.trim() || project.defaultBranch?.trim() || 'main';
  const repoDir = git.workspaceDir(project.id);
  const localDir = existsSync(join(repoDir, '.git')) ? repoDir : undefined;

  let auth: GitAuthContext | undefined;
  try {
    auth = await resolveAuth(prisma, source);
  } catch (error) {
    // Auth failure must not mark the running app as failed.
    if (error instanceof GitHubAppError || source.isPrivate || source.connectionId) {
      console.warn(
        `Code sync skipped for ${project.id}: GitHub authorization required (app keeps running)`,
      );
      return;
    }
    throw error;
  }

  let remote;
  try {
    remote = await git.getRemoteHead(source.url, branch, localDir, auth);
  } catch (error) {
    if (source.connectionId || source.isPrivate) {
      if (source.connectionId) {
        await prisma.gitProviderConnection.updateMany({
          where: { id: source.connectionId },
          data: { status: 'NEEDS_REAUTH' },
        });
        await prisma.sourceRepository.updateMany({
          where: { connectionId: source.connectionId },
          data: { authStatus: 'NEEDS_REAUTH' },
        });
      }
      console.warn(
        `Code sync needs reauth for ${project.id}: ${error instanceof Error ? error.message : 'auth failed'}`,
      );
      return;
    }
    throw error;
  }

  const currentSha =
    project.applicationVersions[0]?.commitSha ||
    project.deployments[0]?.sourceRevision ||
    '';

  if (!remote.sha || remote.sha === currentSha) {
    return;
  }

  await prisma.pendingCodeUpdate.upsert({
    where: {
      projectId_commitSha: {
        projectId: project.id,
        commitSha: remote.sha,
      },
    },
    update: {
      commitMessage: remote.message,
      status: CodeUpdateStatus.PENDING,
    },
    create: {
      projectId: project.id,
      commitSha: remote.sha,
      commitMessage: remote.message,
      status: CodeUpdateStatus.PENDING,
    },
  });
  console.log(`LaunchOS found new code for ${project.id}: ${remote.shortSha}`);
}

async function resolveAuth(
  prisma: PrismaClient,
  source: { connectionId: string | null },
): Promise<GitAuthContext | undefined> {
  if (!source.connectionId) {
    return undefined;
  }

  const connection = await prisma.gitProviderConnection.findUnique({
    where: { id: source.connectionId },
    select: { id: true, installationId: true, status: true },
  });

  if (!connection || connection.status !== 'ACTIVE') {
    if (connection) {
      await prisma.gitProviderConnection.update({
        where: { id: connection.id },
        data: { status: 'NEEDS_REAUTH' },
      });
      await prisma.sourceRepository.updateMany({
        where: { connectionId: connection.id },
        data: { authStatus: 'NEEDS_REAUTH' },
      });
    }
    throw new GitHubAppError('GitHub 连接已失效，请重新连接。', 'REAUTH_REQUIRED');
  }

  try {
    const token = await createInstallationAccessToken(connection.installationId);
    return { token: token.token, username: 'x-access-token' };
  } catch (error) {
    // Platform misconfiguration must not invalidate the user's GitHub connection.
    if (error instanceof GitHubAppError && error.code === 'NOT_CONFIGURED') {
      throw error;
    }
    await prisma.gitProviderConnection.update({
      where: { id: connection.id },
      data: { status: 'NEEDS_REAUTH' },
    });
    await prisma.sourceRepository.updateMany({
      where: { connectionId: connection.id },
      data: { authStatus: 'NEEDS_REAUTH' },
    });
    if (error instanceof GitHubAppError) {
      throw error;
    }
    throw new GitHubAppError('GitHub 连接已失效，请重新连接。', 'REAUTH_REQUIRED');
  }
}

function readIntervalMs(): number {
  const value = Number(process.env.CODE_SYNC_INTERVAL_MS);
  return Number.isInteger(value) && value >= 15_000 ? value : DEFAULT_INTERVAL_MS;
}
