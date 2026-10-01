'use client';

import { Suspense } from 'react';
import { CreateAppWizard } from '@/components/create-app/create-app-wizard';

function NewProjectInner() {
  return (
    <main className="min-h-screen bg-[var(--los-page)] px-4 py-8 sm:px-6 sm:py-10">
      <CreateAppWizard />
    </main>
  );
}

export default function NewProjectPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-[var(--los-page)] text-sm text-[var(--los-secondary)]">
          加载中…
        </main>
      }
    >
      <NewProjectInner />
    </Suspense>
  );
}
