'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';

type Detail = {
  profile: {
    id: string;
    name: string;
    status: string;
    statusLabel: string;
    adminNote: string | null;
    createdAt: string;
    updatedAt: string;
    lastActiveAt: string | null;
    owner: string;
    ownerId: string;
    memberCount: number;
    projectCount: number;
  };
  members: Array<{ userId: string; name: string; email: string; role: string; roleLabel: string; joinedAt: string; accountStatus: string }>;
  applications: Array<{ id: string; name: string; type: string; status: string; publicUrl: string | null; healthStatus: string; lastLaunchAt: string | null; launchRun: { id: string; status: string } | null }>;
  subscription: { plan: string; status: string; startedAt: string | null; currentPeriodStart: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; overrideSource: string | null } | null;
  invoices: Array<{ id: string; periodStart: string; periodEnd: string; amount: number; currency: string; status: string; createdAt: string }>;
  usage: { projectCount: number; memberCount: number; deploymentCount: number; buildCount: number; activeServiceCount: number; serverCount: number; databaseCount: number; redisCount: number; bandwidthBytes: number | null; storageBytes: number | null; estimated: true };
  quota: { status: string; hint: string | null };
  cloudResources: Array<{ id: string; type: string; status: string; region: string | null }>;
  audit: Array<{ id: string; action: string; createdAt: string }>;
};

function unknown(value: number | null) {
  return value === null ? '暂未统计' : String(value);
}

