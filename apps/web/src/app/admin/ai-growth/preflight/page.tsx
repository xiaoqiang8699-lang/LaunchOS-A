'use client';

import { useEffect, useState } from 'react';
import { AdminAiGrowthTabs } from '@/components/admin/admin-ai-growth-tabs';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { Card, PageHeader, Section } from '@/components/ui/section';
import { api } from '@/lib/api';

type Stats = {
  windowDays: number;
  preflightCount: number;
  riskCount: number;
  warningCount: number;
  blockedCount: number;
  avoidedFailures: number;
  summary: string;
  note?: string;
};

export default function AdminPreflightStatsPage() {
  const [data, setData] = useState<Stats | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void api<Stats>('/admin/ai-growth/preflight')
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '加载失败'));
  }, []);

  return (
    <div className="space-y-5">
      <PageHeader title="部署预检统计" description="过去 30 天 AI 预检与风险拦截" />
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
          </Section>
          <Section title="指标">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {[
                ['预检次数', data.preflightCount],
                ['发现风险', data.riskCount],
                ['阻止部署', data.blockedCount],
                ['避免失败', data.avoidedFailures],
              ].map(([label, value]) => (
                <Card key={String(label)} className="p-4">
                  <p className="text-xs text-zinc-500">{label}</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
                </Card>
              ))}
            </div>
            <p className="mt-2 text-xs text-zinc-500">窗口 {data.windowDays} 天 · 警告 {data.warningCount}</p>
          </Section>
        </>
      )}
    </div>
  );
}
