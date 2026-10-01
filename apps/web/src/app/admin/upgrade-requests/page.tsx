'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';

type RequestRow = {
  id: string;
  status: string;
  reason: string;
  fromSource: string | null;
  workspace: { name: string };
  fromPlan: { name: string; code: string };
  requestedPlan: { name: string; code: string };
  requestedBy: { name: string | null; email: string };
};

const STATUS: Record<string, string> = { PENDING: '待处理', APPROVED: '已批准', REJECTED: '已拒绝', CANCELED: '已取消' };

export default function UpgradeRequestsPage() {
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  function load() {
    api<RequestRow[]>('/admin/upgrade-requests').then(setRows).catch((reason) => setError(reason instanceof ApiError ? reason.message : '加载失败'));
  }

  useEffect(() => { load(); }, []);

  async function act(id: string, action: 'approve' | 'reject') {
    setError('');
    try {
      await api(`/admin/upgrade-requests/${id}/${action}`, { method: 'POST', body: '{}' });
      setMessage(action === 'approve' ? '已通过订阅生命周期处理' : '已拒绝');
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '操作失败');
    }
  }

  return (
    <section className="space-y-4">
      <h2 className="text-xl font-semibold">升级申请</h2>
      <p className="text-sm text-zinc-500">批准会生成结账草稿，不会标记已支付，也不会直接改订阅。这里还不是真实付费转化。</p>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {message ? <p className="text-sm">{message}</p> : null}
      <ul className="divide-y rounded-lg border bg-white">
        {rows.length === 0 ? <li className="px-4 py-3 text-sm text-zinc-500">还没有升级申请</li> : null}
        {rows.map((row) => (
          <li key={row.id} className="space-y-2 px-4 py-3 text-sm">
            <p>{row.workspace.name} · {row.requestedBy.name || row.requestedBy.email}</p>
            <p>{row.fromPlan.name} → {row.requestedPlan.name} · {STATUS[row.status] ?? row.status}</p>
            <p className="text-zinc-500">{row.reason}</p>
            {row.status === 'PENDING' ? (
              <div className="flex gap-2">
                <button className="rounded border px-3 py-1" type="button" onClick={() => void act(row.id, 'approve')}>批准</button>
                <button className="rounded border px-3 py-1" type="button" onClick={() => void act(row.id, 'reject')}>拒绝</button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
