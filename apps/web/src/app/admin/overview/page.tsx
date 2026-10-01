'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function AdminOverviewRedirectPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/admin');
  }, [router]);
  return <p className="text-sm text-zinc-500">正在打开平台总览…</p>;
}
