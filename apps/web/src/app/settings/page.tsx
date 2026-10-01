'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ProductNav } from '@/components/product-nav';
import { api, ApiError } from '@/lib/api';
import { clearAccessToken, getAccessToken } from '@/lib/auth';
import type { PublicUser, SystemDnsProviderConfig } from '@/lib/types';

type CertificateSummary = {
  tlsStatus: string;
  renewalMode: string;
  dnsProviderConfigured: boolean;
};

type DomainStatusSummary = {
  rootDomain: string;
  dnsStatus: string;
};

export default function SettingsPage() {
  const router = useRouter();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<{
    rootDomain: string;
    dnsLabel: string;
    httpsLabel: string;
    renewalLabel: string;
  } | null>(null);
  const [deployService, setDeployService] = useState<{
    label: string;
    workerOnline: boolean;
    lastSeenAt: string | null;
  } | null>(null);

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }

    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const profile = await api<PublicUser>('/auth/profile');
        if (profile.platformRole !== 'PLATFORM_ADMIN') {
          router.replace('/account');
          return;
        }
        if (!cancelled) {
          setAllowed(true);
        }

        const [dnsConfig, certificate, domainStatus, queueStatus] = await Promise.all([
          api<SystemDnsProviderConfig>('/system-domain/dns-provider'),
          api<CertificateSummary>('/system-domain/certificate'),
          api<DomainStatusSummary>('/system-domain/status'),
          api<{
            workerOnline: boolean;
            workerLastSeenAt: string | null;
            deployService: { status: string; label: string };
          }>('/system/queue-status').catch(() => null),
        ]);

        if (cancelled) return;

        const dnsOk =
          domainStatus.dnsStatus === 'ACTIVE' || Boolean(dnsConfig.dnsProviderAccountId);
        const httpsOk = certificate.tlsStatus === 'ACTIVE';
        const automaticOn = dnsConfig.renewalMode === 'AUTOMATIC_DNS';

        setSummary({
          rootDomain: dnsConfig.rootDomain || domainStatus.rootDomain,
          dnsLabel: dnsOk ? '已启用' : '未就绪',
          httpsLabel: httpsOk ? '正常' : '未就绪',
          renewalLabel: automaticOn ? '已开启' : '未开启',
        });
        if (queueStatus) {
          setDeployService({
            label: queueStatus.deployService.label,
            workerOnline: queueStatus.workerOnline,
            lastSeenAt: queueStatus.workerLastSeenAt,
          });
        }
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
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (allowed === null) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-50 text-sm text-zinc-500">
        加载中…
      </main>
    );
  }

  if (!allowed) {
    return (
      <main className="min-h-screen bg-zinc-50 px-6 py-10">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          <ProductNav />
          <section className="rounded-xl border border-amber-200 bg-amber-50 p-6">
            <h1 className="text-xl font-semibold text-amber-950">无权限</h1>
            <p className="mt-2 text-sm text-amber-900">
              平台资源仅平台管理员可访问。
            </p>
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

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <ProductNav />
        <div>
            <h1 className="text-3xl font-semibold text-zinc-900">平台资源</h1>
          <p className="mt-2 text-sm text-zinc-600">管理 LaunchOS 平台级配置（仅管理员）。</p>
        </div>

        {error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        <Link
          href="/system-domain"
          className="block rounded-xl border border-zinc-200 bg-white p-5 shadow-sm transition hover:border-zinc-400"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-medium text-zinc-900">系统域名与 HTTPS</h2>
              <p className="mt-1 text-sm text-zinc-500">
                管理 LaunchOS 系统访问域名、DNS 和证书自动续期。
              </p>
            </div>
            <span className="text-sm text-zinc-400">→</span>
          </div>
          {summary ? (
            <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-zinc-500">系统域名</dt>
                <dd className="mt-0.5 font-medium text-zinc-900">{summary.rootDomain}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">DNS</dt>
                <dd className="mt-0.5 font-medium text-zinc-900">{summary.dnsLabel}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">HTTPS</dt>
                <dd className="mt-0.5 font-medium text-zinc-900">{summary.httpsLabel}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">自动续期</dt>
                <dd className="mt-0.5 font-medium text-zinc-900">{summary.renewalLabel}</dd>
              </div>
            </dl>
          ) : (
            <p className="mt-4 text-sm text-zinc-400">加载状态摘要…</p>
          )}
        </Link>

        <section className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-medium text-zinc-900">部署服务</h2>
          <p className="mt-1 text-sm text-zinc-500">上线任务队列与后台执行服务状态（高级）。</p>
          {deployService ? (
            <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-zinc-500">状态</dt>
                <dd
                  className={`mt-0.5 font-medium ${
                    deployService.workerOnline ? 'text-emerald-700' : 'text-amber-700'
                  }`}
                >
                  {deployService.label}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">执行服务</dt>
                <dd className="mt-0.5 font-medium text-zinc-900">
                  {deployService.workerOnline ? '在线' : '离线'}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">最近心跳</dt>
                <dd className="mt-0.5 font-medium text-zinc-900">
                  {deployService.lastSeenAt
                    ? new Date(deployService.lastSeenAt).toLocaleString()
                    : '无'}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="mt-4 text-sm text-zinc-400">加载部署服务状态…</p>
          )}
        </section>

        <Link
          href="/settings/cloud-accounts"
          className="block rounded-xl border border-zinc-200 bg-white p-5 shadow-sm transition hover:border-zinc-400"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-medium text-zinc-900">平台云账号</h2>
              <p className="mt-1 text-sm text-zinc-500">
                阿里云云资源账户、权限就绪检测（与 DNS 账户分离）。
              </p>
            </div>
            <span className="text-sm text-zinc-400">→</span>
          </div>
        </Link>

        <Link
          href="/cloud-resources"
          className="block rounded-xl border border-zinc-200 bg-white p-5 shadow-sm transition hover:border-zinc-400"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-medium text-zinc-900">平台云资源</h2>
              <p className="mt-1 text-sm text-zinc-500">查看与创建云服务器资源（管理员工具）。</p>
            </div>
            <span className="text-sm text-zinc-400">→</span>
          </div>
        </Link>

        <section className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-medium text-zinc-900">平台 DNS / 证书 / 队列</h2>
          <p className="mt-1 text-sm text-zinc-500">
            DNS 与证书在系统域名页管理。部署队列与 Worker 状态见上方部署服务，也在平台管理的系统运行中。
          </p>
        </section>
      </div>
    </main>
  );
}
