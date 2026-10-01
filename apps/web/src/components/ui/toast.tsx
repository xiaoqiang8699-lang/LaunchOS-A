'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';
import { cn } from '@/lib/utils';

type ToastItem = { id: number; message: string };

const ToastCtx = createContext<{ push: (message: string) => void } | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((message: string) => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setItems((prev) => [...prev, { id, message }]);
    window.setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id));
    }, 2800);
  }, []);
  const value = useMemo(() => ({ push }), [push]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[80] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2">
        {items.map((item) => (
          <div
            key={item.id}
            className="pointer-events-auto rounded-lg border border-[var(--los-border)] bg-[var(--los-text)] px-3 py-2 text-sm text-white shadow-lg"
            role="status"
          >
            {item.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  return ctx ?? { push: (message: string) => window.alert(message) };
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '确认',
  cancelLabel = '取消',
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="los-confirm-title"
    >
      <div className="w-full max-w-md rounded-xl border border-[var(--los-border)] bg-white p-5 shadow-xl">
        <h3 id="los-confirm-title" className="text-base font-semibold text-[var(--los-text)]">
          {title}
        </h3>
        {description ? (
          <p className="mt-2 text-sm text-[var(--los-secondary)]">{description}</p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-[var(--los-border)] px-3 py-2 text-sm"
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={cn(
              'rounded-lg px-3 py-2 text-sm font-medium text-white',
              danger ? 'bg-red-600 hover:bg-red-700' : 'bg-[var(--los-action)] hover:bg-[var(--los-action-hover)]',
            )}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? '处理中…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
