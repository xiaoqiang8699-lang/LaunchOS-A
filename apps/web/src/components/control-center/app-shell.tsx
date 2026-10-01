'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { clearAccessToken, getAccessToken } from '@/lib/auth';
import type { PublicUser, WorkspaceSummary } from '@/lib/types';
import { cn } from '@/lib/utils';
import { ToastProvider } from '@/components/ui/toast';

type NavItem = { href: string; label: string; match?: (path: string) => boolean };

const NAV_PRIMARY: NavItem[] = [
  { href: '/overview', label: '概览', match: (p) => p === '/overview' || p === '/dashboard' },
  {
    href: '/projects',
    label: '我的应用',
    match: (p) =>
      p === '/projects' ||
      p === '/apps' ||
      (p.startsWith('/projects/') && !p.startsWith('/projects/new')),
  },
  {
    href: '/activity',
    label: '上线记录',
    match: (p) => p === '/activity' || p.startsWith('/deployments'),
  },
  {
    href: '/resources',
    label: '运行资源',
    match: (p) => p === '/resources' || p.startsWith('/resources/') || p === '/servers' || p.startsWith('/servers/'),
  },
];

const NAV_WORKSPACE: NavItem[] = [
  { href: '/team', label: '团队', match: (p) => p === '/team' || p.startsWith('/team/') },
  { href: '/usage', label: '用量', match: (p) => p === '/usage' || p.startsWith('/usage/') },
  { href: '/plan', label: '套餐', match: (p) => p === '/plan' || p.startsWith('/plan/') },
  {
    href: '/billing',
    label: '账单',
    match: (p) => p === '/billing' || p.startsWith('/billing/'),
  },
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
    : pathname === item.href || pathname.startsWith(item.href);
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={cn(
        'block rounded-lg px-3 py-2 text-sm transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900',
        active
          ? 'bg-[var(--los-sidebar-active)] font-medium text-[var(--los-text)]'
          : 'text-[var(--los-secondary)] hover:bg-[var(--los-sidebar-active)] hover:text-[var(--los-text)]',
      )}
      aria-current={active ? 'page' : undefined}
    >
      {item.label}
    </Link>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [profile, setProfile] = useState<PublicUser | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceSummary | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const profileActive = pathname === '/profile' || pathname.startsWith('/profile/');

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }
    let cancelled = false;
    const deferred =
      typeof window !== 'undefined' &&
      window.sessionStorage.getItem('launchos-onboarding-console') === '1';
    void Promise.all([
      api<PublicUser>('/auth/profile'),
      api<WorkspaceSummary[]>('/workspaces').catch(() => [] as WorkspaceSummary[]),
    ])
      .then(([nextProfile, workspaces]) => {
        if (cancelled) return;
        const complete =
          nextProfile.onboardingStatus === 'COMPLETED' || nextProfile.hasCompletedOnboarding;
        setProfile(nextProfile);
        setWorkspace(workspaces[0] ?? null);
        if (!complete && !deferred && pathname !== '/onboarding') {
          router.replace('/onboarding');
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [pathname, router]);

  useEffect(() => {
    setOpen(false);
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    function onDocClick(event: MouseEvent) {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  function logout() {
    clearAccessToken();
    router.replace('/login');
  }

  const sidebar = (
    <aside className="flex h-full w-[232px] flex-col border-r border-[var(--los-border)] bg-[var(--los-sidebar)]">
      <div className="flex h-14 items-center gap-2 border-b border-[var(--los-border)] px-4">
        <Link href="/overview" className="text-sm font-semibold tracking-wide text-[var(--los-text)]">
          LaunchOS
        </Link>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto p-3" aria-label="主导航">
        {NAV_PRIMARY.map((item) => (
          <NavLink
            key={item.href + item.label}
            item={item}
            pathname={pathname}
            onNavigate={() => setOpen(false)}
          />
        ))}
        <div className="my-3 border-t border-[var(--los-border)]" />
        {NAV_WORKSPACE.map((item) => (
          <NavLink
            key={item.href + item.label}
            item={item}
            pathname={pathname}
            onNavigate={() => setOpen(false)}
          />
        ))}
        <div className="my-3 border-t border-[var(--los-border)]" />
        <Link
          href="/help"
          onClick={() => setOpen(false)}
          className="block rounded-lg px-3 py-2 text-sm text-[var(--los-secondary)] hover:bg-[var(--los-sidebar-active)] hover:text-[var(--los-text)]"
        >
          帮助
        </Link>
      </nav>
      <div className="border-t border-[var(--los-border)] p-3" ref={menuRef}>
        <div className="relative">
          <button
            type="button"
            className={cn(
              'flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900',
              profileActive || menuOpen
                ? 'bg-[var(--los-sidebar-active)]'
                : 'hover:bg-[var(--los-sidebar-active)]',
            )}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-900 text-xs font-medium text-white">
              {(profile?.name || '用').trim().charAt(0)}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-[var(--los-text)]">
                {profile?.name || '用户'}
              </p>
              <p className="truncate text-xs text-[var(--los-muted)]">
                {workspace?.name || '工作空间'}
              </p>
            </div>
          </button>
          {menuOpen ? (
            <div
              role="menu"
              className="absolute bottom-full left-0 z-50 mb-2 w-full min-w-[11rem] rounded-lg border border-[var(--los-border)] bg-white p-1 shadow-sm"
            >
              <Link
                role="menuitem"
                href="/profile"
                className="block rounded-md px-3 py-2 text-sm hover:bg-zinc-50"
                onClick={() => setMenuOpen(false)}
              >
                个人资料
              </Link>
              <Link
                role="menuitem"
                href="/profile/security"
                className="block rounded-md px-3 py-2 text-sm hover:bg-zinc-50"
                onClick={() => setMenuOpen(false)}
              >
                安全
              </Link>
              {profile?.platformRole === 'PLATFORM_ADMIN' ? (
                <Link
                  role="menuitem"
                  href="/admin"
                  className="block rounded-md px-3 py-2 text-sm hover:bg-zinc-50"
                  onClick={() => setMenuOpen(false)}
                >
                  进入运营后台
                </Link>
              ) : null}
              <button
                role="menuitem"
                type="button"
                className="block w-full rounded-md px-3 py-2 text-left text-sm text-red-700 hover:bg-red-50"
                onClick={logout}
              >
                退出登录
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </aside>
  );

  return (
    <ToastProvider>
      <div className="min-h-screen bg-[var(--los-page)]">
        <div className="flex h-14 items-center justify-between border-b border-[var(--los-border)] bg-white px-4 lg:hidden">
          <Link href="/overview" className="text-sm font-semibold">
            LaunchOS
          </Link>
          <button
            type="button"
            className="rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label="打开导航"
          >
            菜单
          </button>
        </div>

        <div className="lg:flex">
          <div className="hidden lg:fixed lg:inset-y-0 lg:flex lg:w-[232px]">{sidebar}</div>
          {open ? (
            <div className="fixed inset-0 z-40 lg:hidden">
              <button
                type="button"
                className="absolute inset-0 bg-black/30"
                aria-label="关闭导航"
                onClick={() => setOpen(false)}
              />
              <div className="absolute inset-y-0 left-0 z-50 shadow-xl">{sidebar}</div>
            </div>
          ) : null}

          <main className="min-h-screen flex-1 lg:pl-[232px]">
            <div className="mx-auto w-full max-w-[1040px] px-4 py-6 sm:px-6 sm:py-8">
              {children}
            </div>
          </main>
        </div>
      </div>
    </ToastProvider>
  );
}
