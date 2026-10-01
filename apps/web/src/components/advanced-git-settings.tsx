'use client';

import { useState } from 'react';
import { PRODUCT_COPY } from '@/lib/product-language';

export function AdvancedGitSettings(props: {
  version: string;
  onVersionChange: (value: string) => void;
  runtime: string;
  onRuntimeChange: (value: string) => void;
  port: string;
  onPortChange: (value: string) => void;
  buildCommand: string;
  onBuildCommandChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-xl border border-zinc-100 px-4 py-3">
      <button
        className="flex w-full items-center justify-between text-sm font-medium text-zinc-700"
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        {PRODUCT_COPY.advanced}
        <span className="text-xs font-normal text-zinc-400">{open ? '收起' : '展开'}</span>
      </button>
      {open ? (
        <div className="mt-4 space-y-3">
          <label className="block text-sm text-zinc-700">
            {PRODUCT_COPY.codeVersion}
            <span className="mt-0.5 block text-xs font-normal text-zinc-500">{PRODUCT_COPY.codeVersionHint}</span>
            <input
              className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
              value={props.version}
              onChange={(event) => props.onVersionChange(event.target.value)}
            />
          </label>
          <label className="block text-sm text-zinc-700">
            {PRODUCT_COPY.runtimeEnv}
            <span className="mt-0.5 block text-xs font-normal text-zinc-500">{PRODUCT_COPY.runtimeEnvHint}</span>
            <input
              className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
              value={props.runtime}
              onChange={(event) => props.onRuntimeChange(event.target.value)}
              placeholder="自动识别"
            />
          </label>
          <label className="block text-sm text-zinc-700">
            {PRODUCT_COPY.port}
            <input
              className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
              value={props.port}
              onChange={(event) => props.onPortChange(event.target.value)}
              placeholder="自动识别"
            />
          </label>
          <label className="block text-sm text-zinc-700">
            {PRODUCT_COPY.buildCommand}
            <input
              className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
              value={props.buildCommand}
              onChange={(event) => props.onBuildCommandChange(event.target.value)}
              placeholder="自动识别"
            />
          </label>
          <p className="text-xs text-zinc-500">{PRODUCT_COPY.codeVersionKeepDefault}</p>
        </div>
      ) : null}
    </div>
  );
}
