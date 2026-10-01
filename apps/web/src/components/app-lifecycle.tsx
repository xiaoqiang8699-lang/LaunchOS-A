'use client';

import { PRODUCT_COPY } from '@/lib/product-language';
import type { AppRunningStatus } from '@/lib/types';

export type AppLifecycleAction = 'start' | 'stop' | 'restart';

export function AppLifecycleButtons(props: {
  status: AppRunningStatus;
  canManage?: boolean;
  busy?: AppLifecycleAction | null;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
}) {
  const managing =
    Boolean(props.canManage) &&
    props.status !== 'READY' &&
    props.status !== 'DEPLOYING';
  const starting = props.busy === 'start';
  const stopping = props.busy === 'stop';
  const restarting = props.busy === 'restart';
  const disabled = Boolean(props.busy) || !managing;

  return (
    <div className="flex flex-wrap gap-2">
      <button
        className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm text-zinc-700 disabled:opacity-50"
        type="button"
        disabled={disabled || props.status === 'RUNNING'}
        onClick={props.onStart}
      >
        {starting ? PRODUCT_COPY.startingApp : PRODUCT_COPY.startApp}
      </button>
      <button
        className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm text-zinc-700 disabled:opacity-50"
        type="button"
        disabled={disabled || props.status !== 'RUNNING'}
        onClick={props.onStop}
      >
        {stopping ? PRODUCT_COPY.stoppingApp : PRODUCT_COPY.stopApp}
      </button>
      <button
        className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm text-zinc-700 disabled:opacity-50"
        type="button"
        disabled={disabled}
        onClick={props.onRestart}
      >
        {restarting ? PRODUCT_COPY.restartingApp : PRODUCT_COPY.restartApp}
      </button>
    </div>
  );
}
