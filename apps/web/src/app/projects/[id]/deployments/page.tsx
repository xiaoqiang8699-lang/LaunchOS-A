'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ControlCenter } from '@/components/control-center';
import { ProjectTabs } from '@/components/control-center/project-tabs';
import { EmptyState, InlineAlert, Skeleton } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/section';
import { StatusBadge } from '@/components/ui/status-badge';
import { api } from '@/lib/api';
import { clearAccessToken, getAccessToken } from '@/lib/auth';
import { PRODUCT_COPY } from '@/lib/product-language';
import {
  ACTIVE_DEPLOYMENT_STATUSES,
  DEPLOYMENT_STATUS_LABELS,
  formatDateTime,
} from '@/lib/project-labels';
import type {
  ApplicationVersion,
  DeploymentSummary,
  ProjectDetail,
} from '@/lib/types';

function launchStatusLabel(status: DeploymentSummary['status']): string {
  if (status === 'SUCCESS') return PRODUCT_COPY.liveSuccessShort;
  if (status === 'FAILED') return PRODUCT_COPY.goLiveFailed;
  if (ACTIVE_DEPLOYMENT_STATUSES.includes(status)) return PRODUCT_COPY.goingLive;
  return DEPLOYMENT_STATUS_LABELS[status];
}

export default function ProjectLaunchHistoryPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [deployments, setDeployments] = useState<DeploymentSummary[]>([]);
  const [currentDeploymentId, setCurrentDeploymentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }

    let cancelled = false;

    async function load(): Promise<void> {
      setLoading(true);
      setError(null);
      try {
        const [detail, list, versions] = await Promise.all([
          api<ProjectDetail>(`/projects/${params.id}`),
          api<DeploymentSummary[]>(`/projects/${params.id}/deployments`),
          api<ApplicationVersion[]>(`/apps/${params.id}/versions`).catch(() => []),
        ]);
        if (cancelled) return;
        setProject(detail);
        setDeployments(list);
        const current = versions.find((item) => item.isCurrent) ?? null;
        setCurrentDeploymentId(current?.deploymentId ?? null);
      } catch (err) {
        if (cancelled) return;
        if (!getAccessToken()) {
          router.replace('/login');
          return;
        }
        setError(PRODUCT_COPY.loadLaunchHistoryFailed);
        if (err instanceof Error && /unauthorized|401|token/i.test(err.message)) {
          clearAccessToken();
          router.replace('/login');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [params.id, router, reloadToken]);

  return (
    <ControlCenter>
      <nav className="mb-4 text-sm text-[var(--los-secondary)]">
        <Link className="hover:text-[var(--los-text)]" href="/projects">
          我的应用
        </Link>
        <span className="mx-2">›</span>
        <Link className="hover:text-[var(--los-text)]" href={`/projects/${params.id}`}>
          {project?.name ?? '应用'}
        </Link>
        <span className="mx-2">›</span>
        <span className="text-[var(--los-text)]">{PRODUCT_COPY.launchHistory}</span>
      </nav>

      <ProjectTabs projectId={params.id} />

      <PageHeader
        title={PRODUCT_COPY.launchHistory}
        description={project ? project.name : undefined}
      />

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      ) : error ? (
        <InlineAlert
          tone="warning"
          title={error}
          description="请稍后重试。"
        />
      ) : deployments.length === 0 ? (
        <EmptyState
          title={PRODUCT_COPY.noLaunchHistory}
          description="完成一次上线后，记录会出现在这里。"
          actionLabel={PRODUCT_COPY.goLive}
          actionHref={`/projects/${params.id}/go-live`}
        />
      ) : (
        <ul className="space-y-2">
          {deployments.map((deployment) => {
            const isCurrent = currentDeploymentId === deployment.id;
            const href =
              deployment.status === 'SUCCESS'
                ? `/deployments/${deployment.id}/success`
                : `/deployments/${deployment.id}`;
            const versionLabel = deployment.version ?? deployment.releaseLabel ?? '上线';
            const commitShort = deployment.sourceRevision
              ? deployment.sourceRevision.slice(0, 7)
              : null;
            return (
              <li
                key={deployment.id}
                className="rounded-xl border border-[var(--los-border)] bg-white px-4 py-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-base font-semibold text-[var(--los-text)]">
                        {versionLabel.startsWith('v') ? versionLabel : `v${versionLabel}`}
                      </p>
                      <StatusBadge
                        status={deployment.status}
                        label={launchStatusLabel(deployment.status)}
                      />
                      {isCurrent ? (
                        <span className="rounded-full bg-[var(--los-success-bg)] px-2 py-0.5 text-xs font-medium text-[var(--los-success)]">
                          {PRODUCT_COPY.currentlyRunning}
                        </span>
                      ) : null}
                    </div>
                    <p className="text-sm text-[var(--los-secondary)]">
                      {commitShort ? (
                        <>
                          {PRODUCT_COPY.codeVersion} {commitShort}
                          <span className="mx-1.5 text-[var(--los-muted)]">·</span>
                        </>
                      ) : null}
                      {formatDateTime(deployment.finishedAt ?? deployment.createdAt)}
                    </p>
                    {deployment.status === 'FAILED' && deployment.errorMessage ? (
                      <p className="text-sm text-[var(--los-warning)]">{deployment.errorMessage}</p>
                    ) : null}
                  </div>
                  <Link
                    className="shrink-0 rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm text-[var(--los-text)] hover:bg-[var(--los-sidebar-active)]"
                    href={href}
                  >
                    查看详情
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {error && !loading ? (
        <button
          className="mt-4 rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm"
          type="button"
          onClick={() => setReloadToken((n) => n + 1)}
        >
          重试
        </button>
      ) : null}
    </ControlCenter>
  );
}
