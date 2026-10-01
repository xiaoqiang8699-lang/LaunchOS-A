'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import type { PublicUser } from '@/lib/types';

export function PlatformAdminGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }
    void api<PublicUser>('/auth/profile')
      .then((profile) => {
        const complete = profile.onboardingStatus === 'COMPLETED' || profile.hasCompletedOnboarding;
        if (!complete) {
          router.replace('/onboarding');
          return;
        }
        if (profile.platformRole !== 'PLATFORM_ADMIN') {
          router.replace('/overview');
          return;
        }
        setAllowed(true);
      })
      .catch(() => router.replace('/login'));
  }, [router]);

  if (!allowed) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-50 text-sm text-zinc-500">
        加载中…
      </main>
    );
  }

  return <>{children}</>;
}
