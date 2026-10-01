'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ControlCenter } from '@/components/control-center';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { Card, PageHeader } from '@/components/ui/section';
import { DangerButton, SecondaryButton } from '@/components/ui/button';
import { api, ApiError } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import { PRODUCT_COPY } from '@/lib/product-language';
import { SERVER_INSTANCE_STATUS_LABELS, SERVER_READY_LABELS } from '@/lib/project-labels';
import type { ServerConnectionTest, ServerInstance } from '@/lib/types';

export default function ManageServerPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [server, setServer] = useState<ServerInstance | null>(null);
  const [probe, setProbe] = useState<ServerConnectionTest | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }
    void api<ServerInstance>(`/servers/${params.id}`)
      .then(setServer)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '加载失败'));
  }, [params.id, router]);

  async function testConnection(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const result = await api<ServerConnectionTest>(`/servers/${params.id}/test-connection`, {
        method: 'POST',
      });
      setProbe(result);
      setServer(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '测试失败');
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      await api(`/servers/${params.id}`, { method: 'DELETE' });
      router.replace('/resources');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '删除失败');
      setBusy(false);
    }
  }

  return (
    <ControlCenter>
      <PageHeader
        title="管理服务器"
        description="测试连接、查看准备状态"
        action={
          <Link className="text-sm underline" href="/resources">
            返回运行资源
          </Link>
        }
      />

      {!server && !error ? <Skeleton className="h-40" /> : null}
      {error ? <InlineAlert tone="error" title={error} /> : null}

      {server ? (
        <Card className="space-y-4 p-5">
          <div>
            <p className="text-xs text-[var(--los-secondary)]">名称</p>
            <p className="mt-1 text-lg font-semibold">{server.name}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 text-sm">
            <div>
              <p className="text-[var(--los-secondary)]">状态</p>
              <p className="mt-1 font-medium">
                {SERVER_INSTANCE_STATUS_LABELS[server.status] ?? server.status}
              </p>
            </div>
            <div>
              <p className="text-[var(--los-secondary)]">运行准备</p>
              <p className="mt-1 font-medium">
                {SERVER_READY_LABELS[server.dockerStatus] ?? PRODUCT_COPY.serverUnknown}
              </p>
            </div>
          </div>
          <p className="text-xs text-[var(--los-muted)]">
            为保护安全，列表默认不展示 IP 与凭据。凭据仅加密存储，接口不会明文返回。
          </p>

          {probe ? (
            <InlineAlert
              tone={probe.diagnosis?.canDeploy ? 'success' : 'warning'}
              title={
                probe.diagnosis?.canDeploy
                  ? '准备完成'
                  : probe.connected
                    ? '需要初始化'
                    : '连接失败'
              }
              description={probe.diagnosis?.summary}
            />
          ) : null}

          <div className="flex flex-wrap gap-2">
            <SecondaryButton type="button" disabled={busy} onClick={() => void testConnection()}>
              {busy ? PRODUCT_COPY.checkingServer : PRODUCT_COPY.checkServer}
            </SecondaryButton>
            <DangerButton type="button" disabled={busy} onClick={() => void remove()}>
              删除服务器
            </DangerButton>
          </div>
        </Card>
      ) : null}
    </ControlCenter>
  );
}
