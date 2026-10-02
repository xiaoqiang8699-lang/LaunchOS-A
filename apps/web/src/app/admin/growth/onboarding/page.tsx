'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AdminGrowthTabs } from '@/components/admin/admin-growth-tabs';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { Card, PageHeader, Section } from '@/components/ui/section';
import { api } from '@/lib/api';

type Overview = {
  metrics: {
    registeredUsers: number;
    activatedUsers: number;
    activationRate: number;
    firstDeploymentSuccessRate: number;
    blockedUsers: number;
    atRiskUsers: number;
    medianTimeToFirstDeploymentMinutes: number | null;
    medianTimeToFirstPublicSuccessMinutes: number | null;
    sampleNote: string | null;
    publicSuccessUsers: number;
    firstDeployStartedUsers: number;
    firstDeploySucceededUsers: number;
  };
  m7Comparison?: {
    m7FirstDeploymentSuccessRate: number | null;
    m7AllDeploymentSuccessRate: number | null;
    m8FirstDeploymentSuccessRate: number;
    note: string;
  };
  funnel: Array<{
    stage: string;
    label: string;
    count: number;
    conversion: number;
    drop: number;
    dropRate: number;
  }>;
  dropoff: { stage: string; label: string; drop: number; dropRate: number; message: string } | null;
  blockerCategories: Array<{ category: string; label: string; count: number }>;
  recommendations: Array<{
    id: string;
    title: string;
    description: string;
    priority: string;
    affectedUsers: number;
    estimatedImpact: string;
    category: string;
  }>;
  summary: string;
  note?: string;
};

type BlockedPayload = {
  total: number;
  items: Array<{
    userId: string;
    email: string;
    name: string;
    stageLabel: string;
    statusLabel: string;
    primaryBlocker: string | null;
    activationScore: number;
    stuckHours: number | null;
    lastProgressAt: string | null;
  }>;
};

function pct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

