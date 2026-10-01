'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { Card, PageHeader, Section } from '@/components/ui/section';
import { api } from '@/lib/api';

type Summary = {
  total: number;
  successCount: number;
  firstLaunchSuccessRate: number | null;
  medianLaunchDurationMs: number | null;
  averageInterventions: number;
  mostCommonFailureStage: string | null;
  health24hRate: number | null;
  exit: {
    sampleReady: boolean;
    met: boolean;
    note: string;
    checks: Array<{ id: string; label: string; met: boolean; actual: string }>;
  };
};

type SessionRow = {
  id: string;
  projectId: string | null;
  projectName: string | null;
  projectType: string | null;
  sessionStatus: string;
  launchSucceeded: boolean | null;
  totalDurationMs: number | null;
  manualInterventionCount: number;
  primaryFailureCode: string | null;
  blockedStage: string | null;
};

function percent(value: number | null): string {
  if (value == null) return '—';
  return `${Math.round(value * 100)}%`;
}

export default function AdminBetaPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    void api<{ summary: Summary; sessions: SessionRow[] }>('/alpha-tests')
      .then((payload) => {
        setSummary(payload.summary);
        setSessions(payload.sessions || []);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '加载失败'));
  }, []);

  const failed = sessions.filter((item) => item.sessionStatus === 'FAILED').length;
  const p0Like = failed;
  const pause = p0Like > 0;

  return (
    <div className="space-y-4">
      <PageHeader title="Beta 运营" description="测试批次、Session 进度与问题门禁" />
      {error ? <InlineAlert tone="error" title={error} /> : null}

      {pause ? (
        <InlineAlert
          tone="error"
          title="存在失败 Session，建议暂停下一批"
          description={`当前失败 Session：${p0Like}（以真实失败数为准；无独立 P0 字段时不伪造）`}
        />
      ) : (
        <InlineAlert tone="success" title="当前没有已知失败 Session 阻断" />
      )}

      {!summary ? (
        <Skeleton className="h-32" />
      ) : (
        <Section title="当前 Batch 摘要">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="p-4">
              <p className="text-xs text-zinc-500">Session 总数</p>
              <p className="mt-1 text-2xl font-semibold">{summary.total}</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs text-zinc-500">首次上线成功率</p>
              <p className="mt-1 text-2xl font-semibold">{percent(summary.firstLaunchSuccessRate)}</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs text-zinc-500">平均干预次数</p>
              <p className="mt-1 text-2xl font-semibold">{summary.averageInterventions}</p>
            </Card>
            <Card className="p-4">
              <p className="text-xs text-zinc-500">最常见失败阶段</p>
              <p className="mt-1 text-lg font-semibold">{summary.mostCommonFailureStage || '—'}</p>
            </Card>
          </div>
          <p className="mt-3 text-sm text-zinc-600">{summary.exit.note}</p>
          {summary.exit.checks?.length ? (
            <ul className="mt-2 space-y-1 text-xs text-zinc-500">
              {summary.exit.checks.map((check) => (
                <li key={check.id}>
                  {check.met ? '✓' : '✗'} {check.label} · {check.actual}
                </li>
              ))}
            </ul>
          ) : null}
        </Section>
      )}

      <Section title="Sessions">
        <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="border-b bg-zinc-50 text-xs text-zinc-500">
              <tr>
                <th className="px-3 py-2">Session</th>
                <th className="px-3 py-2">项目</th>
                <th className="px-3 py-2">类型</th>
                <th className="px-3 py-2">状态</th>
                <th className="px-3 py-2">干预</th>
                <th className="px-3 py-2">失败</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((item) => (
                <tr key={item.id} className="border-b border-zinc-50">
                  <td className="px-3 py-2">
                    <Link className="underline" href={`/admin/beta/sessions/${item.id}`}>
                      {item.id.slice(0, 10)}…
                    </Link>
                  </td>
                  <td className="px-3 py-2">{item.projectName || '—'}</td>
                  <td className="px-3 py-2">{item.projectType || '—'}</td>
                  <td className="px-3 py-2">{item.sessionStatus}</td>
                  <td className="px-3 py-2">{item.manualInterventionCount}</td>
                  <td className="px-3 py-2 text-xs">
                    {item.primaryFailureCode || item.blockedStage || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}
