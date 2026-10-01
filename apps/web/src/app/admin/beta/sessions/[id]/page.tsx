'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { Card, PageHeader, Section } from '@/components/ui/section';
import { StatusBadge } from '@/components/ui/status-badge';
import { api } from '@/lib/api';

type Detail = {
  session: {
    id: string;
    sessionStatus: string;
    projectType: string | null;
    framework: string | null;
    launchSucceeded: boolean | null;
    totalDurationMs: number | null;
    manualInterventionCount: number;
    primaryFailureCode: string | null;
    blockedStage: string | null;
    publicUrl: string | null;
  };
  projectName: string | null;
  timeline: Array<{ stage: string; at?: string | null; status?: string }>;
  durations: Record<string, number | null>;
  interventions: Array<{
    id: string;
    stage: string;
    reason: string;
    actionTaken: string;
    severity: string | null;
    resolved: boolean;
    createdAt: string;
  }>;
  frictions: Array<{ id: string; createdAt: string; stage?: string; note?: string }>;
};

export default function AdminBetaSessionDetailPage() {
  const params = useParams<{ id: string }>();
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void api<Detail>(`/alpha-tests/${params.id}`)
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '加载失败'));
  }, [params.id]);

  if (error) return <InlineAlert tone="error" title={error} />;
  if (!data) return <Skeleton className="h-64" />;

  const session = data.session;

  return (
    <div className="space-y-4">
      <PageHeader
        title={`Beta Session · ${data.projectName || session.id.slice(0, 8)}`}
        description="Funnel timeline · Intervention · Issue（secrets 已脱敏）"
      />
      <p className="text-sm">
        <Link className="underline" href="/admin/beta">
          返回 Beta 运营
        </Link>
      </p>

      <Section title="摘要">
        <Card className="grid gap-2 p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <p>状态：{session.sessionStatus}</p>
          <p>类型：{session.projectType || '—'} / {session.framework || '—'}</p>
          <p>干预：{session.manualInterventionCount}</p>
          <p>失败：{session.primaryFailureCode || session.blockedStage || '—'}</p>
          <p>首次成功：{session.launchSucceeded == null ? '—' : session.launchSucceeded ? '是' : '否'}</p>
          <p>
            时长：
            {session.totalDurationMs != null
              ? `${Math.round(session.totalDurationMs / 1000)}s`
              : '—'}
          </p>
          <p className="sm:col-span-2">公网：{session.publicUrl || '—'}</p>
        </Card>
      </Section>

      <Section title="Funnel Timeline">
        <ol className="space-y-2">
          {(data.timeline || []).map((step, index) => (
            <li key={`${step.stage}-${index}`} className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{step.stage}</span>
                {step.status ? <StatusBadge status={step.status} /> : null}
              </div>
              <p className="mt-1 text-xs text-zinc-500">
                {step.at ? new Date(step.at).toLocaleString() : '—'}
                {data.durations?.[step.stage] != null
                  ? ` · ${Math.round((data.durations[step.stage] as number) / 1000)}s`
                  : ''}
              </p>
            </li>
          ))}
        </ol>
      </Section>

      <Section title="Interventions / Issues">
        {data.interventions.length === 0 ? (
          <p className="text-sm text-zinc-500">无干预记录</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
            <table className="w-full min-w-[800px] text-left text-sm">
              <thead className="border-b bg-zinc-50 text-xs text-zinc-500">
                <tr>
                  <th className="px-3 py-2">阶段</th>
                  <th className="px-3 py-2">原因</th>
                  <th className="px-3 py-2">动作</th>
                  <th className="px-3 py-2">Severity</th>
                  <th className="px-3 py-2">时间</th>
                </tr>
              </thead>
              <tbody>
                {data.interventions.map((item) => (
                  <tr key={item.id} className="border-b border-zinc-50">
                    <td className="px-3 py-2">{item.stage}</td>
                    <td className="px-3 py-2">{item.reason}</td>
                    <td className="px-3 py-2">{item.actionTaken}</td>
                    <td className="px-3 py-2">{item.severity || '—'}</td>
                    <td className="px-3 py-2 text-xs">{new Date(item.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {data.frictions.length > 0 ? (
        <Section title="Frictions">
          <ul className="space-y-2 text-sm">
            {data.frictions.map((item) => (
              <li key={item.id} className="rounded-lg border bg-white px-3 py-2">
                {item.stage || '—'} · {item.note || '—'} ·{' '}
                <span className="text-xs text-zinc-500">{new Date(item.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}
