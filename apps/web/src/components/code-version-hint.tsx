'use client';

import { useState, useSyncExternalStore } from 'react';
import { PRODUCT_COPY } from '@/lib/product-language';

const STORAGE_KEY = 'launchos.seenCodeVersionHint';

function subscribe(onStoreChange: () => void): () => void {
  window.addEventListener('storage', onStoreChange);
  return () => window.removeEventListener('storage', onStoreChange);
}

function getSnapshot(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== '1';
  } catch {
    return true;
  }
}

function getServerSnapshot(): boolean {
  return false;
}

export function CodeVersionHint() {
  const unseen = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [dismissed, setDismissed] = useState(false);
  const open = unseen && !dismissed;

  if (!open) {
    return (
      <p className="text-sm text-zinc-500">{PRODUCT_COPY.codeVersionKeepDefault}</p>
    );
  }

  function dismiss(): void {
    try {
      window.localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // Ignore storage failures in private mode.
    }
    setDismissed(true);
  }

  return (
    <section className="rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <p className="font-medium">{PRODUCT_COPY.codeVersionWhat}</p>
      <p className="mt-1 whitespace-pre-line text-amber-800">{PRODUCT_COPY.codeVersionExplain}</p>
      <button
        className="mt-3 rounded-md bg-white px-3 py-1.5 text-xs text-amber-900"
        type="button"
        onClick={dismiss}
      >
        知道了
      </button>
    </section>
  );
}
