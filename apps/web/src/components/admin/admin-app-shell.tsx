'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { clearAccessToken, getAccessToken } from '@/lib/auth';
import type { PublicUser } from '@/lib/types';
import { cn } from '@/lib/utils';
import { PlatformAdminGate } from '@/components/platform-admin-gate';

type NavItem = { href: string; label: string; match?: (path: string) => boolean };

const NAV_MAIN: NavItem[] = [
  { href: '/admin', label: '总览', match: (p) => p === '/admin' || p === '/admin/overview' },
  {
    href: '/admin/users',
    label: '用户与工作空间',
    match: (p) =>
      p.startsWith('/admin/users') ||
      p.startsWith('/admin/workspaces'),
  },
  { href: '/admin/apps', label: '应用', match: (p) => p.startsWith('/admin/apps') || p.startsWith('/admin/applications') },
  {
    href: '/admin/deployments',
    label: '部署',
    match: (p) => p.startsWith('/admin/deployments'),
  },
  {
    href: '/admin/resources',
    label: '运行资源',
    match: (p) => p.startsWith('/admin/resources'),
  },
  {
    href: '/admin/domains',
    label: '域名',
    match: (p) => p.startsWith('/admin/domains'),
  },
  {
    href: '/admin/beta',
    label: 'Beta 运营',
    match: (p) => p.startsWith('/admin/beta') || p.startsWith('/alpha-tests'),
  },
  {
    href: '/admin/commercial',
    label: '商业与订阅',
    match: (p) =>
      p.startsWith('/admin/commercial') ||
      p.startsWith('/admin/subscriptions') ||
      p.startsWith('/admin/plans') ||
      p.startsWith('/admin/orders') ||
      p.startsWith('/admin/payments') ||
      p.startsWith('/admin/billing') ||
      p.startsWith('/admin/invoices') ||
      p.startsWith('/admin/upgrade-requests') ||
      p.startsWith('/admin/payment-providers'),
  },
];

const NAV_SYSTEM: NavItem[] = [
  {
    href: '/admin/system',
    label: '系统运行',
    match: (p) => p.startsWith('/admin/system') || p.startsWith('/admin/runtime'),
  },
  { href: '/admin/audit', label: '审计与安全', match: (p) => p.startsWith('/admin/audit') },
];

function NavLink({
  item,
  pathname,
  onNavigate,
}: {
  item: NavItem;
  pathname: string;
  onNavigate?: () => void;
}) {
  const active = item.match
    ? item.match(pathname)
    : pathname === item.href || pathname.startsWith(`${item.href}/`);
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={cn(
        'block rounded-lg px-3 py-2 text-sm transition',
        active
          ? 'bg-zinc-800 font-medium text-white'
          : 'text-zinc-300 hover:bg-zinc-800/70 hover:text-white',
      )}
      aria-current={active ? 'page' : undefined}
    >
      {item.label}
    </Link>
  );
}

export function AdminAppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState<PublicUser | null>(null);

  useEffect(() => {
    if (!getAccessToken()) return;
    void api<PublicUser>('/auth/profile')
      .then(setProfile)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  function logout() {
    clearAccessToken();
    router.replace('/login');
  }

  const sidebar = (
    <aside className="flex h-full w-[248px] flex-col border-r border-zinc-800 bg-zinc-950 text-zinc-100">
      <div className="border-b border-zinc-800 px-4 py-4">
        <p className="text-sm font-semibold tracking-wide">LaunchOS</p>
        <p className="mt-0.5 text-xs text-zinc-400">运营后台</p>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto p-3" aria-label="运营导航">
        {NAV_MAIN.map((item) => (
          <NavLink key={item.href} item={item} pathname={pathname} onNavigate={() => setOpen(false)} />
        ))}
        <div className="my-3 border-t border-zinc-800" />
        {NAV_SYSTEM.map((item) => (
          <NavLink key={item.href} item={item} pathname={pathname} onNavigate={() => setOpen(false)} />
        ))}
        <div className="my-3 border-t border-zinc-800" />
        <Link
          href="/overview"
          onClick={() => setOpen(false)}
          className="block rounded-lg px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800/70 hover:text-white"
        >
          返回用户控制台
        </Link>
      </nav>
      <div className="border-t border-zinc-800 p-3">
        <div className="flex items-center gap-2 rounded-lg px-2 py-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-700 text-xs font-medium">
            {(profile?.name || '管').trim().charAt(0)}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{profile?.name || '管理员'}</p>
            <p className="truncate text-xs text-zinc-400">{profile?.email || 'PLATFORM_ADMIN'}</p>
          </div>
        </div>
        <button
          type="button"
          className="mt-1 w-full rounded-lg px-3 py-2 text-left text-sm text-red-300 hover:bg-zinc-800"
          onClick={logout}
        >
          退出登录
        </button>
      </div>
    </aside>
  );

  return (
    <PlatformAdminGate>
      <div className="min-h-screen bg-zinc-100">
        <div className="flex h-12 items-center justify-between border-b border-zinc-200 bg-white px-4 lg:hidden">
          <div>
            <p className="text-sm font-semibold">LaunchOS</p>
            <p className="text-xs text-zinc-500">运营后台</p>
          </div>
          <button
            type="button"
            className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            菜单
          </button>
        </div>

        <div className="lg:flex">
          <div className="hidden lg:fixed lg:inset-y-0 lg:flex lg:w-[248px]">{sidebar}</div>
          {open ? (
            <div className="fixed inset-0 z-40 lg:hidden">
              <button
                type="button"
                className="absolute inset-0 bg-black/40"
                aria-label="关闭导航"
                onClick={() => setOpen(false)}
              />
              <div className="absolute inset-y-0 left-0 z-50 shadow-xl">{sidebar}</div>
            </div>
          ) : null}

          <main className="min-h-screen flex-1 lg:pl-[248px]">
            <div className="mx-auto w-full max-w-[1200px] px-4 py-5 sm:px-6 sm:py-6">{children}</div>
          </main>
        </div>
      </div>
    </PlatformAdminGate>
  );
}
