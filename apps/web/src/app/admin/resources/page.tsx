'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { Card, PageHeader, Section } from '@/components/ui/section';
import { StatusBadge } from '@/components/ui/status-badge';
import { api } from '@/lib/api';

type Resources = {
  managed: Array<{
    id: string;
    name: string | null;
    host: string;
    status: string;
    admission: string | null;
    diskWarning: boolean;
    diskCritical: boolean;
    snapshot: {
      cpuCores: number | null;
      memoryTotalMb: number | null;
      memoryAvailableMb: number | null;
      diskUsedPercent: number | null;
      runningRuntimeCount: number;
      activeDeploymentCount: number;
      activeBuildCount: number;
      allocatedPortCount: number;
    } | null;
  }>;
  owned: Array<{
    id: string;
    name: string;
    status: string;
    dockerStatus: string;
    workspaceId: string | null;
    workspaceName: string | null;
    ownerEmail: string | null;
    updatedAt: string;
  }>;
};

export default function AdminResourcesPage() {
  const [tab, setTab] = useState<'managed' | 'owned'>('managed');
  const [data, setData] = useState<Resources | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void api<Resources>('/admin/platform-resources')
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '加载失败'));
  }, []);

  return (
    <div className="space-y-4">
      <PageHeader title="运行资源" description="平台托管与用户自有服务器" />
      {error ? <InlineAlert tone="error" title={error} /> : null}
      <div className="flex gap-2">
        <button
          type="button"
          className={`rounded-lg px-3 py-2 text-sm ${tab === 'managed' ? 'bg-zinc-900 text-white' : 'border bg-white'}`}
          onClick={() => setTab('managed')}
        >
          平台托管
        </button>
        <button
          type="button"
          className={`rounded-lg px-3 py-2 text-sm ${tab === 'owned' ? 'bg-zinc-900 text-white' : 'border bg-white'}`}
          onClick={() => setTab('owned')}
        >
          用户自有服务器
        </button>
      </div>

      {!data ? (
        <Skeleton className="h-64" />
      ) : tab === 'managed' ? (
        <Section title="PLATFORM_MANAGED">
          <div className="space-y-3">
            {data.managed.map((server) => {
              const snap = server.snapshot;
              return (
                <Card key={server.id} className="p-4 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-semibold">{server.name || server.host}</p>
                      <p className="text-xs text-zinc-500">{server.host}</p>
                    </div>
                    <StatusBadge
                      status={server.diskCritical ? 'FAILED' : server.diskWarning ? 'WARNING' : server.status}
                      label={
                        server.diskCritical
                          ? 'Disk Critical'
                          : server.diskWarning
                            ? 'Disk Warning'
                            : server.admission || server.status
                      }
                    />
                  </div>
                  {snap ? (
                    <dl className="mt-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-6 text-xs">
                      <div>
                        <dt className="text-zinc-500">CPU</dt>
                        <dd>{snap.cpuCores ?? '—'} 核</dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">内存可用</dt>
                        <dd>
                          {snap.memoryAvailableMb != null
                            ? `${(snap.memoryAvailableMb / 1024).toFixed(1)}G`
                            : '—'}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">Disk</dt>
                        <dd>{snap.diskUsedPercent != null ? `${snap.diskUsedPercent}%` : '—'}</dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">Runtime</dt>
                        <dd>{snap.runningRuntimeCount}</dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">Build / Deploy</dt>
                        <dd>
                          {snap.activeBuildCount} / {snap.activeDeploymentCount}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">Ports</dt>
                        <dd>{snap.allocatedPortCount}</dd>
                      </div>
                    </dl>
                  ) : (
                    <p className="mt-2 text-xs text-zinc-500">暂无容量快照</p>
                  )}
                </Card>
              );
            })}
          </div>
        </Section>
      ) : (
        <Section title="WORKSPACE_OWNED">
          <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
            <table className="w-full min-w-[800px] text-left text-sm">
              <thead className="border-b bg-zinc-50 text-xs text-zinc-500">
                <tr>
                  <th className="px-3 py-2">服务器</th>
                  <th className="px-3 py-2">Workspace</th>
                  <th className="px-3 py-2">Owner</th>
                  <th className="px-3 py-2">状态</th>
                  <th className="px-3 py-2">准备</th>
                  <th className="px-3 py-2">最近检查</th>
                </tr>
              </thead>
              <tbody>
                {data.owned.map((server) => (
                  <tr key={server.id} className="border-b border-zinc-50">
                    <td className="px-3 py-2 font-medium">{server.name}</td>
                    <td className="px-3 py-2">
                      {server.workspaceId ? (
                        <Link className="underline" href={`/admin/workspaces/${server.workspaceId}`}>
                          {server.workspaceName}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-2">{server.ownerEmail || '—'}</td>
                    <td className="px-3 py-2">
                      <StatusBadge status={server.status} />
                    </td>
                    <td className="px-3 py-2">{server.dockerStatus}</td>
                    <td className="px-3 py-2 text-xs text-zinc-500">
                      {new Date(server.updatedAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-zinc-500">不展示 SSH 密码 / 私钥 / 公网 IP。</p>
        </Section>
      )}
    </div>
  );
}
