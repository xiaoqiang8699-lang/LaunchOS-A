'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { ProductNav } from '@/components/product-nav';
import { api, ApiError } from '@/lib/api';
import { clearAccessToken, getAccessToken } from '@/lib/auth';
import { PRODUCT_COPY } from '@/lib/product-language';
import type { GitHubConnectionStatus } from '@/lib/types';

type GitHubAppConfigStatus = {
  configured: boolean;
  provider: 'GITHUB';
  slug: string | null;
  callbackUrl: string | null;
};

function CodePlatformsInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const githubResult = searchParams.get('github');
  const githubReason = searchParams.get('reason') || '';
  const cleanedQuery = useRef(false);

  const [config, setConfig] = useState<GitHubAppConfigStatus | null>(null);
  const [status, setStatus] = useState<GitHubConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState<'connect' | 'disconnect' | null>(null);

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const configResult = await api<GitHubAppConfigStatus>('/git/github/config');
        if (cancelled) {
          return;
        }
        setConfig(configResult);

        try {
          const statusResult = await api<GitHubConnectionStatus>('/git/github/status');
          if (!cancelled) {
            setStatus(statusResult);
          }
        } catch (statusErr: unknown) {
          if (cancelled) {
            return;
          }
          if (statusErr instanceof ApiError && statusErr.status === 401) {
            clearAccessToken();
            router.replace('/login');
            return;
          }
          setStatus(null);
          setError('暂时无法读取 GitHub 连接状态');
        }
      } catch (err: unknown) {
        if (cancelled) {
          return;
        }
        if (err instanceof ApiError && err.status === 401) {
          clearAccessToken();
          router.replace('/login');
          return;
        }
        setConfig(null);
        setStatus(null);
        setError('暂时无法读取 GitHub 连接状态');
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    function onPageShow(): void {
      setBusy(null);
    }
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  // Clear callback query after config is known (no sticky banners).
  useEffect(() => {
    if (loading || !githubResult || cleanedQuery.current) {
      return;
    }
    cleanedQuery.current = true;
    router.replace('/code-platforms', { scroll: false });
  }, [loading, githubResult, router]);

  async function reload(): Promise<void> {
    setLoading(true);
    setError(null);
    setBusy(null);
    try {
      const configResult = await api<GitHubAppConfigStatus>('/git/github/config');
      setConfig(configResult);
      try {
        const statusResult = await api<GitHubConnectionStatus>('/git/github/status');
        setStatus(statusResult);
      } catch (statusErr: unknown) {
        if (statusErr instanceof ApiError && statusErr.status === 401) {
          clearAccessToken();
          router.replace('/login');
          return;
        }
        setStatus(null);
        setError('暂时无法读取 GitHub 连接状态');
      }
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 401) {
        clearAccessToken();
        router.replace('/login');
        return;
      }
      setConfig(null);
      setStatus(null);
      setError('暂时无法读取 GitHub 连接状态');
    } finally {
      setLoading(false);
    }
  }

  async function connect(): Promise<void> {
    if (!config?.configured) {
      setError(PRODUCT_COPY.githubNotConfigured);
      return;
    }
    setBusy('connect');
    setError(null);
    try {
      const result = await api<{ url: string }>(
        '/git/github/authorize?returnTo=/code-platforms',
      );
      window.location.assign(result.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法开始 GitHub 授权');
      setBusy(null);
    }
  }

  async function disconnect(): Promise<void> {
    if (!window.confirm(PRODUCT_COPY.githubDisconnectConfirm)) {
      return;
    }
    setBusy('disconnect');
    setError(null);
    try {
      await api('/git/github/connection', { method: 'DELETE' });
      setFeedback('已断开 GitHub 连接');
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : '断开失败');
      setBusy(null);
    }
  }

  const configured = config?.configured === true;
  const connected = Boolean(status?.connected);
  const needsReauth = Boolean(status?.needsReauth);

  // Derive callback banners from URL + live config (never override configured=true).
  const queryFeedback = githubResult === 'connected' ? 'GitHub 已连接' : null;
  let queryError: string | null = null;
  if (!loading && githubResult === 'error') {
    if (githubReason === 'not_configured' && !configured) {
      queryError = PRODUCT_COPY.githubNotConfigured;
    } else if (githubReason === 'not_configured' && configured) {
      queryError = null;
    } else {
      queryError = 'GitHub 授权失败，请重试。';
    }
  }

  const bannerFeedback = feedback || queryFeedback;
  const bannerError = error || queryError;

  let connectionLabel: string = PRODUCT_COPY.githubNotConnected;
  if (needsReauth) {
    connectionLabel = PRODUCT_COPY.githubNeedsReauth;
  } else if (connected) {
    connectionLabel = PRODUCT_COPY.githubConnected;
  }

  return (
    <main className="min-h-screen bg-zinc-50 px-4 py-8 sm:px-6 sm:py-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <ProductNav />
        <div>
          <Link className="text-sm text-zinc-500" href="/settings">
            ← 返回设置
          </Link>
          <h1 className="mt-2 text-3xl font-semibold text-zinc-900">{PRODUCT_COPY.codePlatforms}</h1>
          <p className="mt-2 text-sm text-zinc-600">{PRODUCT_COPY.codePlatformsHint}</p>
        </div>

        {bannerError ? (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <p>{bannerError}</p>
            <button className="mt-2 text-sm underline" type="button" onClick={() => void reload()}>
              重新加载
            </button>
          </div>
        ) : null}
        {bannerFeedback ? (
          <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            {bannerFeedback}
          </p>
        ) : null}

        <section className="rounded-2xl border border-zinc-200 bg-white p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-medium text-zinc-900">GitHub</h2>
              {loading ? (
                <p className="mt-2 text-sm text-zinc-500">加载中…</p>
              ) : (
                <dl className="mt-3 space-y-3 text-sm text-zinc-700">
                  <div>
                    <dt className="text-zinc-500">GitHub App</dt>
                    <dd className="font-medium text-zinc-900">
                      {configured ? '已配置' : PRODUCT_COPY.githubNotConfigured}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-zinc-500">GitHub 连接</dt>
                    <dd className="font-medium text-zinc-900">{connectionLabel}</dd>
                  </div>
                  {status?.login ? (
                    <div>
                      <dt className="text-zinc-500">账号</dt>
                      <dd>{status.login}</dd>
                    </div>
                  ) : null}
                  {status?.repositoryCount != null ? (
                    <div>
                      <dt className="text-zinc-500">已授权仓库</dt>
                      <dd>{status.repositoryCount}</dd>
                    </div>
                  ) : null}
                </dl>
              )}
              <p className="mt-3 text-xs text-zinc-500">{PRODUCT_COPY.githubSelectReposHint}</p>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
                type="button"
                disabled={loading || Boolean(busy) || !configured}
                onClick={() => void connect()}
              >
                {busy === 'connect'
                  ? '正在前往 GitHub…'
                  : connected || needsReauth
                    ? PRODUCT_COPY.reconnectGithub
                    : PRODUCT_COPY.connectGithub}
              </button>
              {connected || needsReauth ? (
                <button
                  className="rounded-lg border border-zinc-200 px-4 py-2 text-sm text-zinc-700 disabled:opacity-60"
                  type="button"
                  disabled={loading || Boolean(busy)}
                  onClick={() => void disconnect()}
                >
                  {busy === 'disconnect' ? '处理中…' : PRODUCT_COPY.disconnectGithub}
                </button>
              ) : null}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

export default function CodePlatformsPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-zinc-50 text-sm text-zinc-500">
          加载中…
        </main>
      }
    >
      <CodePlatformsInner />
    </Suspense>
  );
}
