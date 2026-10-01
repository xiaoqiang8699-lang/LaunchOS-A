'use client';

import { PlatformAdminGate } from '@/components/platform-admin-gate';

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return <PlatformAdminGate>{children}</PlatformAdminGate>;
}
