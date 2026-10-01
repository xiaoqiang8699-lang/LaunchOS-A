'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AdminUsersWorkspacesTabs } from '@/components/admin/admin-users-workspaces-tabs';
import { PageHeader } from '@/components/ui/section';
import { api } from '@/lib/api';

type Row = {
  id: string;
  displayName: string;
  email: string;
  platformRole: string;
  platformRoleLabel: string;
  createdAt: string;
  lastLoginAt: string | null;
  workspaces: Array<{ id: string; name: string }>;
  applications: number;
  plan: string;
  subscriptionStatus: string;
  accountStatus: string;
  accountStatusLabel: string;
};

type Page = { page: number; pageSize: number; total: number; items: Row[] };

export default function AdminUsersPage() {
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [platformRole, setPlatformRole] = useState('');
  const [accountStatus, setAccountStatus] = useState('');
  const [subscriptionStatus, setSubscriptionStatus] = useState('');
  const [registeredFrom, setRegisteredFrom] = useState('');
  const [registeredTo, setRegisteredTo] = useState('');
  const [sort, setSort] = useState('recent_register');
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: '20', sort });
    if (q.trim()) params.set('q', q.trim());
    if (platformRole) params.set('platformRole', platformRole);
    if (accountStatus) params.set('accountStatus', accountStatus);
    if (subscriptionStatus) params.set('subscriptionStatus', subscriptionStatus);
    if (registeredFrom) params.set('registeredFrom', new Date(registeredFrom).toISOString());
    if (registeredTo) params.set('registeredTo', new Date(`${registeredTo}T23:59:59`).toISOString());
    void api<Page>(`/admin/users?${params.toString()}`)
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '加载失败'));
  }, [q, platformRole, accountStatus, subscriptionStatus, registeredFrom, registeredTo, sort, page, refresh]);

  async function suspend(row: Row): Promise<void> {
    const reason = window.prompt('停用原因', '') ?? '';
    await api(`/admin/users/${row.id}/suspend`, { method: 'POST', body: JSON.stringify({ reason }) });
    setRefresh((current) => current + 1);
  }

  async function restore(row: Row): Promise<void> {
    await api(`/admin/users/${row.id}/restore`, { method: 'POST' });
    setRefresh((current) => current + 1);
  }

  if (error) return <p className="text-sm text-red-600">{error}</p>;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="用户与工作空间" description="全部用户 · 账号、套餐与应用概况" />
      <AdminUsersWorkspacesTabs />
      <div className="grid gap-2 rounded-xl border border-zinc-200 bg-white p-4 sm:grid-cols-3">
        <input className="rounded-lg border border-zinc-200 px-3 py-2 text-sm" placeholder="搜索姓名或邮箱" value={q} onChange={(event) => { setPage(1); setQ(event.target.value); }} />
        <select className="rounded-lg border border-zinc-200 px-3 py-2 text-sm" value={platformRole} onChange={(event) => { setPage(1); setPlatformRole(event.target.value); }}>
          <option value="">全部平台角色</option>
          <option value="USER">普通用户</option>
          <option value="PLATFORM_ADMIN">平台管理员</option>
        </select>
        <select className="rounded-lg border border-zinc-200 px-3 py-2 text-sm" value={accountStatus} onChange={(event) => { setPage(1); setAccountStatus(event.target.value); }}>
          <option value="">全部账号状态</option>
          <option value="ACTIVE">正常</option>
          <option value="SUSPENDED">已停用</option>
          <option value="ARCHIVED">已归档</option>
        </select>
        <select className="rounded-lg border border-zinc-200 px-3 py-2 text-sm" value={subscriptionStatus} onChange={(event) => { setPage(1); setSubscriptionStatus(event.target.value); }}>
          <option value="">全部订阅</option>
          <option value="NONE">未订阅</option>
          <option value="ACTIVE">ACTIVE</option>
          <option value="CANCELED">CANCELED</option>
          <option value="PAST_DUE">PAST_DUE</option>
        </select>
        <input className="rounded-lg border border-zinc-200 px-3 py-2 text-sm" type="date" value={registeredFrom} onChange={(event) => { setPage(1); setRegisteredFrom(event.target.value); }} />
        <input className="rounded-lg border border-zinc-200 px-3 py-2 text-sm" type="date" value={registeredTo} onChange={(event) => { setPage(1); setRegisteredTo(event.target.value); }} />
        <select className="rounded-lg border border-zinc-200 px-3 py-2 text-sm" value={sort} onChange={(event) => { setPage(1); setSort(event.target.value); }}>
          <option value="recent_register">最近注册</option>
          <option value="recent_login">最近登录</option>
          <option value="applications">应用数量</option>
        </select>
      </div>
      {!data ? <p className="text-sm text-zinc-500">加载中…</p> : (
        <>
          <section className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-zinc-200 text-zinc-500">
                <tr>
                  {['用户', '邮箱', '平台注册角色', '注册时间', '最近登录', 'Workspace', '应用数量', '套餐', '账号状态', '操作'].map((head) => (
                    <th key={head} className="px-3 py-2 font-medium">{head}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.items.map((row) => (
                  <tr key={row.id} className="border-t border-zinc-100">
                    <td className="px-3 py-2">{row.displayName}</td>
                    <td className="px-3 py-2">{row.email}</td>
                    <td className="px-3 py-2">{row.platformRoleLabel}</td>
                    <td className="px-3 py-2">{new Date(row.createdAt).toLocaleString()}</td>
                    <td className="px-3 py-2">{row.lastLoginAt ? new Date(row.lastLoginAt).toLocaleString() : '—'}</td>
                    <td className="px-3 py-2">{row.workspaces.map((workspace) => workspace.name).join('、') || '—'}</td>
                    <td className="px-3 py-2">{row.applications}</td>
                    <td className="px-3 py-2">{row.plan}</td>
                    <td className="px-3 py-2">{row.accountStatusLabel}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-2">
                        <Link className="underline" href={`/admin/users/${row.id}`}>查看</Link>
                        <Link className="underline" href={`/admin/users/${row.id}#edit`}>编辑</Link>
                        {row.accountStatus === 'SUSPENDED' ? (
                          <button className="underline" type="button" onClick={() => void restore(row)}>恢复</button>
                        ) : (
                          <button className="underline" type="button" onClick={() => void suspend(row)}>停用</button>
                        )}
                        <Link className="underline" href={`/admin/users/${row.id}#more`}>更多</Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <div className="flex items-center justify-between text-sm text-zinc-600">
            <span>共 {data.total} 人，第 {data.page} 页</span>
            <span className="flex gap-2">
              <button className="rounded-lg border border-zinc-200 px-3 py-1" type="button" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>上一页</button>
              <button className="rounded-lg border border-zinc-200 px-3 py-1" type="button" disabled={page * data.pageSize >= data.total} onClick={() => setPage((current) => current + 1)}>下一页</button>
            </span>
          </div>
        </>
      )}
    </div>
  );
}
