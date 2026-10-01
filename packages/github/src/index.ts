import { createPrivateKey, createSign, createHmac, timingSafeEqual } from 'node:crypto';
import {
  evaluateGitHubConnectionCapability,
  resolveGithubCallbackUrl,
  resolveGithubWebOrigin,
} from './callback-readiness.js';

export type GitHubAppConfig = {
  appId: string;
  slug: string;
  privateKey: string;
  clientId?: string;
  clientSecret?: string;
  callbackUrl: string;
  webOrigin: string;
};

export {
  GITHUB_API_CALLBACK_PATH,
  GITHUB_WEB_CALLBACK_PATH,
  LAUNCHOS_PUBLIC_API_ORIGIN,
  LAUNCHOS_PUBLIC_WEB_ORIGIN,
  LOCAL_GITHUB_CALLBACK_URL,
  PUBLIC_GITHUB_CALLBACK_URL,
  classifyCallbackUrl,
  evaluateGitHubConnectionCapability,
  githubAppPublicSettingsUrls,
  isLocalOrPrivateHostname,
  requiresPublicGithubCallback,
  resolveGithubCallbackUrl,
  resolveGithubWebOrigin,
  type GitHubConnectionCapability,
  type GitHubConnectionCapabilityStatus,
} from './callback-readiness.js';

export type GitHubInstallationToken = {
  token: string;
  expiresAt: string;
};

export type GitHubRepository = {
  id: number;
  fullName: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
  htmlUrl: string;
  updatedAt: string | null;
};

export class GitHubAppError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(message: string, code: string, status?: number) {
    super(message);
    this.name = 'GitHubAppError';
    this.code = code;
    this.status = status;
  }
}

export function readGitHubAppCredentials(): {
  appId: string;
  slug: string;
  privateKey: string;
  clientId?: string;
  clientSecret?: string;
} | null {
  const appId = process.env.GITHUB_APP_ID?.trim() || '';
  const slug = process.env.GITHUB_APP_SLUG?.trim() || '';
  const privateKey = normalizePrivateKey(process.env.GITHUB_APP_PRIVATE_KEY || '');
  if (!appId || !slug || !privateKey) {
    return null;
  }
  return {
    appId,
    slug,
    privateKey,
    clientId: process.env.GITHUB_APP_CLIENT_ID?.trim() || undefined,
    clientSecret: process.env.GITHUB_APP_CLIENT_SECRET?.trim() || undefined,
  };
}

export function readGitHubAppConfig(): GitHubAppConfig | null {
  const credentials = readGitHubAppCredentials();
  // Production / External Alpha: never invent a localhost callback.
  const callbackUrl = resolveGithubCallbackUrl();
  const webOrigin = resolveGithubWebOrigin();

  if (!credentials || !callbackUrl) {
    return null;
  }

  return {
    ...credentials,
    callbackUrl,
    webOrigin,
  };
}

export function isGitHubAppConfigured(): boolean {
  return readGitHubAppCredentials() !== null;
}

/** True when credentials exist and callback capability is READY. */
export function isGitHubConnectionReady(): boolean {
  const capability = evaluateGitHubConnectionCapability({
    configured: isGitHubAppConfigured(),
    callbackUrl: resolveGithubCallbackUrl(),
    webOrigin: resolveGithubWebOrigin(),
  });
  return capability.status === 'READY';
}

export function createGitHubAppJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: appId,
    }),
  );
  const data = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(data);
  signer.end();
  const signature = signer.sign(createPrivateKey(privateKeyPem)).toString('base64url');
  return `${data}.${signature}`;
}

export async function createInstallationAccessToken(
  installationId: string,
  config: { appId: string; privateKey: string } | null = readGitHubAppCredentials(),
): Promise<GitHubInstallationToken> {
  // Installation tokens only need app credentials; callback URL is for OAuth/connect UX.
  if (!config?.appId || !config?.privateKey) {
    throw new GitHubAppError('GitHub App 尚未配置', 'NOT_CONFIGURED');
  }

  const jwt = createGitHubAppJwt(config.appId, config.privateKey);
  const response = await fetch(
    `https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jwt}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'LaunchOS',
      },
    },
  );

  if (!response.ok) {
    throw mapGitHubHttpError(response.status, await safeText(response));
  }

  const body = (await response.json()) as { token?: string; expires_at?: string };
  if (!body.token) {
    throw new GitHubAppError('GitHub 未返回访问令牌', 'TOKEN_MISSING', response.status);
  }

  return {
    token: body.token,
    expiresAt: body.expires_at || new Date(Date.now() + 55 * 60_000).toISOString(),
  };
}

export async function getInstallation(
  installationId: string,
  config: { appId: string; privateKey: string } | null = readGitHubAppCredentials(),
): Promise<{ id: number; accountLogin: string; accountType: string; accountId: string }> {
  if (!config?.appId || !config?.privateKey) {
    throw new GitHubAppError('GitHub App 尚未配置', 'NOT_CONFIGURED');
  }
  const jwt = createGitHubAppJwt(config.appId, config.privateKey);
  const response = await fetch(
    `https://api.github.com/app/installations/${encodeURIComponent(installationId)}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jwt}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'LaunchOS',
      },
    },
  );
  if (!response.ok) {
    throw mapGitHubHttpError(response.status, await safeText(response));
  }
  const body = (await response.json()) as {
    id: number;
    account?: { login?: string; type?: string; id?: number; node_id?: string };
  };
  return {
    id: body.id,
    accountLogin: body.account?.login || 'github',
    accountType: body.account?.type || 'User',
    accountId: String(body.account?.id ?? body.account?.node_id ?? body.id),
  };
}

