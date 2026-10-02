'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';

type Detail = {
  id: string;
  workspace: { id: string; name: string; status: string; timezone: string };
  owner: { name: string | null; email: string };
  currentPlan: { code: string; name: string };
  pendingPlan: { code: string; name: string; effectiveAt: string | null } | null;
  statusLabel: string;
  source: string;
  sourceLabel: string;
  isRevenueGenerating: boolean;
  trialEndsAt: string | null;
  complimentaryUntil: string | null;
  complimentaryReason: string | null;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  manualAutoExtension: boolean;
  overallStatus: string;
  usage: { projectCount: number; memberCount: number; deploymentCount: number };
  quota: Record<string, { limit: number | null; used: number | null }>;
  events: Array<{ id: string; eventType: string; createdAt: string; source: string }>;
  invoices: Array<{ id: string; status: string; amount: number; source: string | null }>;
};

export default function AdminSubscriptionDetailPage() {
  const params = useParams<{ id: string }>();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [reason, setReason] = useState('');
  const [planCode, setPlanCode] = useState('pro');
  const [days, setDays] = useState('14');
  const [confirmation, setConfirmation] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  function load() {
    api<Detail>(`/admin/subscriptions/${params.id}`)
      .then(setDetail)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : '加载失败'));
  }

  useEffect(() => { load(); }, [params.id]);

  async function run(path: string, body: Record<string, unknown>) {
    setError('');
    setMessage('');
    try {
      const result = await api<{ warning?: string | null; ok?: boolean }>(`/admin/subscriptions/${params.id}/${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setMessage(result.warning || '已记录');
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '操作失败');
    }
  }

  if (!detail) return <p className="text-sm text-zinc-500">{error || '加载中…'}</p>;

  return (
    <section className="space-y-6">
      <Link className="text-sm text-zinc-500 underline" href="/admin/subscriptions">返回订阅列表</Link>
      <div className="rounded-xl border bg-white p-5 text-sm">
        <h2 className="text-xl font-semibold">{detail.workspace.name}</h2>
        <p>Owner：{detail.owner.name || detail.owner.email}</p>
        <p>当前套餐：{detail.currentPlan.name}（{detail.currentPlan.code}）</p>
        <p>待生效套餐：{detail.pendingPlan ? `${detail.pendingPlan.name}，${detail.pendingPlan.effectiveAt ? new Date(detail.pendingPlan.effectiveAt).toLocaleString() : ''}` : '无'}</p>
        <p>状态：{detail.statusLabel}</p>
        <p>来源：{detail.sourceLabel}（{detail.source}）</p>
        <p>计入收入：{detail.isRevenueGenerating ? '是' : '否'}</p>
        <p>试用截止：{detail.trialEndsAt ? new Date(detail.trialEndsAt).toLocaleString() : '无'}</p>
        <p>赠送到期：{detail.complimentaryUntil ? new Date(detail.complimentaryUntil).toLocaleString() : '无'}</p>
        <p>账期：{new Date(detail.currentPeriodStart).toLocaleString()} → {new Date(detail.currentPeriodEnd).toLocaleString()}</p>
        <p>工作空间时区：{detail.workspace.timezone} · 工作空间状态：{detail.workspace.status}</p>
        <p>用量：{detail.usage.projectCount} 应用 / {detail.usage.memberCount} 成员 / {detail.usage.deploymentCount} 部署 · {detail.overallStatus}</p>
        <p>手动续期：{detail.manualAutoExtension ? '开启' : '关闭'}</p>
      </div>
      <div className="rounded-xl border bg-white p-5 text-sm">
        <h3 className="font-medium">管理员操作</h3>
        <p className="mt-1 text-zinc-500">所有操作都要填写原因。立即取消必须再输入“立即取消”。</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <input className="h-9 rounded border px-3" placeholder="原因" value={reason} onChange={(event) => setReason(event.target.value)} />
          <input className="h-9 w-24 rounded border px-3" placeholder="套餐" value={planCode} onChange={(event) => setPlanCode(event.target.value)} />
          <input className="h-9 w-20 rounded border px-3" placeholder="天数" value={days} onChange={(event) => setDays(event.target.value)} />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="rounded border px-3 py-1.5" type="button" onClick={() => void run('activate', { planCode, reason })}>开通</button>
          <button className="rounded border px-3 py-1.5" type="button" onClick={() => void run('change-plan', { planCode, reason })}>更换套餐</button>
          <button className="rounded border px-3 py-1.5" type="button" onClick={() => void run('trial', { planCode, days: Number(days), reason })}>赠送试用</button>
          <button className="rounded border px-3 py-1.5" type="button" onClick={() => void run('complimentary', { planCode, days: Number(days), reason })}>赠送访问</button>
          <button className="rounded border px-3 py-1.5" type="button" onClick={() => void run('extend', { days: Number(days), reason })}>延长账期</button>
          <button className="rounded border px-3 py-1.5" type="button" onClick={() => void run('schedule-cancel', { reason })}>到期取消</button>
          <button className="rounded border px-3 py-1.5" type="button" onClick={() => void run('resume', { reason })}>恢复</button>
          <button
            className="rounded border px-3 py-1.5"
            type="button"
            onClick={() => {
              void api(`/admin/subscriptions/${params.id}/reconcile`, { method: 'POST', body: '{}' })
                .then((result) => {
                  setMessage(`已对账 · findings=${Array.isArray((result as { findings?: unknown[] }).findings) ? (result as { findings: unknown[] }).findings.length : 0}`);
                  load();
                })
                .catch((err: unknown) => setError(err instanceof ApiError ? err.message : '对账失败'));
            }}
          >
            生命周期对账
          </button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input className="h-9 rounded border px-3" placeholder="输入立即取消" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
          <button className="rounded border border-red-300 px-3 py-1.5 text-red-700" type="button" onClick={() => void run('cancel-now', { confirmation, reason })}>立即取消</button>
        </div>
        {message ? <p className="mt-3">{message}</p> : null}
        {error ? <p className="mt-3 text-red-600">{error}</p> : null}
      </div>
      <div className="rounded-xl border bg-white p-5 text-sm">
        <h3 className="font-medium">事件</h3>
        <ul className="mt-2 space-y-1">
          {detail.events.length === 0 ? <li className="text-zinc-500">还没有订阅事件</li> : null}
          {detail.events.map((event) => <li key={event.id}>{event.eventType} · {event.source} · {new Date(event.createdAt).toLocaleString()}</li>)}
        </ul>
      </div>
      <div className="rounded-xl border bg-white p-5 text-sm">
        <h3 className="font-medium">账单</h3>
        <ul className="mt-2 space-y-1">
          {detail.invoices.length === 0 ? <li className="text-zinc-500">没有应付账单</li> : null}
          {detail.invoices.map((invoice) => <li key={invoice.id}>{invoice.status} · {invoice.amount} · {invoice.source ?? '未标记'}</li>)}
        </ul>
      </div>
    </section>
  );
}
