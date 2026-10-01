'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ControlCenter } from '@/components/control-center';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { Card, PageHeader, Section } from '@/components/ui/section';
import { PrimaryLink, SecondaryButton } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import { PRODUCT_COPY } from '@/lib/product-language';
import { SERVER_INSTANCE_STATUS_LABELS, SERVER_READY_LABELS } from '@/lib/project-labels';
import type { AppSummary, ServerInstance } from '@/lib/types';

export default function ResourcesPage() {
  const router = useRouter();
  const [servers, setServers] = useState<ServerInstance[] | null>(null);
  const [apps, setApps] = useState<AppSummary[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }
    void Promise.all([
      api<ServerInstance[]>('/servers'),
      api<AppSummary[]>('/apps').catch(() => [] as AppSummary[]),
    ])
      .then(([nextServers, nextApps]) => {
        setServers(nextServers);
        setApps(nextApps);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '加载失败'));
  }, [router]);

  const managedRunning = useMemo(
    () =>
      (apps || []).filter(
        (app) =>
          app.applicationStatus === 'RUNNING' &&
          (app.hostingMode === 'launchos' || !app.hostingMode),
      ).length,
    [apps],
  );

  return (
    <ControlCenter>
      <PageHeader
        title="运行资源"
        description="管理 LaunchOS 自动托管与你自己的服务器"
      />

      {error ? <InlineAlert tone="error" title={error} /> : null}

      {!servers || !apps ? (
        <div className="grid gap-3">
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
        </div>
      ) : (
        <>
          <Section title="LaunchOS 自动托管">
            <Card className="p-5">
              <p className="text-sm text-[var(--los-secondary)]">
                默认情况下，LaunchOS 会为你的应用提供运行环境，无需自行购买或管理服务器。
              </p>
              <div className="mt-4 flex flex-wrap gap-6 text-sm">
                <div>
                  <p className="text-[var(--los-secondary)]">状态</p>
                  <p className="mt-1 font-medium">
                    <StatusBadge tone="success" label="可用" />
                  </p>
                </div>
                <div>
                  <p className="text-[var(--los-secondary)]">当前运行应用</p>
                  <p className="mt-1 text-lg font-semibold">{managedRunning}</p>
                </div>
              </div>
            </Card>
          </Section>

          <Section className="mt-8" title="自己的服务器">
            <Card className="p-5">
              <p className="text-sm text-[var(--los-secondary)]">
                如果你已有云服务器，也可以连接到 LaunchOS。连接后可在上线方案中选择运行位置。
              </p>
              <div className="mt-4">
                <PrimaryLink href="/resources/servers/new">连接服务器</PrimaryLink>
              </div>

              {servers.length === 0 ? (
                <p className="mt-5 text-sm text-[var(--los-muted)]">还没有连接自己的服务器。</p>
              ) : (
                <ul className="mt-5 space-y-3">
                  {servers.map((server) => (
                    <li
                      key={server.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--los-border)] px-4 py-3"
                    >
                      <div>
                        <p className="font-medium">{server.name}</p>
                        <p className="mt-1 text-xs text-[var(--los-secondary)]">
                          {SERVER_INSTANCE_STATUS_LABELS[server.status] ?? server.status}
                          {' · '}
                          {SERVER_READY_LABELS[server.dockerStatus] ?? PRODUCT_COPY.serverUnknown}
                        </p>
                        <p className="mt-1 text-xs text-[var(--los-muted)]">规格摘要：自有服务器</p>
                      </div>
                      <SecondaryButton
                        type="button"
                        onClick={() => router.push(`/resources/servers/${server.id}`)}
                      >
                        管理
                      </SecondaryButton>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </Section>
        </>
      )}
    </ControlCenter>
  );
}