export default function AdminOnboardingPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [blocked, setBlocked] = useState<BlockedPayload | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  async function load() {
    try {
      const [overview, blockedUsers] = await Promise.all([
        api<Overview>('/admin/onboarding/overview'),
        api<BlockedPayload>('/admin/onboarding/blocked-users?pageSize=30'),
      ]);
      setData(overview);
      setBlocked(blockedUsers);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '加载失败');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function backfill() {
    setMsg('');
    try {
      const r = await api<{ processed: number; activated: number; blocked: number }>(
        '/admin/onboarding/backfill',
        { method: 'POST' },
      );
      setMsg(`Backfill 完成：处理 ${r.processed}，已激活 ${r.activated}，阻塞 ${r.blocked}`);
      await load();
    } catch (err: unknown) {
      setMsg(err instanceof Error ? err.message : 'Backfill 失败');
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="用户激活"
        description="首次公网上线价值路径分析（FIRST_PUBLIC_DEPLOYMENT_SUCCESS）"
        action={
          <button
            type="button"
            className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm text-white"
            onClick={() => void backfill()}
          >
            运行 Backfill
          </button>
        }
      />
      <AdminGrowthTabs />
      {error ? <InlineAlert tone="error" title={error} /> : null}
      {msg ? <InlineAlert tone="info" title={msg} /> : null}
      {data?.note ? <InlineAlert tone="info" title={data.note} /> : null}

      {!data ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <Section title="激活概览">
            <Card className="mb-4 p-5">
              <pre className="whitespace-pre-wrap font-sans text-sm leading-6 text-zinc-800">
                {data.summary}
              </pre>
            </Card>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {[
                ['注册用户', data.metrics.registeredUsers],
                ['已激活', data.metrics.activatedUsers],
                ['激活率', pct(data.metrics.activationRate)],
                ['首次部署成功率', pct(data.metrics.firstDeploymentSuccessRate)],
                ['阻塞用户', data.metrics.blockedUsers],
                [
                  '中位激活时长',
                  data.metrics.medianTimeToFirstPublicSuccessMinutes != null
                    ? `${data.metrics.medianTimeToFirstPublicSuccessMinutes} 分钟`
                    : '样本不足',
                ],
              ].map(([label, value]) => (
                <Card key={String(label)} className="p-4">
                  <p className="text-xs text-zinc-500">{label}</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
                </Card>
              ))}
            </div>
            {data.m7Comparison ? (
              <p className="mt-3 text-xs text-zinc-500">
                M7-7 首次/全部部署成功率：
                {data.m7Comparison.m7FirstDeploymentSuccessRate != null
                  ? pct(data.m7Comparison.m7FirstDeploymentSuccessRate)
                  : '—'}{' '}
                /{' '}
                {data.m7Comparison.m7AllDeploymentSuccessRate != null
                  ? pct(data.m7Comparison.m7AllDeploymentSuccessRate)
                  : '—'}
                。{data.m7Comparison.note}
              </p>
            ) : null}
            {data.metrics.sampleNote ? (
              <p className="mt-1 text-xs text-amber-700">{data.metrics.sampleNote}</p>
            ) : null}
          </Section>

          <Section title="激活漏斗">
            <Card className="divide-y divide-zinc-100">
              {data.funnel.map((row, i) => (
                <div key={row.stage} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-zinc-900">
                      {i + 1}. {row.label}
                      <span className="ml-2 text-xs font-normal text-zinc-400">{row.stage}</span>
                    </p>
                    <p className="text-xs text-zinc-500">
                      转化 {pct(row.conversion)} · 流失 {row.drop}（{pct(row.dropRate)}）
                    </p>
                  </div>
                  <p className="text-lg font-semibold tabular-nums">{row.count}</p>
                </div>
              ))}
            </Card>
            {data.dropoff ? (
              <InlineAlert tone="warning" title={data.dropoff.message} className="mt-3" />
            ) : null}
          </Section>

          <Section title="流失与阻塞原因">
            <div className="grid gap-3 lg:grid-cols-2">
              <Card className="divide-y divide-zinc-100">
                {(data.blockerCategories.length ? data.blockerCategories : [{ label: '暂无', count: 0 }]).map(
                  (b) => (
                    <div key={b.label} className="flex justify-between px-4 py-3 text-sm">
                      <span>{b.label}</span>
                      <span className="font-medium tabular-nums">{b.count}</span>
                    </div>
                  ),
                )}
              </Card>
              <Card className="space-y-3 p-4">
                {data.recommendations.map((r) => (
                  <div key={r.id}>
                    <div className="flex flex-wrap gap-2">
                      <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs">{r.priority}</span>
                      <span className="rounded border border-zinc-200 px-2 py-0.5 text-xs">{r.category}</span>
                    </div>
                    <p className="mt-1 text-sm font-medium">{r.title}</p>
                    <p className="text-sm text-zinc-600">{r.description}</p>
                    <p className="mt-1 text-xs text-emerald-700">
                      影响约 {r.affectedUsers} 人 · {r.estimatedImpact}
                    </p>
                  </div>
                ))}
              </Card>
            </div>
          </Section>

          <Section title="未激活 / 阻塞用户">
            <Card className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="border-b border-zinc-200 text-xs text-zinc-500">
                  <tr>
                    <th className="px-3 py-2">用户</th>
                    <th className="px-3 py-2">阶段</th>
                    <th className="px-3 py-2">状态</th>
                    <th className="px-3 py-2">阻塞</th>
                    <th className="px-3 py-2">分数</th>
                    <th className="px-3 py-2">停留</th>
                  </tr>
                </thead>
                <tbody>
                  {(blocked?.items || []).map((u) => (
                    <tr key={u.userId} className="border-b border-zinc-100">
                      <td className="px-3 py-2">
                        <Link className="underline" href={`/admin/users/${u.userId}`}>
                          {u.name || u.email}
                        </Link>
                        <p className="text-xs text-zinc-400">{u.email}</p>
                      </td>
                      <td className="px-3 py-2">{u.stageLabel}</td>
                      <td className="px-3 py-2">{u.statusLabel}</td>
                      <td className="px-3 py-2">{u.primaryBlocker || '—'}</td>
                      <td className="px-3 py-2 tabular-nums">{u.activationScore}</td>
                      <td className="px-3 py-2 tabular-nums">
                        {u.stuckHours != null ? `${u.stuckHours}h` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!blocked?.items?.length ? (
                <p className="p-4 text-sm text-zinc-500">暂无阻塞用户</p>
              ) : null}
            </Card>
          </Section>
        </>
      )}
    </div>
  );
}
