'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { VisitUrlBlock } from '@/components/visit-url';
import { api, ApiError } from '@/lib/api';
import { clearAccessToken, getAccessToken } from '@/lib/auth';
import { PRODUCT_COPY } from '@/lib/product-language';
import {
  APP_RUNNING_STATUS_LABELS,
  APPLICATION_PURPOSE_LABELS,
  formatDateTime,
  statusBadgeClass,
} from '@/lib/project-labels';
import type { AppSummary, DeploymentDetail } from '@/lib/types';

export function WorkspaceAppsPanel() {
  const router = useRouter();
  const [apps, setApps] = useState<AppSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<'start' | 'stop' | 'redeploy' | null>(null);

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }

    let cancelled = false;
    api<AppSummary[]>('/apps')
      .then((result) => {
        if (!cancelled) {
          setApps(result);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        clearAccessToken();
        setError(err instanceof Error ? err.message : '加载失败');
        router.replace('/login');
      });

    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    if (!apps?.some((item) => item.applicationStatus === 'DEPLOYING')) {
      return;
    }
    const timer = window.setInterval(() => {
      void api<AppSummary[]>('/apps')
        .then(setApps)
        .catch(() => undefined);
    }, 2000);
    return () => {
      window.clearInterval(timer);
    };
  }, [apps]);

  async function runAction(appId: string, action: 'start' | 'stop'): Promise<void> {
    setBusyId(appId);
    setBusyAction(action);
    setError(null);
    try {
      const updated = await api<AppSummary>(`/apps/${appId}/${action}`, { method: 'POST' });
      setApps((current) =>
        current ? current.map((item) => (item.id === updated.id ? updated : item)) : current,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败');
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  }

  async function redeploy(appId: string): Promise<void> {
    setBusyId(appId);
    setBusyAction('redeploy');
    setError(null);
    try {
      const created = await api<DeploymentDetail>(`/apps/${appId}/redeploy`, { method: 'POST' });
      router.push(`/deployments/${created.id}`);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 503
          ? '上线服务暂时不可用，请稍后重试。'
          : err instanceof Error
            ? err.message
            : '重新上线失败',
      );
      setBusyId(null);
      setBusyAction(null);
    }
  }

  if (!apps) {
    return <p className="text-sm text-zinc-500">{error ?? '加载中…'}</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      {apps.length === 0 ? (
        <section className="rounded-2xl border border-zinc-200 bg-white px-6 py-16 text-center">
          <h2 className="text-lg font-medium text-zinc-900">还没有应用</h2>
          <p className="mt-2 text-sm text-zinc-500">创建第一个应用，把代码部署上线。</p>
          <Link
            className="mt-6 inline-flex rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white"
            href="/projects/new"
          >
            {PRODUCT_COPY.createApp}
          </Link>
        </section>
      ) : (
        <ul className="space-y-3">
          {apps.map((app) => {
            const status = app.applicationStatus;
            const canVisit = Boolean(app.visitUrlReady && app.visitUrl) && status === 'RUNNING';
            const managing = Boolean(app.canManage) && status !== 'READY' && status !== 'DEPLOYING';
            const busy = busyId === app.id ? busyAction : null;
            return (
              <li key={app.id} className="rounded-2xl border border-zinc-200 bg-white px-5 py-4">
                <div className="flex items-center justify-between gap-3">
                  <Link className="min-w-0 hover:opacity-90" href={`/projects/${app.id}`}>
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-zinc-900">{app.name}</p>
                      {app.isDemo ? (
                        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
                          {PRODUCT_COPY.demoBadge}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-sm text-zinc-500">
                      {app.applicationPurpose
                        ? APPLICATION_PURPOSE_LABELS[app.applicationPurpose]
                        : PRODUCT_COPY.purposeUnset}
                    </p>
                  </Link>
                  <span
                    className={`shrink-0 rounded-full px-2.5 py-1 text-xs ${statusBadgeClass(status)}`}
                  >
                    {app.aggregateLabel || APP_RUNNING_STATUS_LABELS[status]}
                  </span>
                </div>
                {app.composition && app.composition.total > 0 ? (
                  <p className="mt-2 text-sm text-zinc-500">
                    {app.composition.launchable > 0
                      ? `${app.composition.launchable} 个可上线内容`
                      : null}
                    {app.composition.launchable > 0 && app.composition.mobile > 0 ? ' · ' : null}
                    {app.composition.mobile > 0 ? `${app.composition.mobile} 个移动APP` : null}
                    {app.composition.launchable === 0 && app.composition.mobile === 0
                      ? `${app.composition.total} 个组成部分`
                      : null}
                  </p>
                ) : null}
                <div className="mt-3 text-sm text-zinc-500">
                  {app.systemDomain ? <p>域名：{app.systemDomain}</p> : null}
                  <p className={app.systemDomain ? 'mt-2' : undefined}>{PRODUCT_COPY.visitUrl}</p>
                  <div className="mt-1">
                    <VisitUrlBlock
                      visitUrl={app.visitUrl}
                      localVisitUrl={app.localVisitUrl}
                      preparing={app.visitUrlPreparing}
                      ready={app.visitUrlReady}
                      compact
                    />
                  </div>
                  <p className="mt-2">
                    最近上线：{app.lastDeployedAt ? formatDateTime(app.lastDeployedAt) : '尚未上线'}
                  </p>
                </div>
                {app.pendingUpdate ? (
                  <p className="mt-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    {PRODUCT_COPY.foundNewVersion}
                    {app.pendingUpdate.commitMessage
                      ? `：${app.pendingUpdate.commitMessage}`
                      : app.pendingUpdate.commitSha
                        ? `（${app.pendingUpdate.commitSha.slice(0, 7)}）`
                        : ''}
                  </p>
                ) : null}
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {canVisit ? (
                    <a
                      className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white"
                      href={app.visitUrl || '#'}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {PRODUCT_COPY.openApp}
                    </a>
                  ) : (
                    <button
                      className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white opacity-50"
                      type="button"
                      disabled
                    >
                      {PRODUCT_COPY.openApp}
                    </button>
                  )}
                  <button
                    className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm text-zinc-700 disabled:opacity-50"
                    type="button"
                    disabled={Boolean(busy) || status === 'DEPLOYING' || status === 'READY'}
                    onClick={() => void redeploy(app.id)}
                  >
                    {busy === 'redeploy' ? PRODUCT_COPY.goingLive : PRODUCT_COPY.goLiveAgain}
                  </button>
                  <button
                    className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm text-zinc-700 disabled:opacity-50"
                    type="button"
                    disabled={Boolean(busy) || !managing || status === 'STOPPED'}
                    onClick={() => void runAction(app.id, 'stop')}
                  >
                    {busy === 'stop' ? PRODUCT_COPY.stoppingApp : PRODUCT_COPY.stopApp}
                  </button>
                  <button
                    className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm text-zinc-700 disabled:opacity-50"
                    type="button"
                    disabled={Boolean(busy) || !managing || status === 'RUNNING'}
                    onClick={() => void runAction(app.id, 'start')}
                  >
                    {busy === 'start' ? PRODUCT_COPY.startingApp : PRODUCT_COPY.startApp}
                  </button>
                  <Link
                    className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm text-zinc-700"
                    href={`/projects/${app.id}#issues`}
                  >
                    {PRODUCT_COPY.issuesCenter}
                  </Link>
                </div>
                {!app.canManage ? (
                  <p className="mt-3 text-xs text-zinc-500">{PRODUCT_COPY.goLiveFirst}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
