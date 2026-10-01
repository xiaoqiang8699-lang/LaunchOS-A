'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** Legacy /servers → canonical /resources */
export default function ServersRedirectPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/resources');
  }, [router]);
  return (
    <main className="flex min-h-screen items-center justify-center text-sm text-zinc-500">
      正在跳转到运行资源…
    </main>
  );
}
