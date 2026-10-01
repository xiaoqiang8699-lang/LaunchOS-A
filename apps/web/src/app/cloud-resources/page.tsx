'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ProductNav } from '@/components/product-nav';
import { api, ApiError } from '@/lib/api';
import { clearAccessToken, getAccessToken } from '@/lib/auth';
import {
  CLOUD_RESOURCE_STATUS_LABELS,
  CLOUD_RESOURCE_TYPE_LABELS,
  statusBadgeClass,
} from '@/lib/project-labels';
import { isWorkspaceAdmin } from '@/lib/workspace-role';
import type { CloudResource, ProviderAccount, WorkspaceSummary } from '@/lib/types';

export default function CloudResourcesPage() {
  const router = useRouter();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [resources, setResources] = useState<CloudResource[] | null>(null);
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }

    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const workspaces = await api<WorkspaceSummary[]>('/workspaces');
        if (!isWorkspaceAdmin(workspaces[0]?.role)) {
          if (!cancelled) setAllowed(false);
          return;
        }
        if (!cancelled) setAllowed(true);

        const [resourceList, accountList] = await Promise.all([
          api<CloudResource[]>('/cloud-resources'),
          api<ProviderAccount[]>('/provider-accounts'),
        ]);
        if (cancelled) return;
        setResources(resourceList);
        setAccounts(accountList);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 403) {
          setAllowed(false);
          return;
        }
        if (err instanceof ApiError && err.status === 401) {
          clearAccessToken();
          router.replace('/login');
          return;
        }
        setError(err instanceof Error ? err.message : '加载失败');
        setAllowed(true);
        setResources([]);
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [router]);

  async function ensureMockAccount(): Promise<ProviderAccount> {
    const existing = accounts[0];
    if (existing) {
      return existing;
    }
    const created = await api<ProviderAccount>('/provider-accounts', {
      method: 'POST',
      body: JSON.stringify({
        providerType: 'MOCK',
        region: 'local',
        credential: 'mock-credential',
      }),
    });
    setAccounts([created]);
    return created;
  }

  async function createMockServer(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await ensureMockAccount();
      await api<CloudResource>('/cloud-resources', {
        method: 'POST',
        body: JSON.stringify({ type: 'SERVER', region: 'local' }),
      });
      const [resourceList, accountList] = await Promise.all([
        api<CloudResource[]>('/cloud-resources'),
        api<ProviderAccount[]>('/provider-accounts'),
      ]);
      setResources(resourceList);
      setAccounts(accountList);
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建资源失败');
    } finally {
      setPending(false);
    }
  }

  if (allowed === false) {
    return (
      <main className="min-h-screen bg-zinc-50 px-6 py-10">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          <ProductNav />
          <section className="rounded-xl border border-amber-200 bg-amber-50 p-6">
            <h1 className="text-xl font-semibold text-amber-950">无权限</h1>
            <p className="mt-2 text-sm text-amber-900">云资源仅工作区管理员可访问。</p>
            <Link
              className="mt-4 inline-flex rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white"
              href="/dashboard"
            >
              返回工作台
            </Link>
          </section>
        </div>
      </main>
    );
  }

  if (allowed === null || !resources) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-50 text-sm text-zinc-500">
        {error ?? '加载中…'}
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <ProductNav />
        <div className="flex items-center justify-between">
          <div>
            <nav className="text-sm text-zinc-500">
              <Link className="hover:text-zinc-800" href="/settings">
                系统设置
              </Link>
              <span className="mx-2">›</span>
              <span className="text-zinc-800">云资源</span>
            </nav>
            <h1 className="mt-2 text-3xl font-semibold text-zinc-900">云资源</h1>
            <p className="mt-1 text-sm text-zinc-500">管理员工具：查看与创建云服务器资源。</p>
          </div>
          <button
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
            type="button"
            onClick={() => void createMockServer()}
            disabled={pending}
          >
            {pending ? '创建中…' : '创建体验服务器'}
          </button>
        </div>

        {error ? <p className="text-sm text-red-600">{error}</p> : null}

        {resources.length === 0 ? (
          <section className="rounded-2xl border border-zinc-200 bg-white p-6 text-sm text-zinc-500">
            当前还没有云资源。
          </section>
        ) : (
          <ul className="space-y-3">
            {resources.map((resource) => (
              <li
                key={resource.id}
                className="rounded-2xl border border-zinc-200 bg-white px-5 py-4 text-sm"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="font-medium text-zinc-900">
                    {resource.provider.name} · {CLOUD_RESOURCE_TYPE_LABELS[resource.type]}
                  </p>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${statusBadgeClass(resource.status)}`}>
                    {CLOUD_RESOURCE_STATUS_LABELS[resource.status]}
                  </span>
                </div>
                <p className="mt-2 text-zinc-500">区域：{resource.region ?? '-'}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
