'use client';

import { Suspense, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { OnboardingLayout } from '@/components/onboarding-layout';
import { getAccessToken } from '@/lib/auth';

/**
 * Onboarding source step now reuses the canonical create flow at /projects/new.
 * Keep this route as a thin compatibility entry for old links / resume.
 */
function SourceRedirectInner() {
  const router = useRouter();

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }
    router.replace('/projects/new?from=onboarding');
  }, [router]);

  return (
    <OnboardingLayout>
      <p className="text-sm text-zinc-500">正在进入统一创建流程…</p>
    </OnboardingLayout>
  );
}

export default function OnboardingSourcePage() {
  return (
    <Suspense
      fallback={
        <OnboardingLayout>
          <p className="text-sm text-zinc-500">加载中…</p>
        </OnboardingLayout>
      }
    >
      <SourceRedirectInner />
    </Suspense>
  );
}
