'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { clearAccessToken, getAccessToken } from '@/lib/auth';
import { PRODUCT_COPY } from '@/lib/product-language';
import { SERVER_INSTANCE_STATUS_LABELS, SERVER_READY_LABELS } from '@/lib/project-labels';
import type { ServerInstance } from '@/lib/types';

function providerLabel(provider: string): string {
  if (provider === 'CUSTOM') {
    return '自有服务器';
  }
  if (provider === 'ALIYUN') {
    return '阿里云';
  }
  return provider;
}

export function WorkspaceServersPanel() {
  const router = useRouter();
  const [servers, setServers] = useState<ServerInstance[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }

    let cancelled = false;
    api<ServerInstance[]>('/servers')
      .then((result) => {
        if (!cancelled) {
          setServers(result);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        clearAccessToken();
        setError(err instanceof Error ? err.message : '加载失败');
        router.replace('/login');
      });

    return () => {
      cancelled = true;
    };
  }, [router]);

  if (!servers) {
    return <p className="text-sm text-zinc-500">{error ?? '加载中…'}</p>;
  }

  if (servers.length === 0) {
    return (
      <section className="rounded-2xl border border-zinc-200 bg-white px-6 py-16 text-center">
        <h2 className="text-lg font-medium text-zinc-900">还没有服务器</h2>
        <p className="mt-2 text-sm text-zinc-500">添加一台服务器，用于部署你的应用。</p>
        <Link
          className="mt-6 inline-flex rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white"
          href="/servers"
        >
          {PRODUCT_COPY.addServer}
        </Link>
      </section>
    );
  }

  return (
    <ul className="space-y-3">
      {servers.map((server) => (
        <li key={server.id}>
          <Link
            className="block rounded-2xl border border-zinc-200 bg-white px-5 py-4 hover:border-zinc-300"
            href="/servers"
          >
            <div className="flex items-center justify-between gap-3">
              <p className="font-medium text-zinc-900">{server.name}</p>
              <span className="shrink-0 rounded-full bg-zinc-100 px-2.5 py-1 text-xs text-zinc-700">
                {SERVER_INSTANCE_STATUS_LABELS[server.status] ?? server.status}
              </span>
            </div>
            <dl className="mt-3 space-y-1 text-sm text-zinc-500">
              <div>
                地址：{server.host}:{server.port}
              </div>
              {server.provider ? <div>来源：{providerLabel(server.provider)}</div> : null}
              <div>
                运行准备：{SERVER_READY_LABELS[server.dockerStatus] ?? PRODUCT_COPY.serverUnknown}
              </div>
            </dl>
          </Link>
        </li>
      ))}
    </ul>
  );
}
