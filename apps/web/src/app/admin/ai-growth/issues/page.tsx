'use client';

import { useEffect, useState } from 'react';
import { AdminAiGrowthTabs } from '@/components/admin/admin-ai-growth-tabs';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { Card, PageHeader, Section } from '@/components/ui/section';
import { api } from '@/lib/api';

type Issues = {
  windowDays: number;
  failureCount: number;
  topReasons: Array<{ reason: string; count: number }>;
  suggestions: string[];
  summary: string;
  aiNarrative?: string;
  note?: string;
};

export default function AdminAiGrowthIssuesPage() {
  const [data, setData] = useState<Issues | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void api<Issues>('/admin/ai-growth/issues')
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '加载失败'));
  }, []);

  return (
    <div className="space-y-5">
      <PageHeader title="部署问题分析" description="过去 7 天失败原因汇总与产品改进建议" />
      <AdminAiGrowthTabs />
      {error ? <InlineAlert tone="error" title={error} /> : null}
      {data?.note ? <InlineAlert tone="info" title={data.note} /> : null}

      {!data ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <Section title="AI 自动总结">
            <Card className="p-5">
              <pre className="whitespace-pre-wrap font-sans text-sm leading-6 text-zinc-800">
                {data.summary}
              </pre>
            </Card>
          </Section>

          <Section title="TOP 失败原因">
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
                  {data.topReasons.length === 0 ? (
                    <tr>
                      <td className="px-4 py-3 text-zinc-500" colSpan={3}>
                        暂无失败记录
                      </td>
                    </tr>
                  ) : (
                    data.topReasons.map((row, index) => (
                      <tr key={row.reason} className="border-b border-zinc-100 last:border-0">
                        <td className="px-4 py-3 tabular-nums">{index + 1}</td>
                        <td className="px-4 py-3 font-medium">{row.reason}</td>
                        <td className="px-4 py-3 tabular-nums">{row.count}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Section>

          <Section title="建议">
            <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-700">
              {data.suggestions.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </Section>
        </>
      )}
    </div>
  );
}
