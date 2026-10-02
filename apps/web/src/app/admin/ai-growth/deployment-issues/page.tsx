'use client';

import { useEffect, useState } from 'react';
import { AdminAiGrowthTabs } from '@/components/admin/admin-ai-growth-tabs';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { Card, PageHeader, Section } from '@/components/ui/section';
import { api } from '@/lib/api';

type Stats = {
  windowDays: number;
  failureCount: number;
  insightCount: number;
  topReasons: Array<{ reason: string; count: number }>;
  summary: string;
  note?: string;
};

export default function AdminDeploymentIssuesStatsPage() {
  const [data, setData] = useState<Stats | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void api<Stats>('/admin/ai-growth/deployment-issues')
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '加载失败'));
  }, []);

  return (
    <div className="space-y-5">
      <PageHeader title="部署失败统计" description="过去 30 天失败分类（AI Copilot 规则库）" />
      <AdminAiGrowthTabs />
      {error ? <InlineAlert tone="error" title={error} /> : null}
      {data?.note ? <InlineAlert tone="info" title={data.note} /> : null}

      {!data ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <Section title="摘要">
            <Card className="p-5">
              <pre className="whitespace-pre-wrap font-sans text-sm leading-6 text-zinc-800">
                {data.summary}
              </pre>
            </Card>
            <p className="mt-2 text-xs text-zinc-500">
              失败 {data.failureCount} · Insight {data.insightCount} · 窗口 {data.windowDays} 天
            </p>
          </Section>
          <Section title="TOP 原因">
            <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-zinc-200 bg-zinc-50 text-xs text-zinc-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">#</th>
                    <th className="px-4 py-2 font-medium">原因</th>
                    <th className="px-4 py-2 font-medium">次数</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topReasons.map((row, index) => (
                    <tr key={row.reason} className="border-b border-zinc-100 last:border-0">
                      <td className="px-4 py-3 tabular-nums">{index + 1}</td>
                      <td className="px-4 py-3 font-medium">{row.reason}</td>
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
