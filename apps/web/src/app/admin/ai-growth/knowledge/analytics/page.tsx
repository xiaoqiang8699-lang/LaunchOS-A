'use client';

import { useEffect, useState } from 'react';
import { AdminAiGrowthTabs } from '@/components/admin/admin-ai-growth-tabs';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { Card, PageHeader, Section } from '@/components/ui/section';
import { api } from '@/lib/api';

type Analytics = {
  knowledgeCount: number;
  resolvedDeployments: number;
  maxSuccessRate: number;
  topProblems: Array<{ reason: string; count: number }>;
  summary: string;
  note?: string;
};

export default function AdminKnowledgeAnalyticsPage() {
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void api<Analytics>('/admin/ai-growth/knowledge/analytics')
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '加载失败'));
  }, []);

  return (
    <div className="space-y-5">
      <PageHeader title="知识库统计" description="过去 30 天知识沉淀与解决效果" />
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
            <div className="grid gap-3 sm:grid-cols-3">
              {[
                ['知识数量', data.knowledgeCount],
                ['解决部署次数', data.resolvedDeployments],
                ['最高成功率', `${Math.round(data.maxSuccessRate * 100)}%`],
              ].map(([label, value]) => (
                <Card key={String(label)} className="p-4">
                  <p className="text-xs text-zinc-500">{label}</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
                </Card>
              ))}
            </div>
          </Section>
          <Section title="TOP 问题">
            <ol className="list-decimal space-y-2 pl-5 text-sm">
              {data.topProblems.map((row) => (
                <li key={row.reason}>
                  {row.reason} · {row.count}
                </li>
              ))}
            </ol>
          </Section>
        </>
      )}
    </div>
  );
}
