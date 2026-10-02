'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ControlCenter } from '@/components/control-center';
import { PageHeader } from '@/components/ui/section';
import { Card } from '@/components/ui/section';
import { StatusBadge } from '@/components/ui/status-badge';
import { Skeleton, InlineAlert } from '@/components/ui/feedback';
import { PrimaryLink } from '@/components/ui/button';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import { formatDateTime } from '@/lib/project-labels';
import type { AppSummary } from '@/lib/types';

type UsageView = {
  planName?: string;
  plan?: string;
  ui?: Record<string, string>;
  usage?: {
    projects?: number;
    monthlyDeployments?: number;
  };
  remaining?: { monthlyDeployments?: number | null };
  entitlements?: {
    maxProjects?: number | null;
    maxMonthlyDeployments?: number | null;
  };
  source?: string;
  override?: { reason?: string } | null;
};

type ActivationView = {
  activated: boolean;
  stageLabel: string;
  statusLabel: string;
  primaryBlocker: string | null;
  blockerLabel: string | null;
  progress: { completedSteps: number; totalSteps: number };
  nextActions: Array<{ title: string; href: string | null; reason: string }>;
  projectId: string | null;
};

function needsAttention(app: AppSummary): boolean {
  return (
    app.applicationStatus === 'FAILED' ||
    app.applicationStatus === 'WARNING' ||
    app.applicationStatus === 'STOPPED'
  );
}

