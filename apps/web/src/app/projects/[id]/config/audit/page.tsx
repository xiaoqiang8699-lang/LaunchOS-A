'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ControlCenter } from '@/components/control-center';
import { ProjectTabs } from '@/components/control-center/project-tabs';
import { InlineAlert, Skeleton, EmptyState } from '@/components/ui/feedback';
import { Card, PageHeader } from '@/components/ui/section';
import { api, ApiError } from '@/lib/api';
import { clearAccessToken, getAccessToken } from '@/lib/auth';
import { formatDateTime } from '@/lib/project-labels';

type AuditEvent = {
  id: string;
  key: string;
  action: string;
  scopeType: string;
  scopeId: string;
  deployableUnitId: string | null;
  actorName: string | null;
  createdAt: string;
  metadata: Record<string, unknown> | null;
};

const ACTION_LABELS: Record<string, string> = {
  CREATED: '创建',
  UPDATED: '更新',
  DELETED: '删除',
  PROMOTED_TO_PROJECT: '提升为共享',
  RESTORED_SHARED: '恢复共享',
};

export default function ConfigAuditPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await api<{ events: AuditEvent[] }>(`/projects/${params.id}/config/audit`);
    setEvents(data.events);
  }, [params.id]);

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        await load();
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          clearAccessToken();
          router.replace('/login');
          return;
        }
        setError(err instanceof Error ? err.message : '加载失败');
        setEvents([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load, router]);

  return (
    <ControlCenter>
      <nav className="mb-4 text-sm text-[var(--los-secondary)]">
        <Link className="hover:text-[var(--los-text)]" href={`/projects/${params.id}/config`}>
          ← 返回配置
        </Link>
      </nav>
      <ProjectTabs projectId={params.id} />
      <PageHeader
        title="配置变更审计"
        description="仅记录操作元数据，不包含任何 Secret 明文或密文。"
      />

      {error ? <InlineAlert className="mb-4" tone="error" title={error} /> : null}

      {events == null ? (
        <Skeleton className="h-28" />
      ) : events.length === 0 ? (
        <EmptyState title="暂无审计记录" description="配置变更后会出现在这里。" />
      ) : (
        <Card className="p-4">
          <ul className="space-y-2">
            {events.map((event) => (
              <li
                key={event.id}
                className="rounded-lg border border-[var(--los-border)] px-3.5 py-3"
              >
                <p className="font-medium text-[var(--los-text)]">{event.key}</p>
                <p className="mt-1 text-sm text-[var(--los-secondary)]">
                  {ACTION_LABELS[event.action] ?? event.action}
                  {' · '}
                  {event.scopeType === 'PROJECT' ? '应用共享' : '组成配置'}
                  {' · '}
                  {event.actorName ?? '未知用户'}
                </p>
                <p className="mt-1 text-xs text-[var(--los-muted)]">
                  {formatDateTime(event.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </ControlCenter>
  );
}
