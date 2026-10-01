'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';

type Plan = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  audience: string | null;
  marketingDescription: string | null;
  priceMonthly: number;
  priceYearly: number | null;
  currency: string;
  contactSales: boolean;
  status: string;
  highlighted: boolean;
  displayOrder: number;
  subscriptionCount: number;
  limits: { projects: number | null; members: number | null; deployments: number | null; buildMinutes: number | null };
};

const STATUS_LABEL: Record<string, string> = { DRAFT: '草稿', ACTIVE: '可分配', INACTIVE: '已停用', ARCHIVED: '已停用' };

export default function AdminPlansPage() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Plan | null>(null);
  const [draft, setDraft] = useState({ name: '', code: '', priceMonthly: '0', priceYearly: '', currency: 'CNY', audience: '', description: '', displayOrder: '0', highlighted: false, status: 'ACTIVE', projects: '', members: '' });

  function load() {
    api<Plan[]>('/admin/plans').then(setPlans).catch((reason) => setError(reason instanceof ApiError ? reason.message : '加载失败'));
  }

  useEffect(() => { load(); }, []);

  function edit(plan: Plan) {
    setSelected(plan);
    setDraft({
      name: plan.name,
      code: plan.code,
      priceMonthly: String(plan.priceMonthly),
      priceYearly: plan.priceYearly == null ? '' : String(plan.priceYearly),
      currency: plan.currency,
      audience: plan.audience ?? '',
      description: plan.description ?? '',
      displayOrder: String(plan.displayOrder ?? 0),
      highlighted: plan.highlighted,
      status: plan.status === 'ARCHIVED' ? 'INACTIVE' : plan.status,
      projects: plan.limits.projects == null ? '' : String(plan.limits.projects),
      members: plan.limits.members == null ? '' : String(plan.limits.members),
    });
  }

  async function save() {
    const body = {
      name: draft.name,
      priceMonthly: Number(draft.priceMonthly || 0),
      priceYearly: draft.priceYearly === '' ? null : Number(draft.priceYearly),
      currency: draft.currency,
      audience: draft.audience,
      description: draft.description,
      displayOrder: Number(draft.displayOrder || 0),
      highlighted: draft.highlighted,
      status: draft.status,
      maxProjects: draft.projects === '' ? null : Number(draft.projects),
      maxMembers: draft.members === '' ? null : Number(draft.members),
    };
    if (!selected) {
      await api('/admin/plans', { method: 'POST', body: JSON.stringify({ ...body, code: draft.code, featuresJson: {} }) });
    } else {
      await api(`/admin/plans/${selected.id}`, { method: 'PATCH', body: JSON.stringify(body) });
    }
    setSelected(null);
    load();
  }

  const priceLabel = draft.status === 'ACTIVE' && selected?.contactSales ? '联系销售' : `${draft.priceMonthly || 0} ${draft.currency} / 月`;

  return (
    <section className="space-y-4">
      <h2 className="text-xl font-semibold">套餐</h2>
      <p className="text-sm text-zinc-500">价格和额度可以改。已有订阅继续使用原来的版本，不会因为这里改价而改写历史账单。被引用的套餐只能停用。</p>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <form className="space-y-2 rounded-xl border bg-white p-4 text-sm" onSubmit={(event) => { event.preventDefault(); void save().catch((reason) => setError(reason instanceof ApiError ? reason.message : '保存失败')); }}>
          <div className="grid gap-2 sm:grid-cols-2">
            <input className="h-9 rounded border px-3" placeholder="名称" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            <input className="h-9 rounded border px-3" placeholder="代码" value={draft.code} disabled={Boolean(selected)} onChange={(event) => setDraft({ ...draft, code: event.target.value })} />
            <input className="h-9 rounded border px-3" placeholder="月价" value={draft.priceMonthly} onChange={(event) => setDraft({ ...draft, priceMonthly: event.target.value })} />
            <input className="h-9 rounded border px-3" placeholder="年价，留空表示单独未定" value={draft.priceYearly} onChange={(event) => setDraft({ ...draft, priceYearly: event.target.value })} />
            <input className="h-9 rounded border px-3" placeholder="币种" value={draft.currency} onChange={(event) => setDraft({ ...draft, currency: event.target.value })} />
            <input className="h-9 rounded border px-3" placeholder="排序" value={draft.displayOrder} onChange={(event) => setDraft({ ...draft, displayOrder: event.target.value })} />
            <input className="h-9 rounded border px-3" placeholder="应用数量，空为自定义" value={draft.projects} onChange={(event) => setDraft({ ...draft, projects: event.target.value })} />
            <input className="h-9 rounded border px-3" placeholder="成员数量，空为自定义" value={draft.members} onChange={(event) => setDraft({ ...draft, members: event.target.value })} />
          </div>
          <input className="h-9 w-full rounded border px-3" placeholder="适合谁" value={draft.audience} onChange={(event) => setDraft({ ...draft, audience: event.target.value })} />
          <input className="h-9 w-full rounded border px-3" placeholder="说明" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
          <label className="flex items-center gap-2"><input type="checkbox" checked={draft.highlighted} onChange={(event) => setDraft({ ...draft, highlighted: event.target.checked })} />设为推荐样式</label>
          <select className="h-9 rounded border px-2" value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })}>
            <option value="DRAFT">草稿</option>
            <option value="ACTIVE">可分配</option>
            <option value="INACTIVE">停用</option>
          </select>
          <button className="rounded bg-zinc-900 px-3 py-1.5 text-white" type="submit">{selected ? '保存' : '新增'}</button>
        </form>
        <article className="rounded-xl border bg-white p-4 text-sm">
          <p className="text-xs text-zinc-500">用户视角预览</p>
          {draft.highlighted ? <span className="mt-2 inline-block rounded bg-zinc-100 px-2 py-0.5 text-xs">推荐</span> : null}
          <h3 className="mt-2 text-lg font-semibold">{draft.name || '套餐名称'}</h3>
          <p className="text-zinc-500">{draft.audience || '适合谁'}</p>
          <p className="mt-3 font-medium">{priceLabel}</p>
          {draft.priceYearly ? <p className="text-zinc-500">{draft.priceYearly} {draft.currency} / 年</p> : null}
          <p className="mt-3">{draft.projects === '' ? '应用数量按合同定制' : `最多 ${draft.projects} 个应用`}</p>
          <p>{draft.members === '' ? '成员数量按合同定制' : `最多 ${draft.members} 名成员`}</p>
          <p className="mt-3 text-zinc-500">套餐费用不包含实际云资源费用。</p>
        </article>
      </div>
      <ul className="divide-y rounded-lg border bg-white">
        {plans.map((plan) => (
          <li key={plan.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
            <div>
              <div className="font-medium">{plan.name} · {plan.code} · {STATUS_LABEL[plan.status] ?? plan.status}{plan.contactSales ? ' · 联系销售' : ''}</div>
              <div className="text-zinc-500">{plan.contactSales ? '联系销售' : `${plan.priceMonthly} ${plan.currency}/月`}{plan.priceYearly != null ? ` · 年付 ${plan.priceYearly}` : ''} · 引用 {plan.subscriptionCount}</div>
            </div>
            <div className="flex gap-2">
              <button className="underline" type="button" onClick={() => edit(plan)}>编辑</button>
              {plan.status === 'ACTIVE' ? <button className="underline" type="button" onClick={() => void api(`/admin/plans/${plan.id}/disable`, { method: 'POST' }).then(load)}>停用</button> : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
