'use client';

import { useEffect, useState } from 'react';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { Card, PageHeader, Section } from '@/components/ui/section';
import { StatusBadge } from '@/components/ui/status-badge';
import { api, ApiError } from '@/lib/api';

type Overview = {
  activeRules: number;
  totalRules: number;
  triggerCount: number;
  pendingUsers: number;
  completedActions: number;
};

type Rule = {
  id: string;
  name: string;
  description: string | null;
  triggerEvent: string;
  conditionJson: Record<string, unknown>;
  actionType: string;
  actionConfigJson: Record<string, unknown>;
  status: 'ACTIVE' | 'DISABLED';
  actionCount: number;
  createdAt: string;
  updatedAt: string;
};

export default function AdminAutomationPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [draft, setDraft] = useState({
    name: '',
    description: '',
    triggerEvent: 'SCAN',
    actionType: 'ADD_TAG' as 'ADD_TAG' | 'CREATE_ALERT' | 'SHOW_IN_ADMIN',
    tag: 'HIGH_VALUE',
  });

  async function load() {
    setError('');
    try {
      const [o, r] = await Promise.all([
        api<Overview>('/admin/automation'),
        api<{ items: Rule[] }>('/admin/automation/rules'),
      ]);
      setOverview(o);
      setRules(r.items || []);
    } catch (err: unknown) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : '加载失败');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function toggle(id: string) {
    setMessage('');
    await api(`/admin/automation/rules/${id}/toggle`, { method: 'POST' });
    setMessage('已更新规则状态');
    await load();
  }

  async function scan() {
    setMessage('');
    const result = await api<{ matched?: number; users?: number; replayed?: number }>(
      '/admin/automation/scan',
      { method: 'POST' },
    );
    setMessage(
      `扫描完成：匹配 ${result.matched ?? 0} · 用户 ${result.users ?? 0} · 重放事件 ${result.replayed ?? 0}`,
    );
    await load();
  }

  async function createRule() {
    setMessage('');
    setError('');
    try {
      await api('/admin/automation/rules', {
        method: 'POST',
        body: JSON.stringify({
          name: draft.name.trim(),
          description: draft.description.trim() || undefined,
          triggerEvent: draft.triggerEvent.trim(),
          actionType: draft.actionType,
          conditionJson: { kind: 'ALWAYS' },
          actionConfigJson: { tag: draft.tag, also: ['SHOW_IN_ADMIN'] },
          status: 'ACTIVE',
        }),
      });
      setDraft((prev) => ({ ...prev, name: '', description: '' }));
      setMessage('规则已创建');
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '创建失败');
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="运营自动化"
        description="内部规则引擎：事件 → 规则 → 用户标签 / 运营动作（不发邮件、不发短信、不触发支付）"
      />
      {error ? <InlineAlert tone="error" title={error} /> : null}
      {message ? <InlineAlert tone="success" title={message} /> : null}

      {!overview ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : (
        <Section title="运营概览">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="启用规则" value={`${overview.activeRules}/${overview.totalRules}`} />
            <Metric label="触发次数" value={overview.triggerCount} />
            <Metric label="待处理用户" value={overview.pendingUsers} />
            <Metric label="已完成动作" value={overview.completedActions} />
          </div>
          <button
            type="button"
            className="mt-3 rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm"
            onClick={() => void scan()}
          >
            立即扫描一次
          </button>
        </Section>
      )}

      <Section title="生命周期规则">
        <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-200 bg-zinc-50 text-xs text-zinc-500">
              <tr>
                <th className="px-3 py-2 font-medium">规则</th>
                <th className="px-3 py-2 font-medium">触发事件</th>
                <th className="px-3 py-2 font-medium">动作</th>
                <th className="px-3 py-2 font-medium">状态</th>
                <th className="px-3 py-2 font-medium">触发次数</th>
                <th className="px-3 py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {rules.length === 0 ? (
                <tr>
                  <td className="px-3 py-4 text-zinc-500" colSpan={6}>
                    暂无规则（默认规则会在 API 启动时写入）
                  </td>
                </tr>
              ) : (
                rules.map((rule) => (
                  <tr key={rule.id} className="border-b border-zinc-100 last:border-0">
                    <td className="px-3 py-3">
                      <p className="font-medium text-zinc-900">{rule.name}</p>
                      <p className="text-xs text-zinc-500">{rule.description || '—'}</p>
                    </td>
                    <td className="px-3 py-3 font-mono text-xs">{rule.triggerEvent}</td>
                    <td className="px-3 py-3">{rule.actionType}</td>
                    <td className="px-3 py-3">
                      <StatusBadge
                        status={rule.status}
                        label={rule.status === 'ACTIVE' ? '启用' : '停用'}
                        tone={rule.status === 'ACTIVE' ? 'success' : 'neutral'}
                      />
                    </td>
                    <td className="px-3 py-3 tabular-nums">{rule.actionCount}</td>
                    <td className="px-3 py-3">
                      <button
                        type="button"
                        className="underline"
                        onClick={() => void toggle(rule.id)}
                      >
                        {rule.status === 'ACTIVE' ? '停用' : '启用'}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="新建规则">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm text-zinc-600">
            名称
            <input
              className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2"
              value={draft.name}
              onChange={(e) => setDraft((p) => ({ ...p, name: e.target.value }))}
            />
          </label>
          <label className="text-sm text-zinc-600">
            触发事件
            <input
              className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 font-mono text-sm"
              value={draft.triggerEvent}
              onChange={(e) => setDraft((p) => ({ ...p, triggerEvent: e.target.value }))}
              placeholder="USER_REGISTERED / DEPLOY_FAILED / SCAN"
            />
          </label>
          <label className="text-sm text-zinc-600">
            动作类型
            <select
              className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2"
              value={draft.actionType}
              onChange={(e) =>
                setDraft((p) => ({
                  ...p,
                  actionType: e.target.value as 'ADD_TAG' | 'CREATE_ALERT' | 'SHOW_IN_ADMIN',
                }))
              }
            >
              <option value="ADD_TAG">ADD_TAG</option>
              <option value="CREATE_ALERT">CREATE_ALERT</option>
              <option value="SHOW_IN_ADMIN">SHOW_IN_ADMIN</option>
            </select>
          </label>
          <label className="text-sm text-zinc-600">
            标签
            <select
              className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2"
              value={draft.tag}
              onChange={(e) => setDraft((p) => ({ ...p, tag: e.target.value }))}
            >
              <option value="NEEDS_ONBOARDING">NEEDS_ONBOARDING</option>
              <option value="DEPLOY_BLOCKED">DEPLOY_BLOCKED</option>
              <option value="UPGRADE_POTENTIAL">UPGRADE_POTENTIAL</option>
              <option value="DORMANT">DORMANT</option>
              <option value="HIGH_VALUE">HIGH_VALUE</option>
            </select>
          </label>
          <label className="sm:col-span-2 text-sm text-zinc-600">
            描述
            <textarea
              className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2"
              value={draft.description}
              onChange={(e) => setDraft((p) => ({ ...p, description: e.target.value }))}
            />
          </label>
        </div>
        <button
          type="button"
          className="mt-3 rounded-lg bg-zinc-900 px-3 py-1.5 text-sm text-white disabled:opacity-40"
          disabled={!draft.name.trim() || !draft.triggerEvent.trim()}
          onClick={() => void createRule()}
        >
          创建规则
        </button>
      </Section>
    </div>
  );
}

function Metric(props: { label: string; value: string | number }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-zinc-500">{props.label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900">{props.value}</p>
    </Card>
  );
}
