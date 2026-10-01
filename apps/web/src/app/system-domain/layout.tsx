'use client';

import { PlatformAdminGate } from '@/components/platform-admin-gate';

export default function SystemDomainLayout({ children }: { children: React.ReactNode }) {
  return <PlatformAdminGate>{children}</PlatformAdminGate>;
}
