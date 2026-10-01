/**
 * GitHub App callback / Setup URL readiness.
 *
 * Actual routes (do not invent alternate paths):
 * - Browser-facing Setup/Callback (Web bridge):
 *     {WEB_ORIGIN}/git/github/callback
 * - Server handler (API):
 *     {API}/api/v1/git/github/callback
 *
 * External Alpha / Production MUST use the public HTTPS web host so GitHub
 * can redirect real users back into LaunchOS (never localhost).
 */

export const GITHUB_WEB_CALLBACK_PATH = '/git/github/callback';
export const GITHUB_API_CALLBACK_PATH = '/api/v1/git/github/callback';

export const LAUNCHOS_PUBLIC_WEB_ORIGIN = 'https://alpha.zsaos.com';
export const LAUNCHOS_PUBLIC_API_ORIGIN = 'https://api-alpha.zsaos.com';

export const LOCAL_GITHUB_CALLBACK_URL = `http://localhost:3000${GITHUB_WEB_CALLBACK_PATH}`;
export const PUBLIC_GITHUB_CALLBACK_URL = `${LAUNCHOS_PUBLIC_WEB_ORIGIN}${GITHUB_WEB_CALLBACK_PATH}`;

export type GitHubConnectionCapabilityStatus = 'READY' | 'NOT_READY' | 'NOT_CONFIGURED';

export type GitHubConnectionCapability = {
  status: GitHubConnectionCapabilityStatus;
  /** Product-facing capability key */
  capability: 'GITHUB_CONNECTION';
  configured: boolean;
  requiresPublicHttps: boolean;
  callbackUrl: string | null;
  webOrigin: string | null;
  callbackHostKind: 'public_https' | 'localhost' | 'private' | 'insecure' | 'invalid' | 'missing';
  /** Chinese admin diagnosis when NOT_READY */
  diagnosis: string | null;
  reason: string | null;
};

type EnvLike = Record<string, string | undefined>;

export function requiresPublicGithubCallback(env: EnvLike = process.env): boolean {
  const nodeEnv = String(env.NODE_ENV || '').trim().toLowerCase();
  const launchEnv = String(
    env.LAUNCHOS_ENV || env.LAUNCHOS_RUNTIME_ENV || env.LAUNCHOS_DEPLOY_ENV || '',
  )
    .trim()
    .toLowerCase();
  if (nodeEnv === 'production') return true;
  return (
    launchEnv === 'alpha' ||
    launchEnv === 'external-alpha' ||
    launchEnv === 'external_alpha' ||
    launchEnv === 'prod' ||
    launchEnv === 'production'
  );
}

export function isLocalOrPrivateHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1') {
    return true;
  }
  if (host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

export function classifyCallbackUrl(raw: string | null | undefined): {
  kind: GitHubConnectionCapability['callbackHostKind'];
  url: string | null;
} {
  const value = String(raw || '').trim();
  if (!value) return { kind: 'missing', url: null };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { kind: 'invalid', url: value };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { kind: 'invalid', url: value };
  }
  if (isLocalOrPrivateHostname(parsed.hostname)) {
    return { kind: 'localhost', url: value };
  }
  if (parsed.protocol !== 'https:') {
    return { kind: 'insecure', url: value };
  }
  return { kind: 'public_https', url: value };
}

/**
 * Resolve callback URL for the current environment.
 * Production / External Alpha never falls back to localhost.
 */
export function resolveGithubCallbackUrl(env: EnvLike = process.env): string | null {
  const explicit = env.GITHUB_APP_CALLBACK_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, '');

  if (requiresPublicGithubCallback(env)) {
    return null;
  }

  return LOCAL_GITHUB_CALLBACK_URL;
}

export function resolveGithubWebOrigin(env: EnvLike = process.env): string {
  const explicit = env.WEB_ORIGIN?.trim();
  if (explicit) return explicit.replace(/\/$/, '');
  if (requiresPublicGithubCallback(env)) {
    return LAUNCHOS_PUBLIC_WEB_ORIGIN;
  }
  return 'http://localhost:3000';
}

