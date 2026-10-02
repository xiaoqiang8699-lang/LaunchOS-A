'use client';

import { useEffect, useState } from 'react';
import { AdminGrowthTabs } from '@/components/admin/admin-growth-tabs';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { Card, PageHeader, Section } from '@/components/ui/section';
import { api } from '@/lib/api';

type Overview = {
  users: number;
  usersToday?: number;
  workspaces: number;
  projects: number;
  projectsToday?: number;
  deployments: number;
  deploymentsToday?: number;
  deploySuccessToday?: number;
  runningApps: number;
  paidUsers: number;
};

type FunnelStep = {
  id: string;
  label: string;
  count: number;
  rate: number;
};

export default function AdminGrowthOverviewPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [funnel, setFunnel] = useState<FunnelStep[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    void Promise.all([
      api<Overview>('/admin/growth/overview'),
      api<{ steps: FunnelStep[] }>('/admin/growth/funnel'),
    ])
      .then(([o, f]) => {
        setOverview(o);
        setFunnel(f.steps || []);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '加载失败'));
  }, []);

  return (
    <div className="space-y-5">
      <PageHeader
        title="增长分析"
        description="内部运营数据：增长、使用、转化与阻塞点（不含真实收入）"
      />
      <AdminGrowthTabs />
      {error ? <InlineAlert tone="error" title={error} /> : null}

      {!overview ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : (
        <Section title="核心指标">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Metric label="用户总数" value={overview.users} hint={overview.usersToday != null ? `今日 +${overview.usersToday}` : undefined} />
            <Metric label="Workspace 数量" value={overview.workspaces} />
            <Metric label="应用总数" value={overview.projects} hint={overview.projectsToday != null ? `今日 +${overview.projectsToday}` : undefined} />
            <Metric label="成功部署数" value={overview.deployments} hint={overview.deploySuccessToday != null ? `今日成功 ${overview.deploySuccessToday}` : undefined} />
            <Metric label="运行中应用" value={overview.runningApps} />
            <Metric label="付费用户" value={overview.paidUsers} />
          </div>
        </Section>
      )}

      <Section title="用户生命周期漏斗">
        {funnel.length === 0 && !error ? (
          <Skeleton className="h-40" />
        ) : (
          <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-zinc-200 bg-zinc-50 text-xs text-zinc-500">
                <tr>
                  <th className="px-4 py-2 font-medium">阶段</th>
                  <th className="px-4 py-2 font-medium">数量</th>
                  <th className="px-4 py-2 font-medium">相对注册转化率</th>
                </tr>
              </thead>
              <tbody>
                {funnel.map((step, index) => (
                  <tr key={step.id} className="border-b border-zinc-100 last:border-0">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-zinc-100 text-xs text-zinc-600">
                          {index + 1}
                        </span>
                        <span className="font-medium text-zinc-900">{step.label}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-zinc-800">{step.count}</td>
                    <td className="px-4 py-3 tabular-nums text-zinc-600">{step.rate}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

function Metric(props: { label: string; value: number; hint?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-zinc-500">{props.label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900">{props.value}</p>
      {props.hint ? <p className="mt-1 text-xs text-zinc-500">{props.hint}</p> : null}
    </Card>
  );
}
