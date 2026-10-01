'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AppVersions } from '@/components/app-versions';
import { ControlCenter } from '@/components/control-center';
import { ProjectTabs } from '@/components/control-center/project-tabs';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/section';
import { api, ApiError } from '@/lib/api';
import { clearAccessToken, getAccessToken } from '@/lib/auth';
import { PRODUCT_COPY } from '@/lib/product-language';
import type { ApplicationVersion, DeploymentDetail, ProjectDetail } from '@/lib/types';

export default function ProjectVersionsPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [versions, setVersions] = useState<ApplicationVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
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
        const [detail, list] = await Promise.all([
          api<ProjectDetail>(`/projects/${params.id}`),
          api<ApplicationVersion[]>(`/apps/${params.id}/versions`),
        ]);
        if (cancelled) return;
        setProject(detail);
        setVersions(list);
      } catch (err) {
        if (cancelled) return;
        if (!getAccessToken()) {
          router.replace('/login');
          return;
        }
        setError(PRODUCT_COPY.loadVersionsFailed);
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

  async function handleRollback(versionId: string): Promise<void> {
    if (busyId) return;
    setBusyId(versionId);
    setActionError(null);
    try {
      const created = await api<DeploymentDetail & { rollback?: { fromVersion?: string } }>(
        `/apps/${params.id}/rollback/${versionId}`,
        { method: 'POST' },
      );
      router.push(`/deployments/${created.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'DEPLOYMENT_ALREADY_RUNNING') {
        setActionError(PRODUCT_COPY.concurrentDeployBusy);
      } else {
        setActionError(err instanceof Error ? err.message : '恢复失败');
      }
      setBusyId(null);
    }
  }

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
        <span className="text-[var(--los-text)]">{PRODUCT_COPY.allVersionsTitle}</span>
      </nav>

      <ProjectTabs projectId={params.id} />

      <PageHeader
        title={PRODUCT_COPY.allVersionsTitle}
        description={project ? project.name : undefined}
      />

      {actionError ? <InlineAlert className="mb-4" tone="warning" title={actionError} /> : null}

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : error ? (
        <div className="space-y-3">
          <InlineAlert tone="warning" title={error} />
          <button
            className="rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm"
            type="button"
            onClick={() => setReloadToken((n) => n + 1)}
          >
            重试
          </button>
        </div>
      ) : (
        <AppVersions
          versions={versions}
          busyId={busyId}
          onRollback={(id) => void handleRollback(id)}
          showRollback
          canRollback
          title={PRODUCT_COPY.allVersionsTitle}
        />
      )}
    </ControlCenter>
  );
}
