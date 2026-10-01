'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { HealthHistory } from '@/components/app-health';
import { ControlCenter } from '@/components/control-center';
import { ProjectTabs } from '@/components/control-center/project-tabs';
import { RuntimeHealthCard } from '@/components/runtime-health-card';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { PageHeader } from '@/components/ui/section';
import { StatusBadge } from '@/components/ui/status-badge';
import { api } from '@/lib/api';
import { clearAccessToken, getAccessToken } from '@/lib/auth';
import { writeClipboard } from '@/lib/clipboard';
import { PRODUCT_COPY } from '@/lib/product-language';
import type { AppHealth, ProjectDetail, RuntimeLogsResponse } from '@/lib/types';

export default function ProjectRuntimePage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [health, setHealth] = useState<AppHealth | null>(null);
  const [logs, setLogs] = useState<RuntimeLogsResponse | null>(null);
  const [showTech, setShowTech] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [logTail, setLogTail] = useState(200);
  const [busyLogs, setBusyLogs] = useState(false);

  const loadHealth = useCallback(
    async (refreshPublic = false) => {
      const q = refreshPublic ? '?refreshPublic=1' : '';
      const payload = await api<AppHealth>(`/apps/${params.id}/runtime${q}`);
      setHealth(payload);
      return payload;
    },
    [params.id],
  );

  const loadLogs = useCallback(
    async (tail: number) => {
      setBusyLogs(true);
      try {
        const payload = await api<RuntimeLogsResponse>(`/apps/${params.id}/logs?tail=${tail}`);
        setLogs(payload);
      } finally {
        setBusyLogs(false);
      }
    },
    [params.id],
  );

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const detail = await api<ProjectDetail>(`/projects/${params.id}`);
        if (cancelled) return;
        setProject(detail);
        await loadHealth(true);
        await loadLogs(200);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : PRODUCT_COPY.statusPendingHint);
        if (err instanceof Error && /unauthorized|401|token/i.test(err.message)) {
          clearAccessToken();
          router.replace('/login');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    const timer = window.setInterval(() => {
      void loadHealth(false).catch(() => undefined);
    }, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [params.id, router, loadHealth, loadLogs]);

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
        <span className="text-[var(--los-text)]">{PRODUCT_COPY.runtimePageTitle}</span>
      </nav>

      <ProjectTabs projectId={params.id} />

      <PageHeader
        title={PRODUCT_COPY.runtimePageTitle}
        description={project?.name}
        action={
          health ? (
            <StatusBadge
              status={health.overallStatus}
              label={health.overallLabel || undefined}
            />
          ) : null
        }
      />

      {error ? <InlineAlert className="mb-4" tone="warning" title={error} /> : null}

      {loading && !health ? (
        <Skeleton className="mb-4 h-40" />
      ) : (
        <div className="flex flex-col gap-4">
          <RuntimeHealthCard
            health={health}
            projectId={params.id}
            visitUrl={health?.visitUrl}
            canVisit={Boolean(health?.visitUrl && health.publicStatus === 'OK')}
            loading={loading}
          />

          <HealthHistory health={health} />

          <section className="rounded-xl border border-[var(--los-border)] bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-medium text-[var(--los-secondary)]">
                  {PRODUCT_COPY.technicalLogs}
                </h2>
                <p className="mt-0.5 text-xs text-[var(--los-muted)]">默认收起，排查时再展开。</p>
              </div>
              <div className="flex gap-2">
                <button
                  className="rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm text-[var(--los-text)]"
                  type="button"
                  onClick={() => setShowTech((v) => !v)}
                >
                  {showTech ? '收起' : '展开'}
                </button>
                <button
                  className="rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm text-[var(--los-text)] disabled:opacity-50"
                  type="button"
                  disabled={busyLogs}
                  onClick={() => void loadLogs(logTail)}
                >
                  {busyLogs ? '加载中…' : PRODUCT_COPY.refreshLogs}
                </button>
              </div>
            </div>
            {!showTech ? (
              <p className="mt-3 text-sm text-[var(--los-secondary)]">
                {health?.startupSummary?.label ||
                  '运行摘要已准备就绪。需要排查时再展开技术日志。'}
              </p>
            ) : (
              <>
                <pre className="mt-3 max-h-96 overflow-auto rounded-xl bg-zinc-950 p-4 text-xs text-zinc-100">
                  {logs?.logs || PRODUCT_COPY.noLogsYet}
                </pre>
                <div className="mt-3 flex flex-wrap gap-2">
                  {logs?.truncated ? (
                    <button
                      className="rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm"
                      type="button"
                      onClick={() => {
                        const next = Math.min(logTail + 200, 500);
                        setLogTail(next);
                        void loadLogs(next);
                      }}
                    >
                      {PRODUCT_COPY.loadMoreLogs}
                    </button>
                  ) : null}
                  {logs?.logs ? (
                    <button
                      className="rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm"
                      type="button"
                      onClick={() => void writeClipboard(logs.logs)}
                    >
                      复制日志
                    </button>
                  ) : null}
                </div>
                {logs?.checkedAt ? (
                  <p className="mt-2 text-xs text-[var(--los-muted)]">
                    已加载 {logs.lineCount} 行 · {logs.checkedAt}
                  </p>
                ) : null}
              </>
            )}
          </section>
        </div>
      )}
    </ControlCenter>
  );
}
