'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ControlCenter } from '@/components/control-center';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { Card, PageHeader, Section } from '@/components/ui/section';
import { api, ApiError } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import { isBetaEntitlementSource, presentPlanPrice, PLAN_LIST_PRICES } from '@/lib/plan-prices';

type Metric = {
  limit: number | null;
  used: number | null;
};

type PlanView = {
  effectivePlan: {
    code: string;
    name: string;
    description: string | null;
    priceMonthly: number;
    currency: string;
  };
  subscription: {
    statusLabel: string;
  } | null;
  overallStatus: 'WITHIN_LIMIT' | 'NEAR_LIMIT' | 'OVER_LIMIT';
  periodStartLabel: string | null;
  periodEndLabel: string | null;
  nextChange: string | null;
  upgrade: { message: string };
  recommendation: { recommendedPlan: string | null; reason: string | null };
  quota: Record<string, Metric>;
  entitlements?: {
    source?: string;
    ui?: Record<string, string>;
    warnings?: Array<{ message: string }>;
    override?: { reason?: string | null } | null;
  } | null;
};

type PlanCard = {
  code: string;
  name: string;
  audience: string | null;
  priceLabel: string;
  yearlyLabel: string | null;
  badges: string[];
  summary: string[];
  keyFeatures?: Array<{ label: string; value: string }>;
};

type Comparison = {
  cards: PlanCard[];
  currentPlan: string;
  recommendedPlan: string | null;
  disclaimer?: string;
};

const CUSTOMER_PLANS = new Set(['free', 'pro', 'team', 'enterprise']);
const HIGHLIGHT_LABELS = ['应用', '上线', '运行', '成员', '版本', '日志', '域名'];

function isHighlightFeature(label: string) {
  return HIGHLIGHT_LABELS.some((key) => label.includes(key));
}

