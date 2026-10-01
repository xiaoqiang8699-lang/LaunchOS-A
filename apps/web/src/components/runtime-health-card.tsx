'use client';

import Link from 'next/link';
import { useState } from 'react';
import { StatusBadge } from '@/components/ui/status-badge';
import { writeClipboard } from '@/lib/clipboard';
import { PRODUCT_COPY } from '@/lib/product-language';
import type { AppHealth } from '@/lib/types';

function publicLabel(status: AppHealth['publicStatus']): string {
  if (status === 'OK') return PRODUCT_COPY.publicAccessOk;
  if (status === 'FAIL') return PRODUCT_COPY.publicAccessFail;
  if (status === 'N/A') return '—';
  return PRODUCT_COPY.publicAccessUnknown;
}

export function RuntimeHealthCard(props: {
  health: AppHealth | null;
  projectId: string;
  visitUrl?: string | null;
  canVisit?: boolean;
  loading?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const health = props.health;
  if (props.loading && !health) {
    return (
      <section className="rounded-xl border border-[var(--los-border)] bg-white p-5">
        <h2 className="text-sm font-medium text-[var(--los-secondary)]">
          {PRODUCT_COPY.runtimeStatusCard}
        </h2>
        <p className="mt-3 text-sm text-[var(--los-secondary)]">正在确认运行状态…</p>
      </section>
    );
  }
  if (!health) {
    return (
      <section className="rounded-xl border border-[var(--los-border)] bg-white p-5">
        <h2 className="text-sm font-medium text-[var(--los-secondary)]">
          {PRODUCT_COPY.runtimeStatusCard}
        </h2>
        <p className="mt-3 text-sm text-[var(--los-secondary)]">{PRODUCT_COPY.statusPendingHint}</p>
      </section>
    );
  }

  const visitUrl = props.visitUrl || health.visitUrl;

  return (
    <section className="rounded-xl border border-[var(--los-border)] bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-[var(--los-secondary)]">
          {PRODUCT_COPY.runtimeStatusCard}
        </h2>
        <StatusBadge status={health.overallStatus} label={health.overallLabel || undefined} />
      </div>

      <dl className="mt-4 grid gap-3 text-sm text-[var(--los-text)] sm:grid-cols-2">
        <div>
          <dt className="text-[var(--los-secondary)]">{PRODUCT_COPY.currentVersion}</dt>
          <dd className="mt-0.5 font-medium">
            {health.version || '—'}
            {health.restoredFrom ? (
              <span className="ml-2 text-xs font-normal text-[var(--los-secondary)]">
                {PRODUCT_COPY.restoreSourceLabel} {health.restoredFrom}
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="text-[var(--los-secondary)]">{PRODUCT_COPY.publicAccess}</dt>
          <dd className="mt-0.5 font-medium">{publicLabel(health.publicStatus)}</dd>
        </div>
        <div>
          <dt className="text-[var(--los-secondary)]">{PRODUCT_COPY.lastHealthCheck}</dt>
          <dd className="mt-0.5">
            {health.lastHealthCheckLabel ||
              health.lastPublicCheckLabel ||
              PRODUCT_COPY.waitingHealthCheck}
          </dd>
        </div>
        <div>
          <dt className="text-[var(--los-secondary)]">{PRODUCT_COPY.uptime}</dt>
          <dd className="mt-0.5">{health.uptimeLabel || '—'}</dd>
        </div>
      </dl>

      {visitUrl ? (
        <p className="mt-3 break-all text-sm text-[var(--los-secondary)]">
          {PRODUCT_COPY.visitUrl}：{visitUrl}
        </p>
      ) : null}

      {health.startupSummary ? (
        <p className="mt-3 text-sm text-[var(--los-secondary)]">
          {PRODUCT_COPY.startupSummaryTitle}：{health.startupSummary.label}
          {health.startupSummary.errorSummary ? ` — ${health.startupSummary.errorSummary}` : ''}
        </p>
      ) : null}

      {health.recentError ? (
        <div className="mt-3 rounded-lg border border-red-200 bg-[var(--los-error-bg)] px-4 py-3 text-sm text-[var(--los-error)]">
          <p className="font-medium">{PRODUCT_COPY.recentErrorTitle}</p>
          <p className="mt-1">{health.recentError}</p>
          {health.recommendedAction ? (
            <p className="mt-2">
              {PRODUCT_COPY.recommendedActionTitle}：{health.recommendedAction}
            </p>
          ) : null}
        </div>
      ) : health.overallStatus === 'HEALTHY' ? (
        <p className="mt-3 text-sm text-[var(--los-success)]">{PRODUCT_COPY.noRecentError}</p>
      ) : health.recommendedAction ? (
        <p className="mt-3 text-sm text-[var(--los-secondary)]">
          {PRODUCT_COPY.recommendedActionTitle}：{health.recommendedAction}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {props.canVisit && visitUrl ? (
          <a
            className="rounded-lg bg-[var(--los-action)] px-4 py-2 text-sm font-medium text-white"
            href={visitUrl}
            target="_blank"
            rel="noreferrer"
          >
            {PRODUCT_COPY.openApp}
          </a>
        ) : null}
        <Link
          className="rounded-lg border border-[var(--los-border)] px-4 py-2 text-sm text-[var(--los-text)]"
          href={`/projects/${props.projectId}/runtime`}
        >
          {PRODUCT_COPY.viewRuntimeDetails}
        </Link>
        {health.fixPrompt ? (
          <button
            className="rounded-lg border border-[var(--los-border)] px-4 py-2 text-sm text-[var(--los-text)]"
            type="button"
            onClick={() =>
              void writeClipboard(health.fixPrompt || '').then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 2000);
              })
            }
          >
            {copied ? PRODUCT_COPY.copiedVisitUrl : PRODUCT_COPY.copyFixPrompt}
          </button>
        ) : null}
      </div>
    </section>
  );
}
