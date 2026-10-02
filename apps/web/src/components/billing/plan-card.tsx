'use client';

import { cn } from '@/lib/utils';
import { PrimaryButton, SecondaryButton } from '@/components/ui/button';

export type PlanCardModel = {
  code: string;
  name: string;
  audience?: string | null;
  priceMonthly: string;
  priceYearly?: string | null;
  summary?: string;
  benefits: string[];
  contactSales?: boolean;
};

const PLAN_RANK: Record<string, number> = {
  free: 0,
  pro: 1,
  team: 2,
  enterprise: 3,
};

function actionLabel(input: {
  current: boolean;
  contactSales?: boolean;
  code: string;
  currentPlanCode: string;
}): { kind: 'current' | 'contact' | 'upgrade' | 'downgrade'; label: string } {
  if (input.contactSales) return { kind: 'contact', label: '联系我们' };
  if (input.current) return { kind: 'current', label: '当前计划' };
  const from = PLAN_RANK[input.currentPlanCode] ?? 0;
  const to = PLAN_RANK[input.code] ?? 0;
  if (to < from) return { kind: 'downgrade', label: '降级' };
  return { kind: 'upgrade', label: '选择方案' };
}

export function PlanCard({
  plan,
  interval,
  current,
  currentPlanCode,
  busy,
  onSelect,
}: {
  plan: PlanCardModel;
  interval: 'month' | 'year';
  current: boolean;
  currentPlanCode: string;
  busy?: boolean;
  onSelect?: () => void;
}) {
  const price =
    interval === 'year' && plan.priceYearly ? plan.priceYearly : plan.priceMonthly;
  const action = actionLabel({
    current,
    contactSales: plan.contactSales,
    code: plan.code,
    currentPlanCode,
  });

  return (
    <div
      className={cn(
        'flex h-full min-h-[420px] flex-col rounded-2xl border bg-white p-5',
        current ? 'border-zinc-900 shadow-sm' : 'border-zinc-200',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-base font-semibold text-zinc-900">{plan.name}</h3>
        {current ? (
          <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600">
            当前计划
          </span>
        ) : null}
      </div>

      <p className="mt-4 text-2xl font-semibold tracking-tight text-zinc-900">{price}</p>
      <p className="mt-2 min-h-[40px] text-sm leading-5 text-zinc-500">
        {plan.summary || plan.audience || '—'}
      </p>

      <ul className="mt-5 flex-1 space-y-2.5">
        {plan.benefits.map((item) => (
          <li key={item} className="flex gap-2 text-sm leading-5 text-zinc-700">
            <span className="mt-0.5 text-zinc-400" aria-hidden>
              ✓
            </span>
            <span>{item}</span>
          </li>
        ))}
      </ul>

      <div className="mt-6">
        {action.kind === 'current' ? (
          <SecondaryButton className="w-full" type="button" disabled>
            {action.label}
          </SecondaryButton>
        ) : action.kind === 'contact' ? (
          <SecondaryButton className="w-full" type="button" disabled>
            {action.label}
          </SecondaryButton>
        ) : action.kind === 'upgrade' ? (
          <PrimaryButton className="w-full" type="button" disabled={busy} onClick={onSelect}>
            {action.label}
          </PrimaryButton>
        ) : (
          <SecondaryButton className="w-full" type="button" disabled={busy} onClick={onSelect}>
            {action.label}
          </SecondaryButton>
        )}
      </div>
    </div>
  );
}
