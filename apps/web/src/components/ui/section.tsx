import { cn } from '@/lib/utils';

export function Card({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-xl border border-[var(--los-border)] bg-[var(--los-card)]',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function Section({
  title,
  description,
  action,
  children,
  className,
}: {
  title?: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('space-y-3', className)}>
      {(title || action) && (
        <div className="flex items-start justify-between gap-3">
          <div>
            {title ? (
              <h2 className="text-lg font-semibold text-[var(--los-text)]">{title}</h2>
            ) : null}
            {description ? (
              <p className="mt-0.5 text-sm text-[var(--los-secondary)]">{description}</p>
            ) : null}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h1 className="text-[26px] font-semibold tracking-tight text-[var(--los-text)] sm:text-[28px]">
          {title}
        </h1>
        {description ? (
          <p className="mt-1 text-sm text-[var(--los-secondary)]">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
