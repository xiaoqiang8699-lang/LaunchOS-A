'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const TABS: Array<{ href: string; label: string; exact?: boolean }> = [
  { href: '/admin/ai-growth', label: '运营摘要', exact: true },
  { href: '/admin/ai-growth/issues', label: '部署问题' },
  { href: '/admin/ai-growth/deployment-issues', label: '失败统计' },
  { href: '/admin/ai-growth/preflight', label: '部署预检' },
  { href: '/admin/ai-growth/knowledge', label: '部署知识库' },
  { href: '/admin/ai-growth/success', label: '成功率分析' },
  { href: '/admin/ai-growth/opportunities', label: '升级机会' },
];

export function AdminAiGrowthTabs() {
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
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
