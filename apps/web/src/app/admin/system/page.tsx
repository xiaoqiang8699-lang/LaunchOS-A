'use client';

import { useEffect, useState } from 'react';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { Card, PageHeader, Section } from '@/components/ui/section';
import { api } from '@/lib/api';

type Runtime = {
  workerOnline: boolean;
  lastSeenAt: string | null;
  queues: Record<string, boolean>;
  capacity?: {
    queueDepth?: {
      deploymentQueue?: { waiting: number; active: number; failed: number };
    };
    limits?: Record<string, number>;
    warnings?: Array<{ serverId: string; code: string }>;
    servers?: Array<{
      id: string;
      name: string | null;
      host: string;
      status: string;
      admission: string;
      diskWarning: boolean;
      diskCritical: boolean;
    }>;
  } | null;
  githubConnection?: {
    status: string;
    ready: boolean;
    diagnosis: string | null;
  };
};

export default function AdminSystemPage() {
  const [data, setData] = useState<Runtime | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void api<Runtime>('/admin/system')
      .then(setData)
      .catch(() =>
        api<Runtime>('/admin/runtime')
          .then(setData)
          .catch((err: unknown) => setError(err instanceof Error ? err.message : '加载失败')),
      );
  }, []);

  if (error) return <InlineAlert tone="error" title={error} />;
  if (!data) return <Skeleton className="h-64" />;

  const queue = data.capacity?.queueDepth?.deploymentQueue;

  return (
    <div className="space-y-5">
      <PageHeader title="系统运行" description="Workers、Queues、Capacity、Data Plane、Gateway" />

      <Section title="Workers">
        <Card className="p-4 text-sm">
          <p className="font-medium">launchos-alpha-worker</p>
          <p className="mt-1">{data.workerOnline ? 'ONLINE' : 'OFFLINE / STALE'}</p>
          <p className="mt-1 text-zinc-500">
            最近心跳：{data.lastSeenAt ? new Date(data.lastSeenAt).toLocaleString() : '无'}
          </p>
        </Card>
      </Section>

      <Section title="Queues">
        <Card className="space-y-2 p-4 text-sm">
          {Object.entries(data.queues).map(([name, ready]) => (
            <p key={name}>
              {name}：{ready ? 'ready' : 'not ready'}
            </p>
          ))}
          <div className="mt-3 border-t pt-3">
            <p>deploymentQueue waiting：{queue?.waiting ?? '—'}</p>
            <p>deploymentQueue active：{queue?.active ?? '—'}</p>
            <p>deploymentQueue failed：{queue?.failed ?? '—'}</p>
          </div>
        </Card>
      </Section>

      <Section title="Capacity">
        <div className="space-y-2">
          {(data.capacity?.servers || []).map((server) => (
            <Card key={server.id} className="p-4 text-sm">
              <p className="font-medium">{server.name || server.host}</p>
              <p className="mt-1">
                {server.host} · {server.admission || server.status}
                {server.diskCritical ? ' · Disk Critical' : server.diskWarning ? ' · Disk Warning' : ''}
              </p>
            </Card>
          ))}
          {(data.capacity?.warnings || []).length > 0 ? (
            <InlineAlert
              tone="warning"
              title={`容量告警 ${data.capacity?.warnings?.length}`}
              description={(data.capacity?.warnings || []).map((w) => w.code).join(' / ')}
            />
          ) : null}
        </div>
      </Section>

      <Section title="Data Plane / Gateway">
        <Card className="space-y-2 p-4 text-sm">
          <p>PostgreSQL：由平台托管（状态由运行心跳间接反映）</p>
          <p>Redis / Queue：见上方 Queues</p>
          <p>Gateway：通过域名中心与公网异常应用监控</p>
          <p className="text-zinc-500">不显示 DATABASE_URL / password / 证书私钥。</p>
        </Card>
      </Section>

      <Section title="Cleanup">
        <Card className="p-4 text-sm text-zinc-600">
          Cleanup 仅只读展示。OPS-1 不提供手动危险 cleanup 按钮。
        </Card>
      </Section>

      {data.githubConnection ? (
        <Section title="GitHub 连接能力">
          <Card className="p-4 text-sm">
            <p>{data.githubConnection.ready ? 'READY' : data.githubConnection.status}</p>
            {data.githubConnection.diagnosis ? (
              <p className="mt-1 text-amber-700">{data.githubConnection.diagnosis}</p>
            ) : null}
          </Card>
        </Section>
      ) : null}
    </div>
  );
}
