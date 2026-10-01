'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/section';
import { StatusBadge } from '@/components/ui/status-badge';
import { api } from '@/lib/api';

type ListResponse = {
  page: number;
  pageSize: number;
  total: number;
  items: Array<{
    id: string;
    hostname: string;
    type: string;
    status: string;
    dnsStatus: string;
    sslStatus: string;
    gatewayStatus: string;
    appId: string;
    appName: string;
    workspaceId: string;
    workspaceName: string;
    ownerEmail: string;
  }>;
};

export default function AdminDomainsPage() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: '20' });
    if (q.trim()) params.set('q', q.trim());
    if (status) params.set('status', status);
    void api<ListResponse>(`/admin/domains?${params}`)
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '加载失败'));
  }, [page, q, status]);

  return (
    <div className="space-y-4">
      <PageHeader title="域名中心" description="全部系统域名与自定义域名" />
      {error ? <InlineAlert tone="error" title={error} /> : null}
      <div className="flex flex-wrap gap-2">
        <input
          className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm"
          placeholder="搜索 hostname / app / workspace"
          value={q}
          onChange={(e) => {
            setPage(1);
            setQ(e.target.value);
          }}
        />
        {['', 'ACTIVE', 'CREATING', 'FAILED'].map((item) => (
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
          <table className="w-full min-w-[960px] text-left text-sm">
            <thead className="border-b border-zinc-100 bg-zinc-50 text-xs text-zinc-500">
              <tr>
                <th className="px-3 py-2">Hostname</th>
                <th className="px-3 py-2">应用</th>
                <th className="px-3 py-2">Workspace</th>
                <th className="px-3 py-2">类型</th>
                <th className="px-3 py-2">DNS</th>
                <th className="px-3 py-2">SSL</th>
                <th className="px-3 py-2">Gateway</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <tr key={item.id} className="border-b border-zinc-50">
                  <td className="px-3 py-2 font-medium">{item.hostname}</td>
                  <td className="px-3 py-2">
                    <Link className="underline" href={`/admin/apps/${item.appId}`}>
                      {item.appName}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <Link className="underline" href={`/admin/workspaces/${item.workspaceId}`}>
                      {item.workspaceName}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{item.type === 'SYSTEM' ? '系统域名' : '自定义域名'}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={item.dnsStatus} />
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={item.sslStatus} />
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={item.gatewayStatus} />
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