export async function listInstallationRepositories(
  installationToken: string,
): Promise<GitHubRepository[]> {
  const repos: GitHubRepository[] = [];
  let page = 1;

  while (page <= 20) {
    const response = await fetch(
      `https://api.github.com/installation/repositories?per_page=100&page=${page}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${installationToken}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'LaunchOS',
        },
      },
    );
    if (!response.ok) {
      throw mapGitHubHttpError(response.status, await safeText(response));
    }
    const body = (await response.json()) as {
      repositories?: Array<{
        id: number;
        full_name: string;
        name: string;
        private: boolean;
        default_branch: string;
        clone_url: string;
        html_url: string;
        updated_at: string | null;
      }>;
      total_count?: number;
    };
    const batch = body.repositories ?? [];
    for (const item of batch) {
      repos.push({
        id: item.id,
        fullName: item.full_name,
        name: item.name,
        private: item.private,
        defaultBranch: item.default_branch || 'main',
        cloneUrl: item.clone_url,
        htmlUrl: item.html_url,
        updatedAt: item.updated_at,
      });
    }
    if (batch.length < 100) {
      break;
    }
    page += 1;
  }

  return repos;
}

export function buildInstallUrl(state: string, config = readGitHubAppConfig()): string {
  if (!config) {
    throw new GitHubAppError('GitHub App 尚未配置', 'NOT_CONFIGURED');
  }
  // GitHub App installation flow. Post-install redirect depends on App "Setup URL"
  // (and "Redirect on update"). LaunchOS Setup URL should point at the public web
  // bridge `/git/github/callback`, which forwards to the API callback.
  const url = new URL(`https://github.com/apps/${encodeURIComponent(config.slug)}/installations/new`);
  url.searchParams.set('state', state);
  return url.toString();
}

export function buildInstallationConfigureUrl(installationId: string): string {
  return `https://github.com/settings/installations/${encodeURIComponent(installationId)}`;
}

export type OAuthStatePayload = {
  nonce: string;
  userId: string;
  workspaceId: string;
  exp: number;
  returnTo?: string;
};

export function signOAuthState(payload: OAuthStatePayload, secret = process.env.JWT_SECRET || ''): string {
  if (!secret) {
    throw new GitHubAppError('JWT_SECRET 未配置', 'MISSING_SECRET');
  }
  const body = base64url(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyOAuthState(
  state: string,
  secret = process.env.JWT_SECRET || '',
): OAuthStatePayload {
  if (!secret) {
    throw new GitHubAppError('JWT_SECRET 未配置', 'MISSING_SECRET');
  }
  const [body, sig] = state.split('.');
  if (!body || !sig) {
    throw new GitHubAppError('无效的授权状态', 'INVALID_STATE');
  }
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new GitHubAppError('授权状态校验失败', 'INVALID_STATE');
  }
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OAuthStatePayload;
  if (!payload.userId || !payload.workspaceId || !payload.exp) {
    throw new GitHubAppError('授权状态不完整', 'INVALID_STATE');
  }
  if (payload.exp < Math.floor(Date.now() / 1000)) {
    throw new GitHubAppError('授权已过期，请重新连接', 'STATE_EXPIRED');
  }
  return payload;
}

function normalizePrivateKey(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return '';
  }
  if (trimmed.includes('BEGIN')) {
    return trimmed.replace(/\\n/g, '\n');
  }
  return trimmed.replace(/\\n/g, '\n');
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function mapGitHubHttpError(status: number, body: string): GitHubAppError {
  const lower = body.toLowerCase();
  if (status === 401 || status === 403) {
    if (lower.includes('installation') || lower.includes('suspended')) {
      return new GitHubAppError('GitHub 连接已失效，请重新连接。', 'REAUTH_REQUIRED', status);
    }
    return new GitHubAppError(
      'LaunchOS 没有访问这个仓库的权限，请在 GitHub 中授权该仓库。',
      'FORBIDDEN',
      status,
    );
  }
  if (status === 404) {
    return new GitHubAppError('GitHub 连接已失效，请重新连接。', 'NOT_FOUND', status);
  }
  return new GitHubAppError('暂时无法读取 GitHub，请稍后重试。', 'GITHUB_UNAVAILABLE', status);
}