export default function PlanPage() {
  const router = useRouter();
  const [view, setView] = useState<PlanView | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  function load() {
    void Promise.all([
      api<PlanView>('/account/subscription'),
      api<Comparison>('/account/subscription/plans'),
    ])
      .then(([nextView, nextComparison]) => {
        setView(nextView);
        setComparison(nextComparison);
      })
      .catch((reason) => setError(reason instanceof ApiError ? reason.message : '加载失败'));
  }

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }
    load();
  }, [router]);

  const cards = useMemo(
    () =>
      (comparison?.cards || []).filter(
        (card) => CUSTOMER_PLANS.has(card.code.toLowerCase()) && card.code.toLowerCase() !== 'payment_test',
      ),
    [comparison],
  );

  async function requestUpgrade(code: string) {
    setMessage('');
    setError('');
    try {
      const result = await api<{ message: string }>('/account/subscription/upgrade-request', {
        method: 'POST',
        body: JSON.stringify({ planCode: code }),
      });
      setMessage(result.message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '申请失败');
    }
  }

  if (!view || !comparison) {
    return (
      <ControlCenter>
        <PageHeader title="套餐" description="查看当前套餐与可升级方案" />
        {error ? <InlineAlert tone="error" title={error} /> : <Skeleton className="h-40" />}
      </ControlCenter>
    );
  }

  const beta = isBetaEntitlementSource(view.entitlements?.source, view.entitlements?.override?.reason);
  const code = view.effectivePlan.code.toLowerCase();

  return (
    <ControlCenter>
      <PageHeader
        title="套餐"
        description="查看当前套餐与可升级方案"
        action={
          <Link className="text-sm underline" href="/usage">
            查看用量
          </Link>
        }
      />

      <Card className="mb-6 p-5">
        <p className="text-xs text-[var(--los-secondary)]">当前套餐</p>
        <h2 className="mt-1 text-xl font-semibold">{view.effectivePlan.name}</h2>
        {beta ? (
          <p className="mt-1 text-sm text-[var(--los-secondary)]">Beta 测试额度已启用</p>
        ) : null}
        <p className="mt-2 text-sm">
          {presentPlanPrice(code, `${view.effectivePlan.priceMonthly} CNY / 月`)}
        </p>
        {(code === 'pro' || code === 'team') && (
          <p className="text-sm text-[var(--los-secondary)]">{presentPlanPrice(code, null, '年')}</p>
        )}
        <p className="mt-3 text-sm text-[var(--los-secondary)]">
          状态：{view.subscription?.statusLabel ?? '正常'}
        </p>
        <p className="text-sm text-[var(--los-secondary)]">
          套餐周期：{view.periodStartLabel ?? '—'} → {view.periodEndLabel ?? '—'}
        </p>
        <p className="text-sm text-[var(--los-secondary)]">
          预计下次变化：{view.nextChange ?? '本周期内没有预约变化'}
        </p>

        {view.overallStatus === 'NEAR_LIMIT' ? (
          <InlineAlert className="mt-3" tone="warning" title="部分额度接近上限" actionLabel="查看用量" actionHref="/usage" />
        ) : null}
        {view.overallStatus === 'OVER_LIMIT' ? (
          <InlineAlert className="mt-3" tone="error" title="部分额度已用完" actionLabel="查看用量" actionHref="/usage" />
        ) : null}

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-lg bg-[var(--los-action)] px-3 py-1.5 text-sm text-white"
            onClick={() =>
              void requestUpgrade(view.recommendation.recommendedPlan ?? 'pro')
            }
          >
            申请升级
          </button>
          <Link
            className="rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm"
            href="/billing"
          >
            查看账单
          </Link>
        </div>
        {message ? <InlineAlert className="mt-3" tone="success" title={message} /> : null}
        {error ? <InlineAlert className="mt-3" tone="error" title={error} /> : null}
      </Card>

      <Section title="套餐权益摘要">
        {beta ? (
          <p className="mb-3 text-sm text-[var(--los-secondary)]">以下用量按 Beta 测试额度计算</p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(
            [
              ['应用', view.entitlements?.ui?.projects, view.quota.projects],
              ['本月上线', view.entitlements?.ui?.monthlyDeployments, view.quota.deployments],
              ['成员', view.entitlements?.ui?.members, view.quota.members],
              ['运行应用', view.entitlements?.ui?.runningApps, null],
            ] as const
          ).map(([label, uiValue, metric]) => (
            <Card key={label} className="p-4 text-sm">
              <p className="text-[var(--los-secondary)]">{label}</p>
              <p className="mt-1 font-medium">
                {uiValue ??
                  (metric?.limit == null ? '不限' : `${metric.used ?? 0} / ${metric.limit}`)}
              </p>
            </Card>
          ))}
          <Card className="p-4 text-sm">
            <p className="text-[var(--los-secondary)]">历史版本</p>
            <p className="mt-1 font-medium">{view.entitlements?.ui?.retainedVersions ?? '—'}</p>
          </Card>
          <Card className="p-4 text-sm">
            <p className="text-[var(--los-secondary)]">日志保留</p>
            <p className="mt-1 font-medium">
              {view.entitlements?.ui?.logRetentionDays
                ? `${view.entitlements.ui.logRetentionDays} 天`
                : '—'}
            </p>
          </Card>
          <Card className="p-4 text-sm">
            <p className="text-[var(--los-secondary)]">自定义域名</p>
            <p className="mt-1 font-medium">{view.entitlements?.ui?.customDomain ?? '—'}</p>
          </Card>
        </div>
      </Section>

      <Section className="mt-8" title="比较套餐">
        <p className="mb-4 text-sm text-[var(--los-secondary)]">
          Free {PLAN_LIST_PRICES.free?.monthly ?? '免费'} · Pro{' '}
          {PLAN_LIST_PRICES.pro?.monthly ?? '¥99 / 月'} / {PLAN_LIST_PRICES.pro?.yearly ?? '¥990 / 年'} ·
          Team {PLAN_LIST_PRICES.team?.monthly ?? '¥299 / 月'} /{' '}
          {PLAN_LIST_PRICES.team?.yearly ?? '¥2990 / 年'} · Enterprise 联系销售
        </p>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {cards.map((card) => {
            const current = card.code.toLowerCase() === comparison.currentPlan.toLowerCase();
            return (
              <article
                key={card.code}
                className="rounded-xl border border-[var(--los-border)] bg-white p-4 text-sm"
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-lg font-semibold">{card.name}</h3>
                  {current ? (
                    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs">当前</span>
                  ) : null}
                </div>
                <p className="mt-2 font-medium">{presentPlanPrice(card.code, card.priceLabel, '月')}</p>
                {(card.code === 'pro' || card.code === 'team' || card.yearlyLabel) && (
                  <p className="text-[var(--los-secondary)]">
                    {presentPlanPrice(card.code, card.yearlyLabel, '年')}
                  </p>
                )}
                <ul className="mt-3 space-y-1 text-[var(--los-secondary)]">
                  {(card.keyFeatures || [])
                    .filter((f) => isHighlightFeature(f.label) || f.value === '✓')
                    .slice(0, 7)
                    .map((f) => (
                      <li key={f.label}>
                        {f.label}
                        {f.value && f.value !== '✓' ? `：${f.value}` : ''}
                      </li>
                    ))}
                  {(!card.keyFeatures || card.keyFeatures.length === 0) &&
                    card.summary.slice(0, 5).map((line) => <li key={line}>{line}</li>)}
                </ul>
                {card.code === 'enterprise' ? (
                  <p className="mt-4 text-sm text-[var(--los-secondary)]">联系销售</p>
                ) : !current ? (
                  <button
                    type="button"
                    className="mt-4 rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm"
                    onClick={() => void requestUpgrade(card.code)}
                  >
                    申请升级
                  </button>
                ) : null}
              </article>
            );
          })}
        </div>
      </Section>
    </ControlCenter>
  );
}
