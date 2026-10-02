'use client';

import { useEffect, useMemo, useState } from 'react';
import { PlanCard, type PlanCardModel } from '@/components/billing/plan-card';
import { InlineAlert } from '@/components/ui/feedback';
import { api, ApiError } from '@/lib/api';
import { PLAN_LIST_PRICES } from '@/lib/plan-prices';
import { cn } from '@/lib/utils';

type ComparisonCard = {
  code: string;
  name: string;
  audience: string | null;
  priceLabel: string;
  yearlyLabel: string | null;
  contactSales?: boolean;
  summary?: string[];
  keyFeatures?: Array<{ label: string; value: string }>;
};

type Comparison = {
  cards: ComparisonCard[];
  currentPlan: string;
};

const FALLBACK_BENEFITS: Record<string, string[]> = {
  free: ['1 个应用', '基础部署额度', '平台托管运行', '系统域名', '社区支持'],
  pro: [
    '更多应用额度',
    '更高每月上线次数',
    '自定义域名',
    '更长日志保留',
    '优先构建队列',
  ],
  team: [
    '团队协作与成员管理',
    '更高应用与部署额度',
    '自定义域名',
    '高级日志与权限',
    '审计相关能力',
  ],
  enterprise: ['定制额度与 SLA', '专属支持', '安全与合规选项', '集中账单', '按需扩展'],
};

const FALLBACK: PlanCardModel[] = [
  {
    code: 'free',
    name: 'Free',
    audience: '适合第一次体验 LaunchOS 的个人用户',
    priceMonthly: '¥0/月',
    summary: '适合第一次体验 LaunchOS 的个人用户',
    benefits: FALLBACK_BENEFITS.free!,
  },
  {
    code: 'pro',
    name: 'Pro',
    audience: '适合个人开发者和小型线上项目',
    priceMonthly: '¥99/月',
    priceYearly: '¥990/年',
    summary: '适合个人开发者和小型线上项目',
    benefits: FALLBACK_BENEFITS.pro!,
  },
  {
    code: 'team',
    name: 'Team',
    audience: '适合小团队协作发布',
    priceMonthly: '¥299/月',
    priceYearly: '¥2990/年',
    summary: '适合小团队协作发布',
    benefits: FALLBACK_BENEFITS.team!,
  },
  {
    code: 'enterprise',
    name: 'Enterprise',
    audience: '适合大规模组织与定制需求',
    priceMonthly: '联系我们',
    contactSales: true,
    summary: '适合大规模组织与定制需求',
    benefits: FALLBACK_BENEFITS.enterprise!,
  },
];

function normalizePrice(code: string, interval: 'month' | 'year', fallback: string): string {
  const known = PLAN_LIST_PRICES[code.toLowerCase()];
  if (!known) return fallback;
  if (code.toLowerCase() === 'free') return interval === 'year' ? '¥0/年' : '¥0/月';
  if (code.toLowerCase() === 'enterprise') return '联系我们';
  if (interval === 'year') return (known.yearly || known.monthly).replace(/\s+/g, '');
  return known.monthly.replace(/\s+/g, '');
}

function buildBenefits(card: ComparisonCard): string[] {
  const fromSummary = (card.summary || []).filter(Boolean);
  const fromFeatures = (card.keyFeatures || [])
    .filter((f) => f.value === '✓' || (f.value && f.value !== '—' && f.value !== '×'))
    .map((f) => (f.value && f.value !== '✓' ? `${f.label}：${f.value}` : f.label));
  const merged = [...fromSummary, ...fromFeatures];
  const unique = Array.from(new Set(merged)).slice(0, 6);
  if (unique.length > 0) return unique;
  return FALLBACK_BENEFITS[card.code.toLowerCase()] || ['标准平台能力'];
}

