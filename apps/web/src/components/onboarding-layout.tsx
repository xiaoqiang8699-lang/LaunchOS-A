'use client';

import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { clearAccessToken } from '@/lib/auth';

export function OnboardingLayout({ children }: { children: ReactNode }) {
  const router = useRouter();

  function logout(): void {
    clearAccessToken();
    router.replace('/login');
  }

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
        <header className="flex items-center justify-between">
          <p className="text-sm font-semibold tracking-wide text-zinc-900">LaunchOS</p>
          <div className="flex items-center gap-3">
            <span className="text-sm text-zinc-400">帮助</span>
            <button className="text-sm text-zinc-600" type="button" onClick={logout}>
              退出
            </button>
          </div>
        </header>
        {children}
      </div>
    </main>
  );
}
