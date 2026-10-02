'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const TABS: Array<{ href: string; label: string; exact?: boolean }> = [
  { href: '/admin/growth', label: '增长总览', exact: true },
  { href: '/admin/growth/onboarding', label: '用户激活' },
  { href: '/admin/growth/usage', label: '产品使用' },
  { href: '/admin/growth/journey', label: '用户旅程' },
  { href: '/admin/growth/commercial', label: '商业分析' },
];

export function AdminGrowthTabs() {
  const pathname = usePathname();
  return (
    <div className="flex flex-wrap gap-2 border-b border-zinc-200 pb-3">
      {TABS.map((tab) => {
        const active = tab.exact
          ? pathname === tab.href
          : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              'rounded-lg px-3 py-1.5 text-sm transition',
              active
                ? 'bg-zinc-900 font-medium text-white'
                : 'border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50',
            )}
            aria-current={active ? 'page' : undefined}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
