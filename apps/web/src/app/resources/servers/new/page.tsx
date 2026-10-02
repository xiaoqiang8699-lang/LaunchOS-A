'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ControlCenter } from '@/components/control-center';
import { Skeleton } from '@/components/ui/feedback';

/** Legacy full-page entry — redirect into resources modal flow. */
export default function ConnectServerPageRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/resources?connect=1');
  }, [router]);

  return (
    <ControlCenter>
      <Skeleton className="h-40" />
      <p className="mt-3 text-sm text-[var(--los-secondary)]">正在打开连接服务器…</p>
    </ControlCenter>
  );
}
