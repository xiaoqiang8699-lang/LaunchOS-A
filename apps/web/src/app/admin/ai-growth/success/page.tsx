'use client';

import { useEffect, useState } from 'react';
import { AdminAiGrowthTabs } from '@/components/admin/admin-ai-growth-tabs';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { Card, PageHeader, Section } from '@/components/ui/section';
import { api } from '@/lib/api';

type Payload = {
  metrics: {
    windowDays: number;
    deploymentCount: number;
    successCount: number;
    failureCount: number;
    successRate: number;
    firstDeploymentSuccessRate: number;
    firstDeploymentCount: number;
    firstDeploymentSuccessCount: number;
    avgAttemptsToSuccess: number | null;
  };
  frameworks: Array<{
    framework: string;
    deploymentCount: number;
    successCount: number;
    successRate: number;
  }>;
  topBlockers: Array<{ reason: string; code?: string; count: number }>;
  patterns: Array<{
    id: string;
    patternType: string;
    framework: string | null;
    successRate: number;
    sampleCount: number;
    confidence: number;
  }>;
  funnel: {
    stages: Array<{ stage: string; count: number }>;
    dropoffs: Array<{ from: string; to: string; drop: number; dropRate: number }>;
  };
  risks: Array<{ level: string; title: string; detail: string }>;
  recommendations: Array<{
    id: string;
    category: string;
    title: string;
    description: string;
    impact: string;
    priority: number;
  }>;
  summary: string;
  note?: string;
};

function pct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

export default function AdminSuccessOptimizerPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  async function load() {
    setError('');
    try {
      setData(await api<Payload>('/admin/ai-growth/success'));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '加载失败');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function refresh() {
    setMsg('');
    try {
      const result = await api<{ scanned: number; written: number }>('/admin/ai-growth/success/refresh', {
        method: 'POST',
      });
      setMsg(`已刷新快照：扫描 ${result.scanned}，写入 ${result.written}`);
      await load();
    } catch (err: unknown) {
      setMsg(err instanceof Error ? err.message : '刷新失败');
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="AI 成功率分析"
        description="理解成功部署模式与流失节点，仅分析建议，不自动改产品"
        action={
          <button
            type="button"
            className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm text-white"
            onClick={() => void refresh()}
          >
            刷新快照
          </button>
        }
      />
      <AdminAiGrowthTabs />
      {error ? <InlineAlert tone="error" title={error} /> : null}
      {msg ? <InlineAlert tone="info" title={msg} /> : null}
      {data?.note ? <InlineAlert tone="info" title={data.note} /> : null}

      {!data ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <Section title="平台部署健康">
            <Card className="mb-4 p-5">
              <pre className="whitespace-pre-wrap font-sans text-sm leading-6 text-zinc-800">
                {data.summary}
              </pre>
            </Card>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {[
                ['部署次数', data.metrics.deploymentCount],
                ['成功', data.metrics.successCount],
                ['成功率', pct(data.metrics.successRate)],
                ['首次成功率', pct(data.metrics.firstDeploymentSuccessRate)],
              ].map(([label, value]) => (
                <Card key={String(label)} className="p-4">
                  <p className="text-xs text-zinc-500">{label}</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
                </Card>
              ))}
            </div>
            <p className="mt-2 text-xs text-zinc-500">
              窗口 {data.metrics.windowDays} 天 · 失败 {data.metrics.failureCount} · 首次样本{' '}
              {data.metrics.firstDeploymentCount}
              {data.metrics.avgAttemptsToSuccess != null
                ? ` · 平均成功尝试 ${data.metrics.avgAttemptsToSuccess.toFixed(1)}`
                : ''}
            </p>
          </Section>

          <Section title="框架成功率">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {data.frameworks.length === 0 ? (
                <Card className="p-4 text-sm text-zinc-500">暂无框架数据</Card>
              ) : (
                data.frameworks.map((fw) => (
                  <Card key={fw.framework} className="p-4">
                    <p className="text-sm font-medium text-zinc-900">{fw.framework}</p>
                    <p className="mt-1 text-2xl font-semibold tabular-nums">{pct(fw.successRate)}</p>
                    <p className="mt-1 text-xs text-zinc-500">
                      {fw.successCount}/{fw.deploymentCount} 成功
                    </p>
                  </Card>
                ))
              )}
            </div>
          </Section>

          <Section title="TOP 阻塞原因">
            <Card className="divide-y divide-zinc-100">
              {data.topBlockers.length === 0 ? (
                <p className="p-4 text-sm text-zinc-500">暂无失败归因</p>
              ) : (
                data.topBlockers.map((b, i) => (
                  <div key={`${b.reason}-${i}`} className="flex items-center justify-between gap-3 px-4 py-3">
                    <p className="text-sm text-zinc-800">
                      <span className="mr-2 text-zinc-400">{i + 1}.</span>
                      {b.reason}
                    </p>
                    <p className="text-sm font-medium tabular-nums text-zinc-900">{b.count}</p>
                  </div>
                ))
              )}
            </Card>
          </Section>

          <Section title="部署漏斗">
            <div className="grid gap-3 lg:grid-cols-2">
              <Card className="p-4">
                <p className="mb-3 text-xs font-medium uppercase tracking-wide text-zinc-500">阶段到达</p>
                <ul className="space-y-2">
                  {data.funnel.stages.map((s) => (
                    <li key={s.stage} className="flex justify-between text-sm">
                      <span className="text-zinc-700">{s.stage}</span>
                      <span className="tabular-nums font-medium">{s.count}</span>
                    </li>
                  ))}
                </ul>
              </Card>
              <Card className="p-4">
                <p className="mb-3 text-xs font-medium uppercase tracking-wide text-zinc-500">流失节点</p>
                <ul className="space-y-2">
                  {data.funnel.dropoffs.map((d) => (
                    <li key={`${d.from}-${d.to}`} className="text-sm text-zinc-700">
                      {d.from} → {d.to}：流失 {d.drop}（{pct(d.dropRate)}）
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          </Section>

          <Section title="风险列表">
            <div className="space-y-2">
              {data.risks.map((r) => (
                <Card key={r.title} className="p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={
                        r.level === 'HIGH'
                          ? 'rounded bg-red-100 px-2 py-0.5 text-xs text-red-800'
                          : r.level === 'MEDIUM'
                            ? 'rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800'
                            : 'rounded bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700'
                      }
                    >
                      {r.level}
                    </span>
                    <p className="text-sm font-medium text-zinc-900">{r.title}</p>
                  </div>
                  <p className="mt-1 text-sm text-zinc-600">{r.detail}</p>
                </Card>
              ))}
            </div>
          </Section>

          <Section title="优化建议">
            <div className="space-y-2">
              {data.recommendations.map((rec) => (
                <Card key={rec.id} className="p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded border border-zinc-200 px-2 py-0.5 text-xs text-zinc-600">
                      {rec.category}
                    </span>
                    <span className="text-xs text-zinc-400">P{rec.priority}</span>
                  </div>
                  <p className="mt-2 text-sm font-medium text-zinc-900">{rec.title}</p>
                  <p className="mt-1 text-sm text-zinc-600">{rec.description}</p>
                  <p className="mt-2 text-xs text-emerald-700">影响：{rec.impact}</p>
                </Card>
              ))}
            </div>
          </Section>

          <Section title="成功模式">
            <Card className="divide-y divide-zinc-100">
              {data.patterns.length === 0 ? (
                <p className="p-4 text-sm text-zinc-500">暂无模式</p>
              ) : (
                data.patterns.slice(0, 12).map((p) => (
                  <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                    <div>
                      <p className="text-sm text-zinc-800">
                        {p.patternType}
                        {p.framework ? ` · ${p.framework}` : ''}
                      </p>
                      <p className="text-xs text-zinc-500">样本 {p.sampleCount} · 置信 {pct(p.confidence)}</p>
                    </div>
                    <p className="text-sm font-semibold tabular-nums">{pct(p.successRate)}</p>
                  </div>
                ))
              )}
            </Card>
          </Section>
        </>
      )}
    </div>
  );
}
