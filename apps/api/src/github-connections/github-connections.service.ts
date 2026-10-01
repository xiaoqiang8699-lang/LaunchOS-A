import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  GitConnectionStatus,
  GitProvider,
} from '@launchos/database';
import {
  GitHubAppError,
  buildInstallUrl,
  buildInstallationConfigureUrl,
  createInstallationAccessToken,
  evaluateGitHubConnectionCapability,
  getInstallation,
  isGitHubAppConfigured,
  listInstallationRepositories,
  readGitHubAppConfig,
  resolveGithubCallbackUrl,
  signOAuthState,
  verifyOAuthState,
} from '@launchos/github';
import {
  githubConnectErrorUrl,
  githubConnectSuccessUrl,
  sanitizeInternalReturnTo,
} from '@launchos/shared';
import type { GitAuthContext } from '@launchos/git';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';

@Injectable()
export class GitHubConnectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaceAccess: WorkspaceAccessService,
  ) {}

  getConnectionCapability() {
    const credentialsConfigured = isGitHubAppConfigured();
    const config = readGitHubAppConfig();
    return evaluateGitHubConnectionCapability({
      configured: credentialsConfigured,
      callbackUrl:
        config?.callbackUrl ??
        process.env.GITHUB_APP_CALLBACK_URL?.trim() ??
        resolveGithubCallbackUrl(),
      webOrigin: config?.webOrigin ?? process.env.WEB_ORIGIN?.trim() ?? null,
    });
  }

  getConfigStatus() {
    const config = readGitHubAppConfig();
    const capability = this.getConnectionCapability();
    return {
      configured: Boolean(config),
      provider: 'GITHUB' as const,
      slug: config?.slug ?? null,
      callbackUrl: config?.callbackUrl ?? capability.callbackUrl,
      connectionCapability: capability.status,
      connectionReady: capability.status === 'READY',
      diagnosis: capability.diagnosis,
      reason: capability.reason,
    };
  }

  async getStatus(userId: string) {
    const membership = await this.workspaceAccess.requireCurrentWorkspace(userId);
    const connection = await this.prisma.gitProviderConnection.findFirst({
      where: {
        workspaceId: membership.workspaceId,
        provider: GitProvider.GITHUB,
        status: { in: [GitConnectionStatus.ACTIVE, GitConnectionStatus.NEEDS_REAUTH] },
      },
      orderBy: { updatedAt: 'desc' },
    });

    let repositoryCount: number | null = null;
    if (connection?.status === GitConnectionStatus.ACTIVE) {
      try {
        const repos = await this.listRepositoriesForConnection(connection.installationId);
        repositoryCount = repos.length;
      } catch {
        repositoryCount = null;
      }
    }

    const capability = this.getConnectionCapability();
    return {
      configured: isGitHubAppConfigured(),
      connected: Boolean(connection && connection.status === GitConnectionStatus.ACTIVE),
      needsReauth: connection?.status === GitConnectionStatus.NEEDS_REAUTH,
      login: connection?.login ?? null,
      accountType: connection?.accountType ?? null,
      repositoryCount,
      connectionId: connection?.id ?? null,
      status: connection?.status ?? 'DISCONNECTED',
      configureUrl: connection?.installationId
        ? buildInstallationConfigureUrl(connection.installationId)
        : null,
      connectionCapability: capability.status,
      connectionReady: capability.status === 'READY',
      diagnosis: capability.diagnosis,
    };
  }

  async createAuthorizeUrl(userId: string, returnTo?: string) {
    const capability = this.getConnectionCapability();
    if (capability.status === 'NOT_CONFIGURED') {
      throw new ServiceUnavailableException(
        'GitHub App 尚未配置。请先在服务器环境中配置 GITHUB_APP_ID / GITHUB_APP_SLUG / GITHUB_APP_PRIVATE_KEY。',
      );
    }
    if (capability.status === 'NOT_READY' || !readGitHubAppConfig()) {
      throw new ServiceUnavailableException(
        capability.diagnosis || 'GitHub 回调地址不是公网 HTTPS 地址',
      );
    }
    const membership = await this.workspaceAccess.requireCurrentWorkspace(userId);
    this.workspaceAccess.requireWriteAccess(membership.role);

    const safeReturnTo = sanitizeInternalReturnTo(returnTo, '/onboarding/source');
    const existing = await this.prisma.gitProviderConnection.findFirst({
      where: {
        workspaceId: membership.workspaceId,
        provider: GitProvider.GITHUB,
        status: GitConnectionStatus.ACTIVE,
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (existing) {
      let repositoryCount = 0;
      try {
        repositoryCount = (await this.listRepositoriesForConnection(existing.installationId)).length;
      } catch {
        repositoryCount = 0;
      }
      return {
        url: null as string | null,
        alreadyConnected: true,
        connectionId: existing.id,
        repositoryCount,
        configureUrl: buildInstallationConfigureUrl(existing.installationId),
        hint: repositoryCount
          ? 'GitHub 已连接，请选择仓库。'
          : 'GitHub 已连接，但还没有可用仓库。请调整仓库权限后继续。',
      };
    }

    const state = signOAuthState({
      nonce: randomBytes(16).toString('hex'),
      userId,
      workspaceId: membership.workspaceId,
      exp: Math.floor(Date.now() / 1000) + 15 * 60,
      returnTo: safeReturnTo,
    });

    await this.prisma.productEvent
      .create({
        data: {
          name: 'GITHUB_CONNECT_STARTED',
          userId,
          metadata: { returnTo: safeReturnTo },
        },
      })
      .catch(() => undefined);

    return {
      url: buildInstallUrl(state),
      alreadyConnected: false,
      hint: '建议在 GitHub 选择 “Only select repositories”，仅授权需要上线的仓库。',
    };
  }

  async handleCallback(query: {
    installation_id?: string;
    setup_action?: string;
    state?: string;
  }) {
    const config = readGitHubAppConfig();
    const webOrigin = config?.webOrigin || fallbackWebOrigin();
    let returnTo = '/onboarding/source';

    try {
      if (!config) {
        return githubConnectErrorUrl(webOrigin, returnTo, 'not_configured');
      }
      if (!query.state) {
        return githubConnectErrorUrl(webOrigin, returnTo, 'cancelled');
      }

      const payload = verifyOAuthState(query.state);
      returnTo = sanitizeInternalReturnTo(payload.returnTo, '/onboarding/source');

      // User cancelled or abandoned install without installation_id.
      if (!query.installation_id) {
        return githubConnectErrorUrl(webOrigin, returnTo, 'cancelled');
      }

      const membership = await this.workspaceAccess.requireWorkspaceMembership(
        payload.userId,
        payload.workspaceId,
      );
      this.workspaceAccess.requireWriteAccess(membership.role);

      const setupAction = String(query.setup_action || '').toLowerCase();
      if (setupAction && !['install', 'update', 'request'].includes(setupAction)) {
        // Unknown setup_action: still attempt to bind installation_id when present.
      }

      const installation = await getInstallation(query.installation_id);
      await this.prisma.gitProviderConnection.upsert({
        where: {
          workspaceId_provider_installationId: {
            workspaceId: payload.workspaceId,
            provider: GitProvider.GITHUB,
            installationId: String(installation.id),
          },
        },
        create: {
          userId: payload.userId,
          workspaceId: payload.workspaceId,
          provider: GitProvider.GITHUB,
          installationId: String(installation.id),
          providerAccountId: installation.accountId,
          login: installation.accountLogin,
          accountType: installation.accountType,
          status: GitConnectionStatus.ACTIVE,
        },
        update: {
          userId: payload.userId,
          providerAccountId: installation.accountId,
          login: installation.accountLogin,
          accountType: installation.accountType,
          status: GitConnectionStatus.ACTIVE,
          encryptedSecrets: null,
        },
      });

      await this.prisma.productEvent
        .create({
          data: {
            name: 'GITHUB_CONNECT_SUCCEEDED',
            userId: payload.userId,
            metadata: {
              setupAction: setupAction || null,
              installationId: String(installation.id),
            },
          },
        })
        .catch(() => undefined);

      return githubConnectSuccessUrl(config.webOrigin, returnTo);
    } catch (error) {
      const reason =
        error instanceof GitHubAppError
          ? error.code.toLowerCase()
          : error instanceof BadRequestException
            ? 'invalid'
            : 'failed';
      return githubConnectErrorUrl(config?.webOrigin || webOrigin, returnTo, reason);
    }
  }

  async listRepositories(userId: string, search?: string) {
    const membership = await this.workspaceAccess.requireCurrentWorkspace(userId);
    this.workspaceAccess.requireWriteAccess(membership.role);

    const connection = await this.requireActiveConnection(membership.workspaceId);
    const repos = await this.listRepositoriesForConnection(connection.installationId);
    const q = search?.trim().toLowerCase();
    const filtered = q
      ? repos.filter((item) => item.fullName.toLowerCase().includes(q))
      : repos;

    return {
      connectionId: connection.id,
      login: connection.login,
      repositories: filtered.map((item) => ({
        id: String(item.id),
        fullName: item.fullName,
        name: item.name,
        private: item.private,
        defaultBranch: item.defaultBranch,
        cloneUrl: item.cloneUrl,
        htmlUrl: item.htmlUrl,
        updatedAt: item.updatedAt,
      })),
    };
  }

  async disconnect(userId: string) {
    const membership = await this.workspaceAccess.requireCurrentWorkspace(userId);
    this.workspaceAccess.requireWriteAccess(membership.role);

    const connections = await this.prisma.gitProviderConnection.findMany({
      where: {
        workspaceId: membership.workspaceId,
        provider: GitProvider.GITHUB,
        status: { not: GitConnectionStatus.REVOKED },
      },
      select: { id: true },
    });

    if (connections.length === 0) {
      return { ok: true };
    }

    const ids = connections.map((item) => item.id);
    await this.prisma.$transaction([
      this.prisma.gitProviderConnection.updateMany({
        where: { id: { in: ids } },
        data: { status: GitConnectionStatus.REVOKED, encryptedSecrets: null },
      }),
      this.prisma.sourceRepository.updateMany({
        where: { connectionId: { in: ids } },
        data: { authStatus: 'NEEDS_REAUTH' },
      }),
    ]);

    return { ok: true };
  }

  async resolveAuthForSource(source: {
    connectionId: string | null;
    isPrivate?: boolean;
  }): Promise<GitAuthContext | undefined> {
    if (!source.connectionId) {
      return undefined;
    }

    const connection = await this.prisma.gitProviderConnection.findUnique({
      where: { id: source.connectionId },
    });
    if (!connection || connection.status !== GitConnectionStatus.ACTIVE) {
      if (connection) {
        await this.prisma.gitProviderConnection.update({
          where: { id: connection.id },
          data: { status: GitConnectionStatus.NEEDS_REAUTH },
        });
        await this.prisma.sourceRepository.updateMany({
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
      await this.prisma.gitProviderConnection.update({
        where: { id: connection.id },
        data: { status: GitConnectionStatus.NEEDS_REAUTH },
      });
      await this.prisma.sourceRepository.updateMany({
        where: { connectionId: connection.id },
        data: { authStatus: 'NEEDS_REAUTH' },
      });
      if (error instanceof GitHubAppError) {
        throw error;
      }
      throw new GitHubAppError('GitHub 连接已失效，请重新连接。', 'REAUTH_REQUIRED');
    }
  }

  private async requireActiveConnection(workspaceId: string) {
    const connection = await this.prisma.gitProviderConnection.findFirst({
      where: {
        workspaceId,
        provider: GitProvider.GITHUB,
        status: GitConnectionStatus.ACTIVE,
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (!connection) {
      throw new NotFoundException('请先连接 GitHub。');
    }
    return connection;
  }

  private async listRepositoriesForConnection(installationId: string) {
    const token = await createInstallationAccessToken(installationId);
    return listInstallationRepositories(token.token);
  }
}

function fallbackWebOrigin(): string {
  return (process.env.WEB_ORIGIN || 'http://localhost:3000').replace(/\/$/, '');
}
