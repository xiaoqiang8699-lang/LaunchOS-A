'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AdminUsersWorkspacesTabs } from '@/components/admin/admin-users-workspaces-tabs';
import { PageHeader } from '@/components/ui/section';
import { api, ApiError } from '@/lib/api';

type Item = {
  id: string;
  name: string;
  status: string;
  statusLabel: string;
  owner: string;
  members: number;
  applications: number;
  plan: string | null;
  subscriptionStatus: string | null;
  createdAt: string;
  lastActiveAt: string | null;
};

const STATUS = [
  ['', '全部状态'],
  ['ACTIVE', '正常'],
  ['SUSPENDED', '已暂停'],
  ['ARCHIVED', '已归档'],
];

export default function AdminWorkspacesPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [plan, setPlan] = useState('');
  const [subscriptionStatus, setSubscriptionStatus] = useState('');
  const [createdFrom, setCreatedFrom] = useState('');
  const [sort, setSort] = useState('recent_created');
  const [error, setError] = useState('');

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: '20', sort });
    if (q.trim()) params.set('q', q.trim());
    if (status) params.set('status', status);
    if (plan.trim()) params.set('planCode', plan.trim());
    if (subscriptionStatus.trim()) params.set('subscriptionStatus', subscriptionStatus.trim());
    if (createdFrom) params.set('registeredFrom', new Date(createdFrom).toISOString());
    api<{ items: Item[]; total: number }>(`/admin/workspaces?${params}`)
      .then((data) => {
        setItems(data.items);
        setTotal(data.total);
      })
      .catch((reason) => setError(reason instanceof ApiError ? reason.message : '加载失败'));
  }, [page, q, status, plan, subscriptionStatus, createdFrom, sort]);

  return (
    <section className="space-y-4">
      <PageHeader title="用户与工作空间" description="全部 Workspace · 租户、套餐与用量" />
      <AdminUsersWorkspacesTabs />
      <div className="flex flex-wrap gap-2">
        <input className="h-9 rounded-md border px-3 text-sm" placeholder="名称、Owner 姓名或邮箱" value={q} onChange={(event) => { setPage(1); setQ(event.target.value); }} />
        <select className="h-9 rounded-md border px-2 text-sm" value={status} onChange={(event) => { setPage(1); setStatus(event.target.value); }}>
          {STATUS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <input className="h-9 rounded-md border px-3 text-sm" placeholder="套餐代码" value={plan} onChange={(event) => { setPage(1); setPlan(event.target.value); }} />
        <input className="h-9 rounded-md border px-3 text-sm" placeholder="订阅状态" value={subscriptionStatus} onChange={(event) => { setPage(1); setSubscriptionStatus(event.target.value); }} />
        <input className="h-9 rounded-md border px-2 text-sm" type="date" value={createdFrom} onChange={(event) => { setPage(1); setCreatedFrom(event.target.value); }} />
        <select className="h-9 rounded-md border px-2 text-sm" value={sort} onChange={(event) => setSort(event.target.value)}>
          <option value="recent_created">最近创建</option>
          <option value="recent_active">最近活跃</option>
          <option value="members">成员数量</option>
          <option value="applications">应用数量</option>
        </select>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/40 text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">工作空间</th>
              <th className="px-3 py-2 font-medium">Owner</th>
              <th className="px-3 py-2 font-medium">成员</th>
              <th className="px-3 py-2 font-medium">应用</th>
              <th className="px-3 py-2 font-medium">套餐</th>
              <th className="px-3 py-2 font-medium">订阅</th>
              <th className="px-3 py-2 font-medium">状态</th>
              <th className="px-3 py-2 font-medium">创建</th>
              <th className="px-3 py-2 font-medium">最近活跃</th>
              <th className="px-3 py-2 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((row) => (
              <tr key={row.id} className="border-t">
                <td className="px-3 py-2">{row.name}</td>
                <td className="px-3 py-2">{row.owner}</td>
                <td className="px-3 py-2">{row.members}</td>
                <td className="px-3 py-2">{row.applications}</td>
                <td className="px-3 py-2">{row.plan ?? '未订阅'}</td>
                <td className="px-3 py-2">{row.subscriptionStatus ?? '—'}</td>
                <td className="px-3 py-2">{row.statusLabel}</td>
                <td className="px-3 py-2">{new Date(row.createdAt).toLocaleDateString()}</td>
                <td className="px-3 py-2">{row.lastActiveAt ? new Date(row.lastActiveAt).toLocaleString() : '—'}</td>
                <td className="px-3 py-2"><Link className="underline" href={`/admin/workspaces/${row.id}`}>查看</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between text-sm">
        <span>共 {total} 个</span>
        <div className="flex gap-2">
          <button className="rounded-md border px-3 py-1 disabled:opacity-40" disabled={page <= 1} onClick={() => setPage((value) => value - 1)} type="button">上一页</button>
          <button className="rounded-md border px-3 py-1 disabled:opacity-40" disabled={page * 20 >= total} onClick={() => setPage((value) => value + 1)} type="button">下一页</button>
        </div>
      </div>
    </section>
  );
}
