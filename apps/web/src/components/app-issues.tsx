'use client';

import { useMemo, useState } from 'react';
import { writeClipboard } from '@/lib/clipboard';
import { PRODUCT_COPY } from '@/lib/product-language';
import { DIAGNOSIS_SEVERITY_LABELS, formatDateTime, statusBadgeClass } from '@/lib/project-labels';
import type { AppIssue } from '@/lib/types';

export function AppIssues(props: { issues: AppIssue[] }) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('all');

  const filters = useMemo(() => {
    const names = Array.from(
      new Set(props.issues.map((item) => item.unitName).filter(Boolean) as string[]),
    );
    return ['all', ...names];
  }, [props.issues]);

  const visible = props.issues.filter((issue) => {
    if (filter === 'all') return true;
    return issue.unitName === filter;
  });

  async function copyPrompt(issue: AppIssue): Promise<void> {
    await writeClipboard(issue.assistantPrompt);
    setCopiedId(issue.id);
    window.setTimeout(() => setCopiedId(null), 2000);
  }

  return (
    <section id="issues" className="rounded-2xl border border-zinc-200 bg-white p-6">
      <h2 className="text-sm font-medium text-zinc-500">{PRODUCT_COPY.issuesCenter}</h2>
      {filters.length > 2 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {filters.map((item) => (
            <button
              key={item}
              className={`rounded-full px-3 py-1 text-xs ${
                filter === item ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-600'
              }`}
              type="button"
              onClick={() => setFilter(item)}
            >
              {item === 'all' ? '全部' : item}
            </button>
          ))}
        </div>
      ) : null}
      {visible.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-500">{PRODUCT_COPY.noIssues}</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {visible.map((issue) => (
            <li key={issue.id} className="rounded-xl border border-zinc-100 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  {issue.unitName ? (
                    <p className="text-xs text-zinc-500">{issue.unitName}</p>
                  ) : null}
                  <p className="font-medium text-zinc-900">{issue.title}</p>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-xs ${statusBadgeClass(issue.severity)}`}>
                  {DIAGNOSIS_SEVERITY_LABELS[issue.severity]}
                </span>
              </div>
              <p className="mt-1 text-xs text-zinc-500">{formatDateTime(issue.discoveredAt)}</p>
              <dl className="mt-3 space-y-2 text-sm text-zinc-700">
                <div>
                  <dt className="text-zinc-500">原因</dt>
                  <dd className="mt-0.5">{issue.cause}</dd>
                </div>
                <div>
                  <dt className="text-zinc-500">解决建议</dt>
                  <dd className="mt-0.5">{issue.suggestion}</dd>
                </div>
              </dl>
              <button
                className="mt-3 rounded-lg border border-zinc-200 px-3 py-1.5 text-sm text-zinc-700"
                type="button"
                onClick={() => void copyPrompt(issue)}
              >
                {copiedId === issue.id ? PRODUCT_COPY.copiedVisitUrl : PRODUCT_COPY.copyToAssistant}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
