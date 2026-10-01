'use client';

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { ControlCenter } from '@/components/control-center';
import { Skeleton } from '@/components/ui/feedback';

function AccountRedirectInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const tab = searchParams.get('tab');
    if (tab === 'subscription') {
      router.replace('/plan');
      return;
    }
    if (tab === 'billing') {
      router.replace('/billing');
      return;
    }
    if (tab === 'team' || tab === 'members' || tab === 'member') {
      router.replace('/team');
      return;
    }
    if (tab === 'usage') {
      router.replace('/usage');
      return;
    }
    if (tab === 'security') {
      router.replace('/profile/security');
      return;
    }
    router.replace('/profile');
  }, [router, searchParams]);

  return (
    <ControlCenter>
      <Skeleton className="h-24" />
    </ControlCenter>
  );
}

export default function AccountCompatibilityPage() {
  return (
    <Suspense
      fallback={
        <ControlCenter>
          <Skeleton className="h-24" />
        </ControlCenter>
      }
    >
      <AccountRedirectInner />
    </Suspense>
  );
}
