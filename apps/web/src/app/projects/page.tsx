'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ControlCenter } from '@/components/control-center';
import { PageHeader } from '@/components/ui/section';
import { Card } from '@/components/ui/section';
import { StatusBadge } from '@/components/ui/status-badge';
import { EmptyState, InlineAlert, Skeleton } from '@/components/ui/feedback';
import { PrimaryLink, SecondaryLink } from '@/components/ui/button';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import { APPLICATION_PURPOSE_LABELS, formatDateTime } from '@/lib/project-labels';
import type { AppSummary } from '@/lib/types';
import { cn } from '@/lib/utils';

type Filter = 'all' | 'healthy' | 'attention' | 'stopped';

export default function MyAppsPage() {
  const router = useRouter();
  const [apps, setApps] = useState<AppSummary[] | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }
    void api<AppSummary[]>('/apps')
      .then(setApps)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : '加载失败'));
  }, [router]);

  const filtered = useMemo(() => {
    let list = apps || [];
    if (q.trim()) {
      const needle = q.trim().toLowerCase();
      list = list.filter((a) => a.name.toLowerCase().includes(needle));
    }
    if (filter === 'healthy') list = list.filter((a) => a.applicationStatus === 'RUNNING');
    if (filter === 'attention') {
      list = list.filter((a) =>
        ['FAILED', 'WARNING', 'STOPPED'].includes(a.applicationStatus),
      );
    }
    if (filter === 'stopped') list = list.filter((a) => a.applicationStatus === 'STOPPED');
    return list;
  }, [apps, q, filter]);

  return (
    <ControlCenter>
      <PageHeader
        title="我的应用"
        description="查看运行状态、访问地址，并进入应用详情。"
        action={<PrimaryLink href="/projects/new">创建应用</PrimaryLink>}
      />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1 rounded-lg border border-[var(--los-border)] bg-white p-1">
          {(
            [
              ['all', '全部'],
              ['healthy', '运行正常'],
              ['attention', '需要处理'],
              ['stopped', '已停止'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={cn(
                'rounded-md px-3 py-1.5 text-sm',
                filter === key
                  ? 'bg-zinc-900 text-white'
                  : 'text-[var(--los-secondary)] hover:bg-[var(--los-sidebar-active)]',
              )}
              onClick={() => setFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          className="w-full rounded-lg border border-[var(--los-border)] bg-white px-3 py-2 text-sm sm:max-w-xs"
          placeholder="搜索应用名"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="搜索应用"
        />
      </div>

      {error ? <InlineAlert tone="error" title="加载失败" description={error} /> : null}

      {!apps ? (
        <div className="space-y-2">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : apps.length === 0 ? (
        <EmptyState
          title="还没有应用"
          description="连接 GitHub 或上传代码，几分钟内发布你的第一个网站。"
          actionLabel="创建第一个应用"
          actionHref="/projects/new"
        />
      ) : filtered.length === 0 ? (
        <Card className="p-8 text-center text-sm text-[var(--los-secondary)]">没有匹配的应用</Card>
      ) : (
        <Card className="divide-y divide-[var(--los-border)]">
          {filtered.map((app) => (
            <div
              key={app.id}
              className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/projects/${app.id}`}
                    className="truncate text-[15px] font-medium text-[var(--los-text)] hover:underline"
                  >
                    {app.name}
                  </Link>
                  <StatusBadge status={app.applicationStatus} />
                </div>
                <p className="mt-1 text-xs text-[var(--los-secondary)]">
                  {app.applicationPurpose
                    ? APPLICATION_PURPOSE_LABELS[app.applicationPurpose]
                    : '应用'}
                  {app.visitUrl ? ` · ${app.visitUrl.replace(/^https?:\/\//, '')}` : ''}
                </p>
                {app.lastDeployedAt ? (
                  <p className="mt-0.5 text-xs text-[var(--los-muted)]">
                    最近上线：{formatDateTime(app.lastDeployedAt)}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-2">
                {app.visitUrlReady && app.visitUrl ? (
                  <a
                    className="rounded-lg bg-[var(--los-action)] px-3 py-1.5 text-sm text-white"
                    href={app.visitUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    打开
                  </a>
                ) : null}
                <SecondaryLink href={`/projects/${app.id}`}>详情</SecondaryLink>
              </div>
            </div>
          ))}
        </Card>
      )}
    </ControlCenter>
  );
}
