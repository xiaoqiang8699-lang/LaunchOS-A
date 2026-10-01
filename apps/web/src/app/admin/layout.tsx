'use client';

import { AdminAppShell } from '@/components/admin/admin-app-shell';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <AdminAppShell>{children}</AdminAppShell>;
}
