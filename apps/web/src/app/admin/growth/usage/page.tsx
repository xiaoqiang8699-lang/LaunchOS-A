'use client';

import { useEffect, useState } from 'react';
import { AdminGrowthTabs } from '@/components/admin/admin-growth-tabs';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { Card, PageHeader, Section } from '@/components/ui/section';
import { api } from '@/lib/api';

type Usage = {
  projectsToday: number;
  deploymentsToday: number;
  deploySuccessToday: number;
  deployFailedToday: number;
  successRateToday: number | null;
  averageDeployDurationMs: number | null;
  runningApps: number;
  daily: {
    projects: Array<{ date: string; count: number }>;
    deployments: Array<{ date: string; count: number }>;
  };
  techStack: Array<{ name: string; count: number }>;
};

function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

export default function AdminGrowthUsagePage() {
  const [data, setData] = useState<Usage | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void api<Usage>('/admin/growth/usage')
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '加载失败'));
  }, []);

  return (
    <div className="space-y-5">
      <PageHeader title="产品使用" description="应用创建、部署与技术栈分布" />
      <AdminGrowthTabs />
      {error ? <InlineAlert tone="error" title={error} /> : null}

      {!data ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <Section title="应用行为">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <Metric label="今日创建应用" value={data.projectsToday} />
              <Metric label="今日部署" value={data.deploymentsToday} />
              <Metric
                label="部署成功率"
                value={data.successRateToday == null ? '—' : `${data.successRateToday}%`}
              />
              <Metric label="平均部署时间" value={formatDuration(data.averageDeployDurationMs)} />
              <Metric label="运行中应用" value={data.runningApps} />
            </div>
            <p className="mt-2 text-xs text-zinc-500">
              今日成功 {data.deploySuccessToday} · 失败 {data.deployFailedToday}
            </p>
          </Section>

          <Section title="近 7 日趋势（表格）">
            <div className="grid gap-4 lg:grid-cols-2">
              <DailyTable title="每日创建应用" rows={data.daily.projects} />
              <DailyTable title="每日部署" rows={data.daily.deployments} />
            </div>
          </Section>

          <Section title="热门技术栈">
            <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-zinc-200 bg-zinc-50 text-xs text-zinc-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">技术栈</th>
                    <th className="px-4 py-2 font-medium">应用数</th>
                  </tr>
                </thead>
                <tbody>
                  {data.techStack.map((row) => (
                    <tr key={row.name} className="border-b border-zinc-100 last:border-0">
                      <td className="px-4 py-3 font-medium">{row.name}</td>
                      <td className="px-4 py-3 tabular-nums">{row.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </>
      )}
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

function DailyTable(props: { title: string; rows: Array<{ date: string; count: number }> }) {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
      <div className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 text-sm font-medium text-zinc-700">
        {props.title}
      </div>
      <table className="w-full text-left text-sm">
        <thead className="border-b border-zinc-100 text-xs text-zinc-500">
          <tr>
            <th className="px-4 py-2 font-medium">日期</th>
            <th className="px-4 py-2 font-medium">数量</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.length === 0 ? (
            <tr>
              <td className="px-4 py-3 text-zinc-500" colSpan={2}>
                暂无数据
              </td>
            </tr>
          ) : (
            props.rows.map((row) => (
              <tr key={row.date} className="border-b border-zinc-50 last:border-0">
                <td className="px-4 py-2">{row.date}</td>
                <td className="px-4 py-2 tabular-nums">{row.count}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
