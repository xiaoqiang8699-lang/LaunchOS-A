'use client';

import { AppShell } from '@/components/control-center/app-shell';

/** Drop-in authenticated shell for Control Center pages. */
export function ControlCenter({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
