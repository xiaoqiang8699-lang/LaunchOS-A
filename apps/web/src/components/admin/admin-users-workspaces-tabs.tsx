'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const TABS = [
  { href: '/admin/users', label: '用户' },
  { href: '/admin/workspaces', label: '工作空间' },
];

export function AdminUsersWorkspacesTabs() {
  const pathname = usePathname();
  return (
    <div className="flex gap-1 rounded-lg border border-zinc-200 bg-white p-1 w-fit">
      {TABS.map((tab) => {
        const active = pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm',
              active ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-zinc-50',
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
