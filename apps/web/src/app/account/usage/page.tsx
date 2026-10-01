'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ControlCenter } from '@/components/control-center';
import { Skeleton } from '@/components/ui/feedback';

export default function AccountUsageRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/usage');
  }, [router]);
  return (
    <ControlCenter>
      <Skeleton className="h-24" />
    </ControlCenter>
  );
}
