'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { Card, PageHeader, Section } from '@/components/ui/section';
import { StatusBadge } from '@/components/ui/status-badge';
import { api } from '@/lib/api';

type Detail = {
  id: string;
  status: string;
  version: string | null;
  createdAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
  failureCategory: string | null;
  currentStage: string | null;
  stageHistory: unknown;
  app: {
    id: string;
    name: string;
    workspace: { id: string; name: string; owner: { email: string; name: string | null } };
  };
  steps: Array<{
    id: string;
    name: string;
    status: string;
    message: string | null;
    createdAt: string;
    finishedAt: string | null;
  }>;
  serverInstance: {
    id: string;
    name: string;
    status: string;
    scope: string;
    host: string | null;
  } | null;
  serviceInstance: {
    id: string;
    status: string;
    healthStatus: string | null;
    port: number | null;
    runtime: string | null;
  } | null;
  diagnoses: Array<{
    id: string;
    category: string;
    severity: string;
    title: string;
    description: string;
  }>;
};

export default function AdminDeploymentDetailPage() {
  const params = useParams<{ id: string }>();
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void api<Detail>(`/admin/deployments/${params.id}`)
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '加载失败'));
  }, [params.id]);

  if (error) return <InlineAlert tone="error" title={error} />;
  if (!data) return <Skeleton className="h-64" />;

  return (
    <div className="space-y-5">
      <PageHeader
        title={`部署 ${data.id.slice(0, 12)}…`}
        description={`${data.app.name} · ${data.app.workspace.name}`}
        action={<StatusBadge status={data.status} />}
      />

      <Card className="grid gap-2 p-4 text-sm sm:grid-cols-2">
        <p>应用：<Link className="underline" href={`/admin/apps/${data.app.id}`}>{data.app.name}</Link></p>
        <p>Workspace：<Link className="underline" href={`/admin/workspaces/${data.app.workspace.id}`}>{data.app.workspace.name}</Link></p>
        <p>用户：{data.app.workspace.owner.email}</p>
        <p>版本：{data.version || '—'}</p>
        <p>当前阶段：{data.currentStage || '—'}</p>
        <p>失败分类：{data.failureCategory || '—'}</p>
        <p>开始：{new Date(data.createdAt).toLocaleString()}</p>
        <p>结束：{data.finishedAt ? new Date(data.finishedAt).toLocaleString() : '—'}</p>
      </Card>

      {data.errorMessage ? (
        <InlineAlert tone="error" title="用户可见错误" description={data.errorMessage} />
      ) : null}

      <Section title="Stage timeline">
        <ul className="space-y-2">
          {data.steps.map((step) => (
            <li key={step.id} className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{step.name}</span>
                <StatusBadge status={step.status} />
              </div>
              {step.message ? <p className="mt-1 text-xs text-zinc-600">{step.message}</p> : null}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="运行与诊断">
        <Card className="space-y-2 p-4 text-sm">
          <p>ServiceInstance：{data.serviceInstance?.id || '—'} · {data.serviceInstance?.status || '—'}</p>
          <p>Server：{data.serverInstance?.name || '—'} · {data.serverInstance?.scope || '—'}</p>
          {data.serverInstance?.host ? <p>Host：{data.serverInstance.host}</p> : null}
          {data.diagnoses.map((item) => (
            <div key={item.id} className="rounded-lg bg-zinc-50 px-3 py-2">
              <p className="font-medium">{item.title}</p>
              <p className="text-xs text-zinc-600">{item.category} · {item.severity}</p>
              <p className="mt-1 text-xs">{item.description}</p>
            </div>
          ))}
        </Card>
      </Section>
    </div>
  );
}
