'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { clearAccessToken, getAccessToken } from '@/lib/auth';
import type { PublicUser, WorkspaceSummary } from '@/lib/types';
import { workspaceRoleLabel } from '@/lib/workspace-role';

function avatarInitial(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.charAt(0) : '用';
}

function isWorkspaceNavActive(pathname: string): boolean {
  return (
    pathname === '/dashboard' ||
    pathname.startsWith('/projects') ||
    pathname.startsWith('/servers') ||
    pathname.startsWith('/deployments') ||
    pathname.startsWith('/apps')
  );
}

export function ProductNav() {
  const pathname = usePathname();
  const router = useRouter();
  const menuRef = useRef<HTMLDivElement>(null);
  const [onboardingComplete, setOnboardingComplete] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [profile, setProfile] = useState<PublicUser | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceSummary | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!getAccessToken()) {
      return;
    }
    let cancelled = false;
    const deferred = window.sessionStorage.getItem('launchos-onboarding-console') === '1';
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
        setOnboardingComplete(complete);
        setShowAdmin(complete && nextProfile.platformRole === 'PLATFORM_ADMIN');
        if (!complete && !deferred && pathname !== '/onboarding') {
          router.replace('/onboarding');
        }
      })
      .catch(() => {
        if (!cancelled) setShowAdmin(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pathname, router]);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    function onPointerDown(event: MouseEvent): void {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  function logout(): void {
    clearAccessToken();
    router.replace('/login');
  }

  const workspaceActive = isWorkspaceNavActive(pathname);
  const accountActive = pathname === '/account' || pathname.startsWith('/account/');
  const onProductPage =
    pathname === '/dashboard' ||
    pathname.startsWith('/projects') ||
    pathname.startsWith('/account') ||
    pathname.startsWith('/servers') ||
    pathname.startsWith('/deployments') ||
    pathname.startsWith('/apps');
  const showPrimaryNav = onboardingComplete || onProductPage;

  return (
    <header className="mb-6 flex items-center justify-between gap-3">
      <Link
        className="shrink-0 text-sm font-semibold tracking-wide text-zinc-900"
        href="/dashboard"
      >
        LaunchOS
      </Link>
      <div className="flex min-w-0 items-center justify-end gap-1 sm:gap-2">
        {showPrimaryNav ? (
          <nav className="flex items-center gap-1">
            <Link
              className={`rounded-lg px-2 py-1.5 text-sm sm:px-3 ${
                workspaceActive ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-zinc-100'
              }`}
              href="/dashboard"
            >
              工作台
            </Link>
            <Link
              className={`rounded-lg px-2 py-1.5 text-sm sm:px-3 ${
                accountActive ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-zinc-100'
              }`}
              href="/account"
            >
              账户
            </Link>
          </nav>
        ) : null}
        <div className="relative" ref={menuRef}>
          <button
            className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-900 text-sm font-medium text-white"
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="打开账户菜单"
            onClick={() => setMenuOpen((current) => !current)}
          >
            {profile ? avatarInitial(profile.name) : '·'}
          </button>
          {menuOpen ? (
            <div
              className="absolute right-0 z-30 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-zinc-200 bg-white p-2 shadow-lg"
              role="menu"
            >
              {profile ? (
                <div className="px-3 py-2">
                  <p className="truncate text-sm font-medium text-zinc-900">{profile.name}</p>
                  <p className="mt-0.5 break-all text-sm text-zinc-500">{profile.email}</p>
                </div>
              ) : (
                <p className="px-3 py-2 text-sm text-zinc-500">加载中…</p>
              )}
              {workspace ? (
                <div className="border-t border-zinc-100 px-3 py-2">
                  <p className="truncate text-sm text-zinc-900">{workspace.name}</p>
                  <p className="mt-0.5 text-sm text-zinc-500">
                    {workspaceRoleLabel(workspace.role)}
                  </p>
                </div>
              ) : null}
              <div className="mt-1 border-t border-zinc-100 pt-1">
                <Link
                  className="block rounded-lg px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
                  href="/account?tab=profile"
                  role="menuitem"
                  onClick={() => setMenuOpen(false)}
                >
                  账户设置
                </Link>
                {showAdmin ? (
                  <Link
                    className="block rounded-lg px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
                    href="/admin"
                    role="menuitem"
                    onClick={() => setMenuOpen(false)}
                  >
                    平台管理
                  </Link>
                ) : null}
                <button
                  className="block w-full rounded-lg px-3 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-50"
                  type="button"
                  role="menuitem"
                  onClick={logout}
                >
                  退出登录
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
