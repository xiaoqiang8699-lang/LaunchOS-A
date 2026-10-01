'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/section';
import { StatusBadge } from '@/components/ui/status-badge';
import { api, ApiError } from '@/lib/api';

type Item = {
  id: string;
  name: string;
  workspace: string;
  workspaceId?: string;
  owner: string;
  type: string;
  status: string;
  publicUrl: string | null;
  healthStatus: string;
  lastLaunchAt: string | null;
  launchStatus: string | null;
};

type Page = { page: number; pageSize: number; total: number; items: Item[] };

export default function AdminAppsPage() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState('');
  const [health, setHealth] = useState('');

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: '20' });
    if (q.trim()) params.set('q', q.trim());
    api<Page>(`/admin/apps?${params}`)
      .then(setData)
      .catch((reason) => setError(reason instanceof ApiError ? reason.message : '加载失败'));
  }, [page, q]);

  const items = (data?.items || []).filter((row) => {
    if (!health) return true;
    if (health === 'healthy') return row.healthStatus === 'HEALTHY' || row.status === 'RUNNING';
    if (health === 'unhealthy') return row.healthStatus === 'UNHEALTHY' || row.status === 'FAILED';
    if (health === 'stopped') return row.status === 'STOPPED';
    if (health === 'failed') return row.launchStatus === 'FAILED' || row.status === 'FAILED';
    return true;
  });

  return (
    <div className="space-y-4">
      <PageHeader title="应用中心" description="全平台应用 · 运行与公网状态" />
      {error ? <InlineAlert tone="error" title={error} /> : null}
      <div className="flex flex-wrap gap-2">
        <input
          className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm"
          placeholder="搜索应用 / Workspace"
          value={q}
          onChange={(e) => {
            setPage(1);
            setQ(e.target.value);
          }}
        />
        {(
          [
            ['', '全部'],
            ['healthy', '正常'],
            ['unhealthy', '异常'],
            ['stopped', '已停止'],
            ['failed', '上线失败'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value || 'all'}
            type="button"
            className={`rounded-lg px-3 py-2 text-sm ${
              health === value ? 'bg-zinc-900 text-white' : 'border border-zinc-200 bg-white'
            }`}
            onClick={() => setHealth(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {!data ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
          <table className="w-full min-w-[960px] text-left text-sm">
            <thead className="border-b bg-zinc-50 text-xs text-zinc-500">
              <tr>
                <th className="px-3 py-2">应用</th>
                <th className="px-3 py-2">Workspace</th>
                <th className="px-3 py-2">Owner</th>
                <th className="px-3 py-2">类型</th>
                <th className="px-3 py-2">运行状态</th>
                <th className="px-3 py-2">公网</th>
                <th className="px-3 py-2">健康</th>
                <th className="px-3 py-2">最近上线</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.id} className="border-b border-zinc-50">
                  <td className="px-3 py-2">
                    <Link className="font-medium underline" href={`/admin/apps/${row.id}`}>
                      {row.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    {row.workspaceId ? (
                      <Link className="underline" href={`/admin/workspaces/${row.workspaceId}`}>
                        {row.workspace}
                      </Link>
                    ) : (
                      row.workspace
                    )}
                  </td>
                  <td className="px-3 py-2">{row.owner}</td>
                  <td className="px-3 py-2">{row.type}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="px-3 py-2 text-xs">{row.publicUrl || '—'}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={row.healthStatus} />
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {row.lastLaunchAt ? new Date(row.lastLaunchAt).toLocaleString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between px-3 py-2 text-sm text-zinc-500">
            <span>
              共 {data.total} 条 · 第 {data.page} 页
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded border px-2 py-1 disabled:opacity-40"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                上一页
              </button>
              <button
                type="button"
                className="rounded border px-2 py-1 disabled:opacity-40"
                disabled={page * data.pageSize >= data.total}
                onClick={() => setPage((p) => p + 1)}
              >
                下一页
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