export function evaluateGitHubConnectionCapability(input?: {
  env?: EnvLike;
  configured?: boolean;
  callbackUrl?: string | null;
  webOrigin?: string | null;
}): GitHubConnectionCapability {
  const env = input?.env ?? process.env;
  const requiresPublicHttps = requiresPublicGithubCallback(env);
  const configured = input?.configured ?? false;
  const callbackUrl =
    input?.callbackUrl !== undefined ? input.callbackUrl : resolveGithubCallbackUrl(env);
  const webOrigin =
    input?.webOrigin !== undefined ? input.webOrigin : resolveGithubWebOrigin(env);
  const classified = classifyCallbackUrl(callbackUrl);

  if (!configured) {
    return {
      status: 'NOT_CONFIGURED',
      capability: 'GITHUB_CONNECTION',
      configured: false,
      requiresPublicHttps,
      callbackUrl: classified.url,
      webOrigin,
      callbackHostKind: classified.kind,
      diagnosis: 'GitHub App 尚未配置',
      reason: 'NOT_CONFIGURED',
    };
  }

  if (requiresPublicHttps) {
    if (classified.kind === 'missing') {
      return {
        status: 'NOT_READY',
        capability: 'GITHUB_CONNECTION',
        configured: true,
        requiresPublicHttps,
        callbackUrl: null,
        webOrigin,
        callbackHostKind: 'missing',
        diagnosis: 'GitHub 回调地址不是公网 HTTPS 地址',
        reason: 'CALLBACK_MISSING',
      };
    }
    if (classified.kind === 'localhost' || classified.kind === 'private') {
      return {
        status: 'NOT_READY',
        capability: 'GITHUB_CONNECTION',
        configured: true,
        requiresPublicHttps,
        callbackUrl: classified.url,
        webOrigin,
        callbackHostKind: classified.kind,
        diagnosis: 'GitHub 回调地址不是公网 HTTPS 地址',
        reason: 'CALLBACK_NOT_PUBLIC',
      };
    }
    if (classified.kind === 'insecure' || classified.kind === 'invalid') {
      return {
        status: 'NOT_READY',
        capability: 'GITHUB_CONNECTION',
        configured: true,
        requiresPublicHttps,
        callbackUrl: classified.url,
        webOrigin,
        callbackHostKind: classified.kind,
        diagnosis: 'GitHub 回调地址不是公网 HTTPS 地址',
        reason: 'CALLBACK_INSECURE',
      };
    }

    const webClassified = classifyCallbackUrl(webOrigin);
    if (webClassified.kind !== 'public_https') {
      return {
        status: 'NOT_READY',
        capability: 'GITHUB_CONNECTION',
        configured: true,
        requiresPublicHttps,
        callbackUrl: classified.url,
        webOrigin,
        callbackHostKind: classified.kind,
        diagnosis: 'GitHub 回调地址不是公网 HTTPS 地址',
        reason: 'WEB_ORIGIN_NOT_PUBLIC',
      };
    }
  }

  return {
    status: 'READY',
    capability: 'GITHUB_CONNECTION',
    configured: true,
    requiresPublicHttps,
    callbackUrl: classified.url,
    webOrigin,
    callbackHostKind: classified.kind,
    diagnosis: null,
    reason: null,
  };
}

/** Exact GitHub App settings for External Alpha (no guessing). */
export function githubAppPublicSettingsUrls() {
  return {
    homepageUrl: LAUNCHOS_PUBLIC_WEB_ORIGIN,
    callbackUrl: PUBLIC_GITHUB_CALLBACK_URL,
    setupUrl: PUBLIC_GITHUB_CALLBACK_URL,
    /** Install flow uses Setup URL; webhook not required for connect/return. */
    webhookUrl: null as string | null,
    redirectOnUpdate: true,
    permissions: {
      contents: 'read',
      metadata: 'read',
    },
    localCallbackUrl: LOCAL_GITHUB_CALLBACK_URL,
    apiHandlerPath: GITHUB_API_CALLBACK_PATH,
    webBridgePath: GITHUB_WEB_CALLBACK_PATH,
    publicApiOrigin: LAUNCHOS_PUBLIC_API_ORIGIN,
  };
}
