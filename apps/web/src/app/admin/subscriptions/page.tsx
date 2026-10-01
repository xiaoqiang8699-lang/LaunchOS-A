'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';

type Item = {
  id: string;
  workspace: string;
  owner: string;
  plan: string;
  statusLabel: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  usage: { projects: number; members: number; deployments: number };
  overallStatus: string;
  createdAt: string;
};

export default function AdminSubscriptionsPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [planCode, setPlanCode] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: '20' });
    if (q.trim()) params.set('q', q.trim());
    if (status) params.set('status', status);
    if (planCode.trim()) params.set('planCode', planCode.trim());
    api<{ items: Item[]; total: number }>(`/admin/subscriptions?${params}`)
      .then((data) => { setItems(data.items); setTotal(data.total); })
      .catch((reason) => setError(reason instanceof ApiError ? reason.message : '加载失败'));
  }, [page, q, status, planCode]);

  return (
    <section className="space-y-4">
      <h2 className="text-xl font-semibold">订阅</h2>
      <div className="flex flex-wrap gap-2">
        <input className="h-9 rounded-md border px-3 text-sm" placeholder="工作空间或 Owner" value={q} onChange={(event) => { setPage(1); setQ(event.target.value); }} />
        <input className="h-9 rounded-md border px-3 text-sm" placeholder="套餐代码" value={planCode} onChange={(event) => { setPage(1); setPlanCode(event.target.value); }} />
        <select className="h-9 rounded-md border px-2 text-sm" value={status} onChange={(event) => { setPage(1); setStatus(event.target.value); }}>
          <option value="">全部状态</option>
          <option value="ACTIVE">正常</option>
          <option value="TRIALING">试用中</option>
          <option value="PAST_DUE">待处理</option>
          <option value="CANCEL_AT_PERIOD_END">到期取消</option>
          <option value="CANCELED">已取消</option>
          <option value="EXPIRED">已过期</option>
        </select>
      </div>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <div className="overflow-x-auto rounded-lg border bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-50 text-zinc-500">
            <tr>
              <th className="px-3 py-2">工作空间</th>
              <th className="px-3 py-2">Owner</th>
              <th className="px-3 py-2">套餐</th>
              <th className="px-3 py-2">状态</th>
              <th className="px-3 py-2">账期</th>
              <th className="px-3 py-2">用量</th>
              <th className="px-3 py-2">额度</th>
              <th className="px-3 py-2">创建</th>
            </tr>
          </thead>
          <tbody>
            {items.map((row) => (
              <tr key={row.id} className="border-t">
                <td className="px-3 py-2"><Link className="underline" href={`/admin/subscriptions/${row.id}`}>{row.workspace}</Link></td>
                <td className="px-3 py-2">{row.owner}</td>
                <td className="px-3 py-2">{row.plan}</td>
                <td className="px-3 py-2">{row.statusLabel}</td>
                <td className="px-3 py-2">{new Date(row.currentPeriodStart).toLocaleDateString()} → {new Date(row.currentPeriodEnd).toLocaleDateString()}</td>
                <td className="px-3 py-2">{row.usage.projects} 应用 / {row.usage.members} 成员 / {row.usage.deployments} 部署</td>
                <td className="px-3 py-2">{row.overallStatus === 'OVER_LIMIT' ? '超出建议' : row.overallStatus === 'NEAR_LIMIT' ? '接近上限' : '正常'}</td>
                <td className="px-3 py-2">{new Date(row.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex justify-between text-sm">
        <span>共 {total} 条</span>
        <div className="flex gap-2">
          <button className="rounded border px-3 py-1 disabled:opacity-40" disabled={page <= 1} type="button" onClick={() => setPage((value) => value - 1)}>上一页</button>
          <button className="rounded border px-3 py-1 disabled:opacity-40" disabled={page * 20 >= total} type="button" onClick={() => setPage((value) => value + 1)}>下一页</button>
        </div>
      </div>
    </section>
  );
}
