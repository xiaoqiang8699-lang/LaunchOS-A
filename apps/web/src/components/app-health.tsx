import { PRODUCT_COPY } from '@/lib/product-language';
import {
  formatDateTime,
  HEALTH_STATUS_DOT_CLASS,
  HEALTH_STATUS_LABELS,
  statusBadgeClass,
} from '@/lib/project-labels';
import type { AppHealth, HealthStatus } from '@/lib/types';

export function HealthSummary(props: {
  status?: HealthStatus;
  lastCheckedAt?: string | null;
  responseTimeMs?: number | null;
  message?: string | null;
  compact?: boolean;
}) {
  const status = props.status ?? 'UNKNOWN';

  return (
    <div
      className={
        props.compact
          ? 'text-sm'
          : 'rounded-xl border border-[var(--los-border)] bg-white p-5'
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[var(--los-secondary)]">{PRODUCT_COPY.healthStatus}</p>
        <span className={`rounded-full px-2.5 py-1 text-xs ${statusBadgeClass(status)}`}>
          {HEALTH_STATUS_LABELS[status]}
        </span>
      </div>
      <dl className="mt-3 grid gap-3 text-sm text-[var(--los-text)] sm:grid-cols-2">
        <div>
          <dt className="text-[var(--los-secondary)]">{PRODUCT_COPY.lastHealthCheck}</dt>
          <dd className="mt-0.5">
            {props.lastCheckedAt ? formatDateTime(props.lastCheckedAt) : PRODUCT_COPY.waitingHealthCheck}
          </dd>
        </div>
        <div>
          <dt className="text-[var(--los-secondary)]">{PRODUCT_COPY.responseTime}</dt>
          <dd className="mt-0.5">
            {props.responseTimeMs != null ? `${props.responseTimeMs} ms` : '—'}
          </dd>
        </div>
      </dl>
      {props.message ? (
        <p className="mt-3 text-sm text-[var(--los-secondary)]">{props.message}</p>
      ) : null}
    </div>
  );
}

export function HealthHistory(props: { health: AppHealth | null }) {
  const history = props.health?.history ?? [];

  return (
    <section className="rounded-xl border border-[var(--los-border)] bg-white p-5">
      <h2 className="text-sm font-medium text-[var(--los-secondary)]">
        {PRODUCT_COPY.healthHistory}
      </h2>
      {history.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--los-secondary)]">
          {PRODUCT_COPY.waitingHealthCheck}
        </p>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap gap-2" aria-label="最近健康检测">
            {[...history].reverse().map((item) => (
              <span
                key={item.id}
                className={`h-3 w-3 rounded-full ${HEALTH_STATUS_DOT_CLASS[item.status]}`}
                title={`${formatDateTime(item.checkedAt)} · ${HEALTH_STATUS_LABELS[item.status]}${
                  item.responseTimeMs != null ? ` · ${item.responseTimeMs} ms` : ''
                }`}
              />
            ))}
          </div>
          <ul className="mt-4 space-y-2">
            {history.slice(0, 6).map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--los-border)] px-3.5 py-2.5 text-sm"
              >
                <span className="text-[var(--los-text)]">
                  {HEALTH_STATUS_LABELS[item.status]} · {item.message ?? '检测完成'}
                </span>
                <span className="text-[var(--los-secondary)]">
                  {item.responseTimeMs != null ? `${item.responseTimeMs} ms · ` : ''}
                  {formatDateTime(item.checkedAt)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
