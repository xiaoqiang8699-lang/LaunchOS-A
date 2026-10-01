'use client';

import { useState, type MouseEvent } from 'react';
import { writeClipboard } from '@/lib/clipboard';
import { PRODUCT_COPY } from '@/lib/product-language';

export function VisitUrlBlock(props: {
  visitUrl: string | null;
  localVisitUrl?: string | null;
  preparing?: boolean;
  ready?: boolean;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const visitUrl = props.visitUrl;
  const preparing = Boolean(props.preparing);
  const ready = props.ready ?? (!preparing && Boolean(visitUrl));
  // Prefer public system domain once DNS is ready; localhost Gateway is local-only fallback.
  const href = preparing ? null : ready ? visitUrl || props.localVisitUrl || null : null;

  if (!visitUrl && !preparing) {
    return (
      <p className={props.compact ? 'text-sm text-zinc-500' : 'text-sm text-zinc-700'}>
        完成一次上线后可访问
      </p>
    );
  }

  const address = visitUrl || PRODUCT_COPY.visitUrlPreparing;

  async function copy(event: MouseEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    if (!visitUrl) {
      return;
    }
    try {
      await writeClipboard(visitUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        {href ? (
          <a
            className="break-all font-medium text-blue-700 underline"
            href={href}
            target="_blank"
            rel="noreferrer"
          >
            {address}
          </a>
        ) : (
          <span className="break-all text-zinc-700">{address}</span>
        )}
        {visitUrl ? (
          <button
            className="rounded-md border border-zinc-200 px-2 py-0.5 text-xs text-zinc-600 hover:border-zinc-300"
            type="button"
            onClick={(event) => void copy(event)}
          >
            {copied ? PRODUCT_COPY.copiedVisitUrl : PRODUCT_COPY.copyVisitUrl}
          </button>
        ) : null}
        <span
          className={`rounded-full px-2 py-0.5 text-xs ${
            ready ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
          }`}
        >
          {ready ? PRODUCT_COPY.visitUrlReadyStatus : PRODUCT_COPY.visitUrlPreparingStatus}
        </span>
      </div>
      {preparing ? (
        <p className="text-xs text-zinc-500">{PRODUCT_COPY.visitUrlPreparingHint}</p>
      ) : null}
    </div>
  );
}
