'use client';

import { useEffect, useState } from 'react';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/section';
import { api } from '@/lib/api';

type Row = {
  id: string;
  action: string;
  createdAt: string;
  user?: { email?: string; name?: string } | null;
  workspace?: { name?: string } | null;
  targetType?: string | null;
  targetId?: string | null;
  result?: string | null;
};

export default function AdminAuditPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void api<Row[] | { items: Row[] }>('/admin/audit')
      .then((payload) => setRows(Array.isArray(payload) ? payload : payload.items || []))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : '加载失败');
        setRows([]);
      });
  }, []);

  return (
    <div className="space-y-4">
      <PageHeader
        title="审计与安全"
        description="管理员操作、订阅变更、资源删除与安全事件。系统严重度 INFO / WARNING / CRITICAL，勿与 Beta P0–P3 混淆。"
      />
      {error ? <InlineAlert tone="error" title={error} /> : null}
      {!rows ? (
        <Skeleton className="h-48" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-zinc-500">暂无审计记录</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
          <table className="w-full min-w-[880px] text-left text-sm">
            <thead className="border-b bg-zinc-50 text-xs text-zinc-500">
              <tr>
                <th className="px-3 py-2">时间</th>
                <th className="px-3 py-2">操作者</th>
                <th className="px-3 py-2">动作</th>
                <th className="px-3 py-2">目标</th>
                <th className="px-3 py-2">Workspace</th>
                <th className="px-3 py-2">结果</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-zinc-50">
                  <td className="px-3 py-2 text-xs text-zinc-500">
                    {new Date(row.createdAt).toLocaleString()}
                  </td>
                  <td className="px-3 py-2">{row.user?.email || row.user?.name || '—'}</td>
                  <td className="px-3 py-2 font-medium">{row.action}</td>
                  <td className="px-3 py-2 text-xs">
                    {row.targetType || '—'}
                    {row.targetId ? ` · ${row.targetId.slice(0, 10)}…` : ''}
                  </td>
                  <td className="px-3 py-2">{row.workspace?.name || '—'}</td>
                  <td className="px-3 py-2">{row.result || 'OK'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
