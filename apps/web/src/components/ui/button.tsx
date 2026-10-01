import { cn } from '@/lib/utils';

export function PrimaryButton({
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center rounded-lg bg-[var(--los-action)] px-3.5 py-2 text-sm font-medium text-white transition hover:bg-[var(--los-action-hover)] disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export function SecondaryButton({
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center rounded-lg border border-[var(--los-border)] bg-white px-3.5 py-2 text-sm font-medium text-[var(--los-text)] transition hover:bg-[var(--los-sidebar-active)] disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export function DangerButton({
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center rounded-lg border border-red-200 bg-[var(--los-error-bg)] px-3.5 py-2 text-sm font-medium text-[var(--los-error)] transition hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export function PrimaryLink({
  className,
  href,
  children,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a
      href={href}
      className={cn(
        'inline-flex items-center justify-center rounded-lg bg-[var(--los-action)] px-3.5 py-2 text-sm font-medium text-white transition hover:bg-[var(--los-action-hover)]',
        className,
      )}
      {...props}
    >
      {children}
    </a>
  );
}

export function SecondaryLink({
  className,
  href,
  children,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a
      href={href}
      className={cn(
        'inline-flex items-center justify-center rounded-lg border border-[var(--los-border)] bg-white px-3.5 py-2 text-sm font-medium text-[var(--los-text)] transition hover:bg-[var(--los-sidebar-active)]',
        className,
      )}
      {...props}
    >
      {children}
    </a>
  );
}
