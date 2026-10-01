'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { Card, PageHeader } from '@/components/ui/section';
import { StatusBadge } from '@/components/ui/status-badge';
import { api } from '@/lib/api';

type ListResponse = {
  page: number;
  pageSize: number;
  total: number;
  summary: {
    running: number;
    queued: number;
    todaySuccess: number;
    todayFailed: number;
  };
  items: Array<{
    id: string;
    status: string;
    version: string | null;
    createdAt: string;
    durationMs: number | null;
    failureCategory: string | null;
    errorMessage: string | null;
    appId: string;
    appName: string;
    workspaceName: string;
    ownerEmail: string;
  }>;
};

export default function AdminDeploymentsPage() {
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: '20' });
    if (status) params.set('status', status);
    if (q.trim()) params.set('q', q.trim());
    void api<ListResponse>(`/admin/deployments?${params}`)
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '加载失败'));
  }, [page, status, q]);

  return (
    <div className="space-y-4">
      <PageHeader title="部署中心" description="全平台 Deployment 控制台" />
      {error ? <InlineAlert tone="error" title={error} /> : null}

      {data ? (
        <div className="grid gap-3 sm:grid-cols-4">
          <Card className="p-3 text-sm">
            <p className="text-zinc-500">正在部署</p>
            <p className="mt-1 text-xl font-semibold">{data.summary.running}</p>
          </Card>
          <Card className="p-3 text-sm">
            <p className="text-zinc-500">排队</p>
            <p className="mt-1 text-xl font-semibold">{data.summary.queued}</p>
          </Card>
          <Card className="p-3 text-sm">
            <p className="text-zinc-500">今日成功</p>
            <p className="mt-1 text-xl font-semibold">{data.summary.todaySuccess}</p>
          </Card>
          <Card className="p-3 text-sm">
            <p className="text-zinc-500">今日失败</p>
            <p className="mt-1 text-xl font-semibold">{data.summary.todayFailed}</p>
          </Card>
        </div>
      ) : (
        <Skeleton className="h-20" />
      )}

      <div className="flex flex-wrap gap-2">
        <input
          className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm"
          placeholder="搜索 app / workspace / email / id"
          value={q}
          onChange={(e) => {
            setPage(1);
            setQ(e.target.value);
          }}
        />
        {['', 'SUCCESS', 'FAILED', 'RUNNING', 'QUEUED'].map((item) => (
          <button
            key={item || 'all'}
            type="button"
            className={`rounded-lg px-3 py-2 text-sm ${
              status === item ? 'bg-zinc-900 text-white' : 'border border-zinc-200 bg-white'
            }`}
            onClick={() => {
              setPage(1);
              setStatus(item);
            }}
          >
            {item || '全部'}
          </button>
        ))}
      </div>

      {!data ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="border-b border-zinc-100 bg-zinc-50 text-xs text-zinc-500">
              <tr>
                <th className="px-3 py-2">Deployment</th>
                <th className="px-3 py-2">应用</th>
                <th className="px-3 py-2">Workspace</th>
                <th className="px-3 py-2">用户</th>
                <th className="px-3 py-2">状态</th>
                <th className="px-3 py-2">失败分类</th>
                <th className="px-3 py-2">开始时间</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <tr key={item.id} className="border-b border-zinc-50 hover:bg-zinc-50/80">
                  <td className="px-3 py-2">
                    <Link className="font-medium underline" href={`/admin/deployments/${item.id}`}>
                      {item.id.slice(0, 10)}…
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <Link className="underline" href={`/admin/apps/${item.appId}`}>
                      {item.appName}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{item.workspaceName}</td>
                  <td className="px-3 py-2">{item.ownerEmail}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={item.status} />
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-600">{item.failureCategory || '—'}</td>
                  <td className="px-3 py-2 text-xs text-zinc-500">
                    {new Date(item.createdAt).toLocaleString()}
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
