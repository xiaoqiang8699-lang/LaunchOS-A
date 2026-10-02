'use client';

import { useEffect, useState } from 'react';
import { AdminAiGrowthTabs } from '@/components/admin/admin-ai-growth-tabs';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { Card, PageHeader, Section } from '@/components/ui/section';
import { StatusBadge } from '@/components/ui/status-badge';
import { api } from '@/lib/api';

type Summary = {
  summary: string;
  keyMetrics: {
    newUsers: number;
    newProjects: number;
    deploySuccess: number;
    deployFailed: number;
    usersNeedingHelp: number;
    pendingLifecycleActions: number;
    upgradePotentialUsers: number;
    dormantUsers: number;
  };
  risks: Array<{ code: string; title: string; priority: 'HIGH' | 'MEDIUM' | 'LOW' }>;
  recommendations: Array<{
    type: string;
    title: string;
    content: string;
    priority: 'HIGH' | 'MEDIUM' | 'LOW';
  }>;
  aiNarrative?: string;
  note?: string;
  generatedAt?: string;
};

export default function AdminAiGrowthPage() {
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void api<Summary>('/admin/ai-growth/summary')
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '加载失败'));
  }, []);

  return (
    <div className="space-y-5">
      <PageHeader
        title="AI运营助手"
        description="基于内部运营数据的分析与建议（不自动改数据、不发消息、不触发支付）"
      />
      <AdminAiGrowthTabs />
      {error ? <InlineAlert tone="error" title={error} /> : null}
      {data?.note ? <InlineAlert tone="info" title={data.note} /> : null}

      {!data ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <Section title="今日运营摘要">
            <Card className="p-5">
              <pre className="whitespace-pre-wrap font-sans text-sm leading-6 text-zinc-800">
                {data.summary}
              </pre>
            </Card>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Metric label="新增用户" value={data.keyMetrics.newUsers} />
              <Metric label="新增应用" value={data.keyMetrics.newProjects} />
              <Metric label="部署成功" value={data.keyMetrics.deploySuccess} />
              <Metric label="部署失败" value={data.keyMetrics.deployFailed} />
            </div>
          </Section>

          <Section title="风险">
            {data.risks.length === 0 ? (
              <p className="text-sm text-zinc-500">暂无明显风险</p>
            ) : (
              <ul className="space-y-2">
                {data.risks.map((risk) => (
                  <li
                    key={risk.code}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm"
                  >
                    <span>{risk.title}</span>
                    <StatusBadge
                      status={risk.priority}
                      label={risk.priority}
                      tone={
                        risk.priority === 'HIGH'
                          ? 'error'
                          : risk.priority === 'MEDIUM'
                            ? 'warning'
                            : 'neutral'
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="运营建议">
            <div className="space-y-3">
              {data.recommendations.map((item) => (
                <Card key={item.title} className="p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium text-zinc-900">{item.title}</p>
                    <StatusBadge
                      status={item.priority}
                      label={`${item.type} · ${item.priority}`}
                      tone={
                        item.priority === 'HIGH'
                          ? 'error'
                          : item.priority === 'MEDIUM'
                            ? 'warning'
                            : 'info'
                      }
                    />
                  </div>
                  <p className="mt-2 text-sm text-zinc-600">{item.content}</p>
                </Card>
              ))}
            </div>
          </Section>

          {data.aiNarrative ? (
            <Section title="AI 叙述">
              <Card className="p-4">
                <pre className="whitespace-pre-wrap font-sans text-sm text-zinc-700">
                  {data.aiNarrative}
                </pre>
              </Card>
            </Section>
          ) : null}
        </>
      )}
    </div>
  );
}

function Metric(props: { label: string; value: number }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-zinc-500">{props.label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900">{props.value}</p>
    </Card>
  );
}
