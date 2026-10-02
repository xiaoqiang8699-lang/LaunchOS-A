'use client';

import { useEffect, useState } from 'react';
import { AdminGrowthTabs } from '@/components/admin/admin-growth-tabs';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { PageHeader, Section } from '@/components/ui/section';
import { api } from '@/lib/api';

type EventItem = {
  id: string;
  eventType: string;
  userId: string | null;
  userEmail: string | null;
  userName: string | null;
  workspaceId: string | null;
  projectId: string | null;
  createdAt: string;
};

type EventsPage = {
  page: number;
  pageSize: number;
  total: number;
  items: EventItem[];
};

const EVENT_FILTERS = [
  '',
  'USER_REGISTERED',
  'WORKSPACE_CREATED',
  'PROJECT_CREATED',
  'SOURCE_CONNECTED',
  'DEPLOY_STARTED',
  'DEPLOY_SUCCESS',
  'DOMAIN_CONNECTED',
  'PLAN_VIEWED',
  'PLAN_CHANGED',
] as const;

export default function AdminGrowthJourneyPage() {
  const [data, setData] = useState<EventsPage | null>(null);
  const [error, setError] = useState('');
  const [eventType, setEventType] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: '20' });
    if (eventType) params.set('eventType', eventType);
    if (q.trim()) params.set('q', q.trim());
    void api<EventsPage>(`/admin/growth/events?${params}`)
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '加载失败'));
  }, [eventType, q, page]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="space-y-5">
      <PageHeader title="用户旅程" description="查看 ProductEvent，定位用户在哪一步流失" />
      <AdminGrowthTabs />
      {error ? <InlineAlert tone="error" title={error} /> : null}

      <Section title="事件流">
        <div className="mb-3 flex flex-wrap gap-2">
          <select
            className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm"
            value={eventType}
            onChange={(e) => {
              setPage(1);
              setEventType(e.target.value);
            }}
          >
            <option value="">全部事件</option>
            {EVENT_FILTERS.filter(Boolean).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <input
            className="min-w-[200px] flex-1 rounded-lg border border-zinc-200 px-3 py-2 text-sm"
            placeholder="按 userId / projectId / workspaceId 搜索"
            value={q}
            onChange={(e) => {
              setPage(1);
              setQ(e.target.value);
            }}
          />
        </div>

        {!data ? (
          <Skeleton className="h-48" />
        ) : (
          <>
            <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-zinc-200 bg-zinc-50 text-xs text-zinc-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">时间</th>
                    <th className="px-3 py-2 font-medium">事件</th>
                    <th className="px-3 py-2 font-medium">用户</th>
                    <th className="px-3 py-2 font-medium">Workspace</th>
                    <th className="px-3 py-2 font-medium">Project</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.length === 0 ? (
                    <tr>
                      <td className="px-3 py-4 text-zinc-500" colSpan={5}>
                        暂无事件（新行为发生后会出现）
                      </td>
                    </tr>
                  ) : (
                    data.items.map((row) => (
                      <tr key={row.id} className="border-b border-zinc-100 last:border-0">
                        <td className="whitespace-nowrap px-3 py-2 text-zinc-600">
                          {new Date(row.createdAt).toLocaleString()}
                        </td>
                        <td className="px-3 py-2 font-medium text-zinc-900">{row.eventType}</td>
                        <td className="px-3 py-2 text-zinc-700">
                          {row.userEmail || row.userName || row.userId?.slice(0, 8) || '—'}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-zinc-500">
                          {row.workspaceId?.slice(0, 10) || '—'}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-zinc-500">
                          {row.projectId?.slice(0, 10) || '—'}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex items-center justify-between text-sm text-zinc-600">
              <span>
                共 {data.total} 条 · 第 {data.page}/{totalPages} 页
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 disabled:opacity-40"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  上一页
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 disabled:opacity-40"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  下一页
                </button>
              </div>
            </div>
          </>
        )}
      </Section>
    </div>
  );
}
