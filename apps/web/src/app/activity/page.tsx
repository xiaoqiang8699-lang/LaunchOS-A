'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ControlCenter } from '@/components/control-center';
import { PageHeader, Card } from '@/components/ui/section';
import { StatusBadge } from '@/components/ui/status-badge';
import { Skeleton, InlineAlert } from '@/components/ui/feedback';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import { formatDateTime } from '@/lib/project-labels';
import type { AppSummary } from '@/lib/types';

/** Workspace-level recent activity (lightweight; per-app history remains under each project). */
export default function ActivityPage() {
  const router = useRouter();
  const [apps, setApps] = useState<AppSummary[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }
    void api<AppSummary[]>('/apps')
      .then(setApps)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : '加载失败'));
  }, [router]);

  return (
    <ControlCenter>
      <PageHeader
        title="上线记录"
        description="从应用进入完整上线历史；此处汇总各应用最近状态。"
      />
      {error ? <InlineAlert tone="error" title="加载失败" description={error} /> : null}
      {!apps ? (
        <Skeleton className="h-40" />
      ) : (
        <Card className="divide-y divide-[var(--los-border)]">
          {apps.length === 0 ? (
            <p className="px-4 py-8 text-sm text-[var(--los-secondary)]">暂无上线记录</p>
          ) : (
            apps.map((app) => (
              <div
                key={app.id}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="font-medium">{app.name}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--los-secondary)]">
                    <StatusBadge status={app.applicationStatus} />
                    <span>{app.lastDeployedAt ? formatDateTime(app.lastDeployedAt) : '—'}</span>
                  </div>
                </div>
                <Link
                  className="shrink-0 text-sm underline"
                  href={`/projects/${app.id}/deployments`}
                >
                  查看详情
                </Link>
              </div>
            ))
          )}
        </Card>
      )}
    </ControlCenter>
  );
}