export default function AdminWorkspaceDetailPage() {
  const params = useParams<{ id: string }>();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [transferUserId, setTransferUserId] = useState('');
  const [planCode, setPlanCode] = useState('alpha');

  function load() {
    api<Detail>(`/admin/workspaces/${params.id}`)
      .then((data) => {
        setDetail(data);
        setName(data.profile.name);
        setNote(data.profile.adminNote ?? '');
      })
      .catch((reason) => setMessage(reason instanceof ApiError ? reason.message : '加载失败'));
  }

  useEffect(() => { load(); }, [params.id]);

  async function save() {
    await api(`/admin/workspaces/${params.id}`, { method: 'PATCH', body: JSON.stringify({ name, adminNote: note }) });
    setMessage('已保存');
    load();
  }

  async function setStatus(status: string) {
    await api(`/admin/workspaces/${params.id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
    load();
  }

  if (!detail) return <p className="text-sm text-muted-foreground">{message || '加载中…'}</p>;
  const profile = detail.profile;
  const mutable = profile.status === 'ACTIVE';

  return (
    <div className="space-y-6">
      <div>
        <Link className="text-sm text-muted-foreground underline" href="/admin/workspaces">返回列表</Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold">{profile.name}</h1>
            <p className="text-sm text-muted-foreground">{profile.statusLabel} · {profile.id}</p>
          </div>
          <Link
            className="rounded-md border px-3 py-1.5 text-sm"
            href={`/admin/apps?q=${encodeURIComponent(profile.name)}`}
          >
            打开该 Workspace 的运营详情（只读）
          </Link>
        </div>
      </div>
      {profile.status === 'SUSPENDED' ? <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm">已暂停新的操作，现有线上服务保持运行。</p> : null}
      {message ? <p className="text-sm">{message}</p> : null}

      <section className="rounded-lg border p-4">
        <h2 className="font-medium">基本信息</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-sm">名称<input className="mt-1 h-9 w-full rounded-md border px-2" value={name} onChange={(event) => setName(event.target.value)} /></label>
          <p className="text-sm">状态：{profile.statusLabel}</p>
          <p className="text-sm">创建：{new Date(profile.createdAt).toLocaleString()}</p>
          <p className="text-sm">更新：{new Date(profile.updatedAt).toLocaleString()}</p>
          <p className="text-sm">成员 {profile.memberCount} · 应用 {profile.projectCount}</p>
          <p className="text-sm">最近活跃：{profile.lastActiveAt ? new Date(profile.lastActiveAt).toLocaleString() : '—'}</p>
        </div>
        <label className="mt-3 block text-sm">内部备注<textarea className="mt-1 w-full rounded-md border px-2 py-1" rows={3} value={note} onChange={(event) => setNote(event.target.value)} /></label>
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="rounded-md bg-foreground px-3 py-1.5 text-sm text-background" onClick={() => void save()} type="button">保存</button>
          {profile.status === 'ACTIVE' ? <button className="rounded-md border px-3 py-1.5 text-sm" onClick={() => void setStatus('SUSPENDED')} type="button">暂停</button> : null}
          {profile.status === 'SUSPENDED' ? <button className="rounded-md border px-3 py-1.5 text-sm" onClick={() => void setStatus('ACTIVE')} type="button">恢复</button> : null}
          {profile.status !== 'ARCHIVED' ? <button className="rounded-md border px-3 py-1.5 text-sm" onClick={() => void setStatus('ARCHIVED')} type="button">归档</button> : null}
        </div>
      </section>

      <section className="rounded-lg border p-4">
        <h2 className="font-medium">Owner</h2>
        <p className="mt-2 text-sm">{profile.owner}</p>
        {mutable ? <div className="mt-3 flex gap-2">
          <select className="h-9 rounded-md border px-2 text-sm" value={transferUserId} onChange={(event) => setTransferUserId(event.target.value)}>
            <option value="">选择已有成员</option>
            {detail.members.filter((member) => member.role !== 'OWNER').map((member) => <option key={member.userId} value={member.userId}>{member.email}</option>)}
          </select>
          <button className="rounded-md border px-3 text-sm" disabled={!transferUserId} onClick={() => void api(`/admin/workspaces/${params.id}/transfer-owner`, { method: 'POST', body: JSON.stringify({ userId: transferUserId }) }).then(load)} type="button">转移所有权</button>
        </div> : <p className="mt-2 text-sm text-muted-foreground">当前状态不能转移所有权。</p>}
      </section>

      <section className="rounded-lg border p-4">
        <h2 className="font-medium">成员</h2>
        {mutable ? <div className="mt-3 flex gap-2">
          <input className="h-9 rounded-md border px-2 text-sm" placeholder="邀请邮箱" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} />
          <button className="rounded-md border px-3 text-sm" onClick={() => void api(`/admin/workspaces/${params.id}/members`, { method: 'POST', body: JSON.stringify({ email: inviteEmail, role: 'MEMBER' }) }).then(() => { setInviteEmail(''); load(); })} type="button">邀请</button>
        </div> : <p className="mt-2 text-sm text-muted-foreground">当前状态不能变更成员。</p>}
        <ul className="mt-3 space-y-2 text-sm">
          {detail.members.map((member) => (
            <li key={member.userId} className="flex flex-wrap items-center justify-between gap-2 border-t pt-2">
              <span>{member.name} · {member.email} · {member.roleLabel} · {member.accountStatus}</span>
              {mutable && member.role !== 'OWNER' ? (
                <span className="flex gap-2">
                  <button className="underline" onClick={() => void api(`/admin/workspaces/${params.id}/members/${member.userId}`, { method: 'PATCH', body: JSON.stringify({ role: 'ADMIN' }) }).then(load)} type="button">设为管理员</button>
                  <button className="underline" onClick={() => void api(`/admin/workspaces/${params.id}/members/${member.userId}/remove`, { method: 'POST' }).then(load)} type="button">移除</button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-lg border p-4">
        <h2 className="font-medium">应用</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {detail.applications.map((app) => (
            <li key={app.id} className="border-t pt-2">
              <Link className="underline" href={`/admin/apps/${app.id}`}>{app.name}</Link>
              <span className="text-muted-foreground"> · {app.type} · {app.status} · {app.healthStatus}</span>
              <div className="text-xs text-muted-foreground">{app.publicUrl ?? '无公网地址'} · {app.lastLaunchAt ? new Date(app.lastLaunchAt).toLocaleString() : '未上线'} · {app.launchRun?.status ?? '无 LaunchRun'}</div>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-lg border p-4">
        <h2 className="font-medium">订阅与账单</h2>
        {detail.subscription ? (
          <div className="mt-2 space-y-1 text-sm">
            <p>
              {detail.subscription.plan} · {detail.subscription.status}
              {detail.subscription.overrideSource ? ` · ${detail.subscription.overrideSource}` : ''}
            </p>
            {detail.subscription.overrideSource ? (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-amber-900">
                内部 Override / Beta 测试额度（运营可见，普通用户不可见）
              </p>
            ) : null}
          </div>
        ) : <p className="mt-2 text-sm">未订阅</p>}
        {mutable ? <div className="mt-3 flex gap-2">
          <input className="h-9 rounded-md border px-2 text-sm" value={planCode} onChange={(event) => setPlanCode(event.target.value)} />
          <button className="rounded-md border px-3 text-sm" onClick={() => void api(`/admin/workspaces/${params.id}/plan`, { method: 'POST', body: JSON.stringify({ planCode }) }).then(load)} type="button">手工切换套餐</button>
        </div> : null}
        <table className="mt-3 w-full text-left text-sm">
          <thead><tr><th>账期</th><th>金额</th><th>币种</th><th>状态</th></tr></thead>
          <tbody>
            {detail.invoices.map((invoice) => (
              <tr key={invoice.id} className="border-t">
                <td>{new Date(invoice.periodStart).toLocaleDateString()}</td>
                <td>{invoice.amount}</td>
                <td>{invoice.currency}</td>
                <td>{invoice.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="rounded-lg border p-4">
        <h2 className="font-medium">用量 {detail.quota.status === 'OVER_LIMIT' ? '· 超出建议范围' : ''}</h2>
        <p className="mt-2 text-sm">应用 {detail.usage.projectCount} · 成员 {detail.usage.memberCount} · 本月部署 {detail.usage.deploymentCount} · 本月构建 {detail.usage.buildCount}</p>
        <p className="text-sm">活跃服务 {detail.usage.activeServiceCount} · 服务器 {detail.usage.serverCount} · 数据库 {detail.usage.databaseCount} · Redis {detail.usage.redisCount}</p>
        <p className="text-sm text-muted-foreground">带宽 {unknown(detail.usage.bandwidthBytes)} · 存储 {unknown(detail.usage.storageBytes)} · 估算用量，非正式账单</p>
      </section>

      <section className="rounded-lg border p-4">
        <h2 className="font-medium">云资源</h2>
        <p className="mt-2 text-sm">资源 {detail.cloudResources.length} · 服务器 {detail.usage.serverCount} · 数据库 {detail.usage.databaseCount} · Redis {detail.usage.redisCount}</p>
      </section>

      <section className="rounded-lg border p-4">
        <h2 className="font-medium">审计</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {detail.audit.map((row) => <li key={row.id}>{row.action} · {new Date(row.createdAt).toLocaleString()}</li>)}
        </ul>
      </section>
    </div>
  );
}