export function AdjustPlanDialog({
  open,
  currentPlanCode,
  onClose,
  onChanged,
}: {
  open: boolean;
  currentPlanCode: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [interval, setInterval] = useState<'month' | 'year'>('month');
  const [plans, setPlans] = useState<PlanCardModel[]>(FALLBACK);
  const [busyCode, setBusyCode] = useState('');
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    setWarning('');
    void api<Comparison>('/account/subscription/plans')
      .then((payload) => {
        const cards = (payload.cards || [])
          .filter((card) => ['free', 'pro', 'team', 'enterprise'].includes(card.code.toLowerCase()))
          .map((card) => {
            const code = card.code.toLowerCase();
            return {
              code,
              name: card.name,
              audience: card.audience,
              priceMonthly: normalizePrice(code, 'month', card.priceLabel || '—'),
              priceYearly: card.yearlyLabel
                ? normalizePrice(code, 'year', card.yearlyLabel)
                : PLAN_LIST_PRICES[code]?.yearly?.replace(/\s+/g, '') ?? null,
              summary: card.audience || undefined,
              benefits: buildBenefits(card),
              contactSales: Boolean(card.contactSales) || code === 'enterprise',
            } satisfies PlanCardModel;
          });
        const order = ['free', 'pro', 'team', 'enterprise'];
        cards.sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code));
        setPlans(cards.length ? cards : FALLBACK);
      })
      .catch(() => setPlans(FALLBACK));
  }, [open]);

  const current = useMemo(() => currentPlanCode.toLowerCase(), [currentPlanCode]);

  if (!open) return null;

  async function selectPlan(code: string) {
    const normalized = code.toLowerCase();
    if (normalized === 'pro' || normalized === 'team') {
      onClose();
      window.location.href = `/billing/checkout/confirm?plan=${encodeURIComponent(normalized)}&cycle=MONTHLY`;
      return;
    }
    setBusyCode(code);
    setError('');
    setWarning('');
    try {
      const result = await api<{ warning?: string | null }>(
        '/billing/subscription/change-plan',
        { method: 'POST', body: JSON.stringify({ plan: code }) },
      );
      if (result.warning) setWarning(result.warning);
      onChanged();
      onClose();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : '调整计划失败');
    } finally {
      setBusyCode('');
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-3 sm:p-6" role="dialog" aria-modal>
      <div className="relative max-h-[92vh] w-full max-w-6xl overflow-y-auto rounded-2xl bg-white px-4 py-5 shadow-2xl sm:px-6 sm:py-6">
        <button
          type="button"
          aria-label="关闭"
          className="absolute right-4 top-4 rounded-md px-2 py-1 text-lg leading-none text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
          onClick={onClose}
        >
          ×
        </button>

        <div className="mx-auto max-w-3xl text-center">
          <h2 className="text-xl font-semibold text-zinc-900 sm:text-2xl">调整你的计划</h2>
          <p className="mt-1 text-sm text-zinc-500">Beta 阶段仅变更计划，不触发真实支付。</p>

          <div className="mt-4 inline-flex rounded-full border border-zinc-200 bg-zinc-50 p-1">
            {(
              [
                ['month', '月度'],
                ['year', '年度'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={cn(
                  'rounded-full px-4 py-1.5 text-sm',
                  interval === value ? 'bg-zinc-900 text-white' : 'text-zinc-600',
                )}
                onClick={() => setInterval(value)}
              >
                {label}
              </button>
            ))}
          </div>
          {interval === 'year' ? (
            <p className="mt-2 inline-flex rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
              按年付费可节省约 17%
            </p>
          ) : null}
        </div>

        {error ? <InlineAlert className="mx-auto mt-4 max-w-3xl" tone="error" title={error} /> : null}
        {warning ? <InlineAlert className="mx-auto mt-4 max-w-3xl" tone="warning" title={warning} /> : null}

        <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {plans.map((plan) => (
            <PlanCard
              key={plan.code}
              plan={plan}
              interval={interval}
              current={plan.code === current}
              currentPlanCode={current}
              busy={Boolean(busyCode)}
              onSelect={() => void selectPlan(plan.code)}
            />
          ))}
        </div>

        <p className="mt-6 text-center text-sm text-zinc-500">
          需要更多企业能力？
          <span className="ml-1 text-zinc-800">请选择 Enterprise 联系我们。</span>
        </p>
      </div>
    </div>
  );
}
