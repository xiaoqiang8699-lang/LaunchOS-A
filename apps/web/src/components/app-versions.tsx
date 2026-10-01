'use client';

import { useMemo, useState } from 'react';
import { StatusBadge } from '@/components/ui/status-badge';
import { ConfirmDialog } from '@/components/ui/toast';
import { PRODUCT_COPY } from '@/lib/product-language';
import {
  APPLICATION_VERSION_STATUS_LABELS,
  formatDateTime,
} from '@/lib/project-labels';
import type { ApplicationVersion } from '@/lib/types';

export function AppVersions(props: {
  versions: ApplicationVersion[];
  busyId: string | null;
  onRollback: (versionId: string) => void;
  showRollback?: boolean;
  title?: string;
  canRollback?: boolean;
}) {
  const showRollback = props.showRollback !== false && props.canRollback !== false;
  const title = props.title ?? PRODUCT_COPY.versionHistory;
  const [filter, setFilter] = useState<string>('all');
  const [confirmTarget, setConfirmTarget] = useState<ApplicationVersion | null>(null);
  const filters = useMemo(() => {
    const names = Array.from(
      new Set(props.versions.map((item) => item.unitName).filter(Boolean) as string[]),
    );
    return ['all', ...names];
  }, [props.versions]);
  const visible = props.versions.filter((item) => {
    if (filter === 'all') return true;
    return item.unitName === filter;
  });

  function canShowRestore(item: ApplicationVersion): boolean {
    if (!showRollback || item.isCurrent) return false;
    if (item.status === 'FAILED' || item.status === 'DEPLOYING') return false;
    if (item.rollbackable === false) return false;
    if (item.rollbackable === true) return true;
    return true;
  }

  return (
    <section id="versions" className="rounded-xl border border-[var(--los-border)] bg-white p-5">
      <h2 className="text-sm font-medium text-[var(--los-secondary)]">{title}</h2>
      {filters.length > 2 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {filters.map((item) => (
            <button
              key={item}
              className={`rounded-full px-3 py-1 text-xs ${
                filter === item
                  ? 'bg-[var(--los-action)] text-white'
                  : 'bg-[var(--los-neutral-bg)] text-[var(--los-secondary)]'
              }`}
              type="button"
              onClick={() => setFilter(item)}
            >
              {item === 'all' ? '全部' : item}
            </button>
          ))}
        </div>
      ) : null}
      {visible.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--los-secondary)]">{PRODUCT_COPY.noVersions}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {visible.map((item) => {
            const restored =
              item.restoredFrom ||
              (/^恢复自\s+/.test(item.commitMessage || '')
                ? item.commitMessage.replace(/^恢复自\s+/, '')
                : null);
            const rollbackable = canShowRestore(item);
            return (
              <li
                key={item.id}
                className="rounded-lg border border-[var(--los-border)] px-4 py-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="font-medium text-[var(--los-text)]">
                    {item.unitName ? `${item.unitName} · ` : ''}
                    {item.version}
                  </p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {item.isCurrent ? (
                      <span className="rounded-full bg-[var(--los-success-bg)] px-2 py-0.5 text-xs font-medium text-[var(--los-success)]">
                        {PRODUCT_COPY.currentlyRunningBadge}
                      </span>
                    ) : (
                      <StatusBadge
                        status={item.status}
                        label={APPLICATION_VERSION_STATUS_LABELS[item.status]}
                      />
                    )}
                    {restored ? (
                      <span className="rounded-full bg-[var(--los-info-bg)] px-2 py-0.5 text-xs text-[var(--los-info)]">
                        恢复自 {restored}
                      </span>
                    ) : null}
                    {rollbackable ? (
                      <span className="rounded-full bg-[var(--los-neutral-bg)] px-2 py-0.5 text-xs text-[var(--los-secondary)]">
                        可回滚
                      </span>
                    ) : null}
                  </div>
                </div>
                <p className="mt-1 text-sm text-[var(--los-secondary)]">
                  {PRODUCT_COPY.codeVersion}：
                  {item.commitSha ? item.commitSha.slice(0, 7) : '未知'}
                </p>
                {restored ? (
                  <p className="mt-1 text-sm text-[var(--los-secondary)]">
                    {PRODUCT_COPY.restoreSourceLabel}：{restored}
                  </p>
                ) : item.commitMessage ? (
                  <p className="mt-1 text-sm text-[var(--los-secondary)]">
                    {PRODUCT_COPY.commitMessage}：{item.commitMessage}
                  </p>
                ) : null}
                <p className="mt-1 text-xs text-[var(--los-muted)]">
                  {formatDateTime(item.createdAt)}
                </p>
                {rollbackable ? (
                  <button
                    className="mt-3 rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm text-[var(--los-text)] disabled:opacity-50"
                    type="button"
                    disabled={Boolean(props.busyId)}
                    onClick={() => setConfirmTarget(item)}
                  >
                    {props.busyId === item.id
                      ? PRODUCT_COPY.rollingBack
                      : PRODUCT_COPY.rollback}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={Boolean(confirmTarget)}
        title={
          confirmTarget
            ? PRODUCT_COPY.restoreConfirmTitle.replace('{version}', confirmTarget.version)
            : ''
        }
        description={[
          PRODUCT_COPY.restoreConfirmHint1,
          PRODUCT_COPY.restoreConfirmHint2,
          PRODUCT_COPY.restoreConfirmHint3,
        ].join(' ')}
        confirmLabel={PRODUCT_COPY.restoreConfirmOk}
        cancelLabel={PRODUCT_COPY.restoreConfirmCancel}
        busy={Boolean(props.busyId)}
        onCancel={() => setConfirmTarget(null)}
        onConfirm={() => {
          if (!confirmTarget) return;
          const id = confirmTarget.id;
          setConfirmTarget(null);
          props.onRollback(id);
        }}
      />
    </section>
  );
}