export default function OverviewPage() {
  const router = useRouter();
  const [apps, setApps] = useState<AppSummary[] | null>(null);
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [activation, setActivation] = useState<ActivationView | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }
    void Promise.all([
      api<AppSummary[]>('/apps'),
      api<UsageView>('/account/usage').catch(() => null),
      api<ActivationView>('/activation').catch(() => null),
    ])
      .then(([nextApps, nextUsage, nextActivation]) => {
        setApps(nextApps);
        setUsage(nextUsage);
        setActivation(nextActivation);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : '加载失败'));
  }, [router]);

  const summary = useMemo(() => {
    const list = apps || [];
    const healthy = list.filter((a) => a.applicationStatus === 'RUNNING').length;
    const attention = list.filter(needsAttention).length;
    return { total: list.length, healthy, attention };
  }, [apps]);

  const attentionApps = (apps || []).filter(needsAttention).slice(0, 5);
  const recentApps = (apps || []).slice(0, 5);

  return (
    <ControlCenter>
      <PageHeader
        title="概览"
        description="一眼看清应用状态、需要处理的事项，以及本月上线额度。"
      />

      {error ? <InlineAlert tone="error" title="加载失败" description={error} /> : null}

      {!apps ? (
        <div className="grid gap-3 sm:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="p-4">
              <p className="text-xs text-[var(--los-secondary)]">你的应用</p>
              <p className="mt-1 text-2xl font-semibold">{summary.total}</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs text-[var(--los-secondary)]">运行正常</p>
              <p className="mt-1 text-2xl font-semibold text-[var(--los-success)]">
                {summary.healthy}
              </p>
            </Card>
            <Card className="p-4">
              <p className="text-xs text-[var(--los-secondary)]">需要处理</p>
              <p className="mt-1 text-2xl font-semibold text-[var(--los-warning)]">
                {summary.attention}
              </p>
            </Card>
            <Card className="p-4">
              <p className="text-xs text-[var(--los-secondary)]">本月上线</p>
              <p className="mt-1 text-2xl font-semibold">
                {usage?.ui?.monthlyDeployments ||
                  `${usage?.usage?.monthlyDeployments ?? '—'} / ${usage?.entitlements?.maxMonthlyDeployments ?? '—'}`}
              </p>
              {usage?.source === 'BETA_TESTER_OVERRIDE' ? (
                <p className="mt-1 text-xs text-[var(--los-muted)]">Beta 测试额度</p>
              ) : null}
              <Link className="mt-2 inline-block text-xs underline" href="/usage">
                查看用量
              </Link>
            </Card>
          </div>

          {activation && !activation.activated ? (
            <section className="mt-8 space-y-3">
              <h2 className="text-lg font-semibold">继续完成上线</h2>
              <Card className="p-5">
                <p className="text-sm text-[var(--los-secondary)]">
                  应用上线进度 {activation.progress.completedSteps} / {activation.progress.totalSteps}
                </p>
                <p className="mt-2 text-base font-medium">
                  当前：{activation.blockerLabel || activation.primaryBlocker || activation.stageLabel}
                </p>
                <p className="mt-1 text-sm text-[var(--los-secondary)]">
                  下一步：{activation.nextActions[0]?.reason || activation.statusLabel}
                </p>
                {activation.nextActions[0]?.href ? (
                  <div className="mt-4">
                    <PrimaryLink href={activation.nextActions[0].href}>
                      {activation.nextActions[0].title}
                    </PrimaryLink>
                  </div>
                ) : null}
              </Card>
            </section>
          ) : null}

          {attentionApps.length > 0 ? (
            <section className="mt-8 space-y-3">
              <h2 className="text-lg font-semibold">需要处理</h2>
              <Card className="divide-y divide-[var(--los-border)]">
                {attentionApps.map((app) => (
                  <div
                    key={app.id}
                    className="flex items-center justify-between gap-3 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{app.name}</p>
                      <div className="mt-1">
                        <StatusBadge status={app.applicationStatus} />
                      </div>
                    </div>
                    <Link
                      className="shrink-0 text-sm font-medium text-[var(--los-text)] underline"
                      href={`/projects/${app.id}`}
                    >
                      查看问题
                    </Link>
                  </div>
                ))}
              </Card>
            </section>
          ) : null}

          <section className="mt-8 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">最近应用</h2>
              <Link className="text-sm text-[var(--los-secondary)] underline" href="/projects">
                查看全部
              </Link>
            </div>
            {recentApps.length === 0 ? (
              <Card className="p-8 text-center">
                <p className="font-medium">还没有应用</p>
                <p className="mt-1 text-sm text-[var(--los-secondary)]">
                  连接 GitHub 或上传代码，几分钟内发布你的第一个网站。
                </p>
                <div className="mt-4 flex justify-center">
                  <PrimaryLink href="/projects/new">创建第一个应用</PrimaryLink>
                </div>
              </Card>
            ) : (
              <Card className="divide-y divide-[var(--los-border)]">
                {recentApps.map((app) => (
                  <div
                    key={app.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <Link
                        href={`/projects/${app.id}`}
                        className="font-medium hover:underline"
                      >
                        {app.name}
                      </Link>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--los-secondary)]">
                        <StatusBadge status={app.applicationStatus} />
                        {app.visitUrl ? <span className="truncate">{app.visitUrl.replace(/^https?:\/\//, '')}</span> : null}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      {app.visitUrlReady && app.visitUrl ? (
                        <a
                          className="rounded-lg bg-[var(--los-action)] px-3 py-1.5 text-sm text-white"
                          href={app.visitUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          打开
                        </a>
                      ) : (
                        <Link
                          className="rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm"
                          href={`/projects/${app.id}`}
                        >
                          详情
                        </Link>
                      )}
                    </div>
                  </div>
                ))}
              </Card>
            )}
          </section>

          <section className="mt-8 space-y-3">
            <h2 className="text-lg font-semibold">最近动态</h2>
            <Card className="divide-y divide-[var(--los-border)]">
              {recentApps.slice(0, 5).map((app) => (
                <div key={`act-${app.id}`} className="px-4 py-3 text-sm">
                  <p className="text-[var(--los-text)]">
                    <span className="font-medium">{app.name}</span>
                    {app.applicationStatus === 'RUNNING'
                      ? ' 运行正常'
                      : app.applicationStatus === 'FAILED'
                        ? ' 上线失败'
                        : app.applicationStatus === 'DEPLOYING'
                          ? ' 正在上线'
                          : ` ${app.applicationStatus}`}
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--los-muted)]">
                    {app.lastDeployedAt ? formatDateTime(app.lastDeployedAt) : '—'}
                  </p>
                </div>
              ))}
              {recentApps.length === 0 ? (
                <p className="px-4 py-6 text-sm text-[var(--los-secondary)]">暂无动态</p>
              ) : null}
            </Card>
          </section>
        </>
      )}
    </ControlCenter>
  );
}
