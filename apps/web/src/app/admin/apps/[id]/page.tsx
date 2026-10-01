'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { Card, PageHeader, Section } from '@/components/ui/section';
import { StatusBadge } from '@/components/ui/status-badge';
import { api, ApiError } from '@/lib/api';

type AppDetail = {
  id: string;
  name: string;
  type: string;
  status: string;
  workspace: string;
  workspaceId: string;
  owner: string;
  publicUrl: string | null;
  healthStatus: string;
  serviceStatus: string | null;
  launchRuns: Array<{ id: string; status: string; createdAt: string; finishedAt?: string | null }>;
};

type DeploymentList = {
  items: Array<{
    id: string;
    status: string;
    failureCategory: string | null;
    errorMessage: string | null;
    createdAt: string;
  }>;
};

export default function AdminAppDetailPage() {
  const params = useParams<{ id: string }>();
  const [app, setApp] = useState<AppDetail | null>(null);
  const [deployments, setDeployments] = useState<DeploymentList['items']>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    void api<AppDetail>(`/admin/apps/${params.id}`)
      .then(async (detail) => {
        setApp(detail);
        const list = await api<DeploymentList>(
          `/admin/deployments?page=1&pageSize=10&q=${encodeURIComponent(detail.name)}`,
        ).catch(() => ({ items: [] as DeploymentList['items'] }));
        setDeployments(list.items.filter((item) => true).slice(0, 10));
      })
      .catch((reason) => setError(reason instanceof ApiError ? reason.message : '加载失败'));
  }, [params.id]);

  if (error) return <InlineAlert tone="error" title={error} />;
  if (!app) return <Skeleton className="h-48" />;

  return (
    <div className="space-y-4">
      <PageHeader title={app.name} description="运营端应用详情 · 技术字段可见" />
      <p className="text-sm">
        <Link className="underline" href="/admin/apps">
          返回应用中心
        </Link>
      </p>

      <Section title="基本信息">
        <Card className="grid gap-2 p-4 text-sm sm:grid-cols-2">
          <p>
            Workspace：
            <Link className="underline" href={`/admin/workspaces/${app.workspaceId}`}>
              {app.workspace}
            </Link>
          </p>
          <p>Owner：{app.owner}</p>
          <p>类型：{app.type}</p>
          <p>
            运行状态：<StatusBadge status={app.status} />
          </p>
          <p>
            健康：<StatusBadge status={app.healthStatus} />
          </p>
          <p>ServiceInstance：{app.serviceStatus || '—'}</p>
          <p className="sm:col-span-2">公网：{app.publicUrl || '—'}</p>
          <p className="sm:col-span-2 text-xs text-zinc-500">App ID：{app.id}</p>
        </Card>
      </Section>

      <Section title="最近 Deployment">
        {deployments.length === 0 ? (
          <p className="text-sm text-zinc-500">暂无部署记录</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border bg-white">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b bg-zinc-50 text-xs text-zinc-500">
                <tr>
                  <th className="px-3 py-2">Deployment</th>
                  <th className="px-3 py-2">状态</th>
                  <th className="px-3 py-2">失败分类</th>
                  <th className="px-3 py-2">时间</th>
                </tr>
              </thead>
              <tbody>
                {deployments.map((row) => (
                  <tr key={row.id} className="border-b border-zinc-50">
                    <td className="px-3 py-2">
                      <Link className="underline" href={`/admin/deployments/${row.id}`}>
                        {row.id.slice(0, 10)}…
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={row.status} />
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {row.failureCategory || row.errorMessage || '—'}
                    </td>
                    <td className="px-3 py-2 text-xs">{new Date(row.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="LaunchRun">
        <ul className="space-y-1 text-sm">
          {app.launchRuns.map((run) => (
            <li key={run.id}>
              {run.status} · {new Date(run.createdAt).toLocaleString()}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
