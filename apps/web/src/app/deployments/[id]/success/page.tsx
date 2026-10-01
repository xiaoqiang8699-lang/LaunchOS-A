'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ProductNav } from '@/components/product-nav';
import { VisitUrlBlock } from '@/components/visit-url';
import { api } from '@/lib/api';
import { clearAccessToken, getAccessToken } from '@/lib/auth';
import { PRODUCT_COPY } from '@/lib/product-language';
import { ACTIVE_DEPLOYMENT_STATUSES } from '@/lib/project-labels';
import type { DeploymentExperience } from '@/lib/types';

export default function DeploymentSuccessPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [experience, setExperience] = useState<DeploymentExperience | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }

    let cancelled = false;
    api<DeploymentExperience>(`/deployments/${params.id}/experience`)
      .then((payload) => {
        if (cancelled) {
          return;
        }
        if (ACTIVE_DEPLOYMENT_STATUSES.includes(payload.deployment.status)) {
          router.replace(`/deployments/${params.id}`);
          return;
        }
        if (payload.deployment.status !== 'SUCCESS') {
          router.replace(`/deployments/${params.id}`);
          return;
        }
        setExperience(payload);
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
  }, [params.id, router]);

  if (!experience) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-50 text-sm text-zinc-500">
        {error ?? '加载中…'}
      </main>
    );
  }

  const info = experience.success;

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <ProductNav />
        <div>
          <Link
            className="text-sm text-zinc-500"
            href={`/projects/${experience.deployment.projectId}`}
          >
            ← 返回应用
          </Link>
          <h1 className="mt-2 text-3xl font-semibold text-zinc-900">
            {experience.deployment.isRollback
              ? PRODUCT_COPY.restoreSuccessTitle
              : PRODUCT_COPY.liveSuccess}
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            {info.accessEntryPending
              ? `${experience.deployment.projectName} 已在 LaunchOS 托管服务器上运行。`
              : `${experience.deployment.projectName} 已经可以访问了。`}
          </p>
        </div>

        <section className="rounded-2xl border border-emerald-200 bg-white p-6">
          <h2 className="text-sm font-medium text-emerald-700">
            {info.accessEntryPending ? '运行中' : '可以访问了'}
          </h2>
          <dl className="mt-4 space-y-3 text-sm text-zinc-700">
            {experience.deployment.version ? (
              <div>
                <dt className="text-zinc-500">{PRODUCT_COPY.currentVersion}</dt>
                <dd className="mt-1 font-medium text-zinc-900">
                  {experience.deployment.version}
                  <span className="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">
                    {PRODUCT_COPY.currentlyRunningBadge}
                  </span>
                </dd>
              </div>
            ) : null}
            {experience.deployment.restoredFrom ? (
              <div>
                <dt className="text-zinc-500">{PRODUCT_COPY.restoreSourceLabel}</dt>
                <dd className="mt-1 font-medium text-zinc-900">
                  {experience.deployment.restoredFrom}
                </dd>
              </div>
            ) : null}
            <div>
              <dt className="text-zinc-500">{PRODUCT_COPY.hostingLocation}</dt>
              <dd className="mt-1 font-medium text-zinc-900">
                {info.hostingLabel ||
                  (info.hostingMode === 'my-server'
                    ? PRODUCT_COPY.hostingMyServer
                    : PRODUCT_COPY.hostingLaunchos)}
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500">{PRODUCT_COPY.visitUrl}</dt>
              <dd className="mt-1">
                {info.accessEntryPending ? (
                  <div className="space-y-1">
                    <p className="font-medium text-zinc-800">
                      {info.accessEntryMessage || PRODUCT_COPY.accessEntryPending}
                    </p>
                    <p className="text-xs text-zinc-500">{PRODUCT_COPY.accessEntryPendingHint}</p>
                  </div>
                ) : (
                  <VisitUrlBlock
                    visitUrl={info.visitUrl}
                    localVisitUrl={info.localVisitUrl}
                    preparing={info.visitUrlPreparing}
                    ready={info.visitUrlReady}
                  />
                )}
              </dd>
            </div>
          </dl>
          <div className="mt-6 flex flex-wrap gap-2">
            {info.visitUrlReady && info.visitUrl ? (
              <a
                className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white"
                href={info.visitUrl}
                target="_blank"
                rel="noreferrer"
              >
                {PRODUCT_COPY.visitApp}
              </a>
            ) : null}
            <Link
              className="rounded-lg border border-zinc-200 px-4 py-2 text-sm text-zinc-700"
              href={`/projects/${experience.deployment.projectId}`}
            >
              {PRODUCT_COPY.backToApp.replace(/^←\s*/, '')}
            </Link>
            <Link
              className="rounded-lg border border-zinc-200 px-4 py-2 text-sm text-zinc-700"
              href="/dashboard?tab=apps"
            >
              查看全部应用
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
