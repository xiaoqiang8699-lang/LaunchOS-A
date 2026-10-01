'use client';

import Link from 'next/link';
import { cn } from '@/lib/utils';

export function ProfileSubnav({ pathname }: { pathname: string }) {
  const items = [
    { href: '/profile', label: '个人资料', exact: true },
    { href: '/profile/security', label: '安全', exact: false },
  ];
  return (
    <nav className="mb-5 flex gap-1 border-b border-[var(--los-border)]" aria-label="个人资料导航">
      {items.map((item) => {
        const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'border-b-2 px-3 py-2 text-sm',
              active
                ? 'border-zinc-900 font-medium text-[var(--los-text)]'
                : 'border-transparent text-[var(--los-secondary)]',
            )}
            aria-current={active ? 'page' : undefined}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
