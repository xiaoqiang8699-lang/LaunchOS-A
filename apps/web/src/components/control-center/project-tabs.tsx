'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const TABS = [
  { href: '', label: '概览' },
  { href: '/deployments', label: '上线记录' },
  { href: '/versions', label: '版本' },
  { href: '/runtime', label: '运行状态' },
  { href: '/config', label: '配置' },
  { href: '/domains', label: '域名与访问' },
  { href: '/settings', label: '设置' },
] as const;

export function ProjectTabs({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const base = `/projects/${projectId}`;
  return (
    <nav
      className="-mx-1 mb-6 flex gap-1 overflow-x-auto border-b border-[var(--los-border)] pb-px"
      aria-label="应用导航"
    >
      {TABS.map((tab) => {
        const href = `${base}${tab.href}`;
        const active =
          tab.href === ''
            ? pathname === base
            : pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={tab.href || 'overview'}
            href={href}
            className={cn(
              'shrink-0 border-b-2 px-3 py-2.5 text-sm transition',
              active
                ? 'border-zinc-900 font-medium text-[var(--los-text)]'
                : 'border-transparent text-[var(--los-secondary)] hover:text-[var(--los-text)]',
            )}
            aria-current={active ? 'page' : undefined}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
