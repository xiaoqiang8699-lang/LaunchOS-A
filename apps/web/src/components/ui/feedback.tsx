import Link from 'next/link';
import { cn } from '@/lib/utils';
import { PrimaryLink } from './button';

export function InlineAlert({
  tone = 'warning',
  title,
  description,
  actionLabel,
  actionHref,
  className,
}: {
  tone?: 'warning' | 'error' | 'info' | 'success';
  title: string;
  description?: string;
  actionLabel?: string;
  actionHref?: string;
  className?: string;
}) {
  const tones = {
    warning: 'border-amber-200 bg-[var(--los-warning-bg)] text-[var(--los-warning)]',
    error: 'border-red-200 bg-[var(--los-error-bg)] text-[var(--los-error)]',
    info: 'border-blue-200 bg-[var(--los-info-bg)] text-[var(--los-info)]',
    success: 'border-emerald-200 bg-[var(--los-success-bg)] text-[var(--los-success)]',
  };
  return (
    <div className={cn('rounded-xl border px-4 py-3 text-sm', tones[tone], className)}>
      <p className="font-medium">{title}</p>
      {description ? <p className="mt-1 opacity-90">{description}</p> : null}
      {actionLabel && actionHref ? (
        <Link className="mt-2 inline-block font-medium underline" href={actionHref}>
          {actionLabel}
        </Link>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  actionLabel,
  actionHref,
}: {
  title: string;
  description: string;
  actionLabel?: string;
  actionHref?: string;
}) {
  return (
    <div className="rounded-xl border border-dashed border-[var(--los-border)] bg-white px-6 py-12 text-center">
      <h3 className="text-base font-semibold text-[var(--los-text)]">{title}</h3>
      <p className="mx-auto mt-2 max-w-md text-sm text-[var(--los-secondary)]">{description}</p>
      {actionLabel && actionHref ? (
        <div className="mt-5 flex justify-center">
          <PrimaryLink href={actionHref}>{actionLabel}</PrimaryLink>
        </div>
      ) : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn('animate-pulse rounded-md bg-zinc-200/80', className)}
      aria-hidden
    />
  );
}

export function UsageBar({
  label,
  used,
  limit,
  hint,
}: {
  label: string;
  used: number | null;
  limit: number | null;
  hint?: string;
}) {
  const percent =
    limit == null || used == null ? null : limit === 0 ? (used > 0 ? 100 : 0) : Math.round((used / limit) * 100);
  const near = percent != null && percent >= 80 && percent < 100;
  const over = percent != null && percent >= 100;
  return (
    <div className="rounded-xl border border-[var(--los-border)] bg-white p-4">
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium text-[var(--los-text)]">{label}</span>
        <span className="text-[var(--los-secondary)]">
          {limit == null ? '不限' : used == null ? '—' : `${used} / ${limit}`}
        </span>
      </div>
      {limit != null && used != null ? (
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-100">
          <div
            className={cn(
              'h-full rounded-full transition-all',
              over ? 'bg-red-500' : near ? 'bg-amber-500' : 'bg-zinc-900',
            )}
            style={{ width: `${Math.min(100, percent ?? 0)}%` }}
          />
        </div>
      ) : null}
      {near || over || hint ? (
        <p
          className={cn(
            'mt-2 text-xs',
            over ? 'text-[var(--los-error)]' : near ? 'text-[var(--los-warning)]' : 'text-[var(--los-muted)]',
          )}
        >
          {over ? '已达到套餐上限。' : near ? '接近套餐上限（≥80%）。' : hint}
        </p>
      ) : null}
    </div>
  );
}
