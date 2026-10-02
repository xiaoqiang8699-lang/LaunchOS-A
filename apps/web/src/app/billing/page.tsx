'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AdjustPlanDialog } from '@/components/billing/adjust-plan-dialog';
import { SubscriptionCancelSection } from '@/components/billing/subscription-cancel-section';
import { SubscriptionStatus } from '@/components/billing/subscription-status';
import { ControlCenter } from '@/components/control-center';
import { EmptyState, InlineAlert, Skeleton } from '@/components/ui/feedback';
import { PrimaryButton, SecondaryButton } from '@/components/ui/button';
import { Card, PageHeader, Section } from '@/components/ui/section';
import { api, ApiError } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import { presentPlanPrice } from '@/lib/plan-prices';

type HistoryItem = {
  orderNumber: string;
  statusLabel: string;
  totalAmount: number | null;
  currency: string;
  invoiceNumber: string | null;
  createdAt?: string;
  planName?: string | null;
  payments: Array<{ statusLabel: string; paidAt: string | null; attemptNumber: number }>;
  refunds: Array<{ amount: number; statusLabel: string }>;
};

type BillingResponse = {
  plan: { code: string; name: string; priceMonthly?: number; currency?: string };
  status?: string;
  statusLabel?: string;
  nextRenewalAt?: string | null;
  cancelAtPeriodEnd?: boolean;
  invoices: Array<{ id: string; amount: number; currency: string; status: string; createdAt: string }>;
  commercial?: {
    plan?: { code?: string; name?: string };
    presentation?: { subscriptionFeeLabel?: string; disclaimer?: string };
  };
  paymentHistory?: HistoryItem[];
};

type SubscriptionView = {
  effectivePlan: {
    code: string;
    name: string;
    priceMonthly: number;
    currency: string;
  };
  subscription: {
    status: string;
    statusLabel: string;
    cancelAtPeriodEnd?: boolean;
    currentPeriodStart?: string | null;
    currentPeriodEnd?: string | null;
  } | null;
  autoRenew?: boolean;
  autoRenewImplemented?: boolean;
  cancelAtPeriodEnd?: boolean;
  canCancel?: boolean;
  canResume?: boolean;
  periodStartLabel?: string | null;
  periodEndLabel?: string | null;
  currentPeriodStart?: string | null;
  currentPeriodEnd?: string | null;
  pendingPlan?: { code: string; name: string } | null;
  nextChange?: string | null;
  sourceLabel?: string | null;
  isPaidSubscription?: boolean;
  isBetaEntitlement?: boolean;
  gracePeriodEndLabel?: string | null;
  billingCycle?: string | null;
  renewalDue?: boolean;
  statusLabel?: string | null;
};

function formatDay(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('zh-CN');
}

export default function BillingPage() {
  const router = useRouter();
  const [billing, setBilling] = useState<BillingResponse | null>(null);
  const [subscription, setSubscription] = useState<SubscriptionView | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [adjustOpen, setAdjustOpen] = useState(false);

  const load = useCallback(() => {
    void Promise.all([
      api<BillingResponse>('/account/billing'),
      api<SubscriptionView>('/billing/subscription'),
    ])
      .then(([billingPayload, subscriptionPayload]) => {
        setBilling(billingPayload);
        setSubscription(subscriptionPayload);
        setHistory(billingPayload.paymentHistory ?? []);
      })
      .catch((reason) => setError(reason instanceof ApiError ? reason.message : '加载失败'));
  }, []);

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }
    load();
  }, [router, load]);

  if (!billing && !error) {
    return (
      <ControlCenter>
        <PageHeader title="账单" description="订阅、支付与发票" />
        <Skeleton className="h-40" />
      </ControlCenter>
    );
  }

  const planCode = subscription?.effectivePlan.code || billing?.plan.code || 'free';
  const planName = subscription?.effectivePlan.name || billing?.plan.name || 'Free';
  const cancelAtPeriodEnd = Boolean(
    subscription?.cancelAtPeriodEnd ||
      subscription?.subscription?.cancelAtPeriodEnd ||
      billing?.cancelAtPeriodEnd ||
      subscription?.subscription?.status === 'CANCEL_AT_PERIOD_END',
  );
  const status = subscription?.subscription?.status || billing?.status || 'ACTIVE';
  const periodStart =
    subscription?.periodStartLabel ||
    formatDay(subscription?.currentPeriodStart || subscription?.subscription?.currentPeriodStart);
  const periodEnd =
    subscription?.periodEndLabel ||
    formatDay(
      subscription?.currentPeriodEnd ||
        subscription?.subscription?.currentPeriodEnd ||
        billing?.nextRenewalAt,
    );
  const priceLabel = presentPlanPrice(
    planCode,
    billing?.commercial?.presentation?.subscriptionFeeLabel ||
      (subscription?.effectivePlan.priceMonthly != null
        ? `${subscription.effectivePlan.priceMonthly} ${subscription.effectivePlan.currency} / 月`
        : null),
  );
  const cycleLabel =
    subscription?.billingCycle === 'YEARLY' ? '年付' : subscription?.billingCycle === 'MONTHLY' ? '月付' : '无计费周期';
  const sourceLabel =
    subscription?.sourceLabel ||
    (subscription?.isPaidSubscription ? '真实订阅' : subscription?.isBetaEntitlement ? 'Beta 测试权益' : '免费默认');

  return (
    <ControlCenter>
      <PageHeader title="账单" description="当前订阅、支付记录与订阅管理" />

      {error ? <InlineAlert className="mb-4" tone="error" title={error} /> : null}
      {message ? <InlineAlert className="mb-4" tone="success" title={message} /> : null}

      <Section title="当前订阅">
        <Card className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2 text-sm">
              <p className="text-xs text-[var(--los-secondary)]">当前套餐</p>
              <p className="text-xl font-semibold">{planName}</p>
              <p className="text-[var(--los-secondary)]">{priceLabel}</p>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="text-[var(--los-secondary)]">状态：</span>
                <SubscriptionStatus
                  status={status}
                  cancelAtPeriodEnd={cancelAtPeriodEnd}
                  statusLabel={subscription?.statusLabel || subscription?.subscription?.statusLabel || billing?.statusLabel}
                />
              </div>
              <p>
                <span className="text-[var(--los-secondary)]">来源：</span>
                {sourceLabel}
              </p>
              <p>
                <span className="text-[var(--los-secondary)]">计费周期：</span>
                {cycleLabel}
              </p>
              <p>
                <span className="text-[var(--los-secondary)]">有效期：</span>
                {periodStart} ～ {periodEnd}
              </p>
              <p>
                <span className="text-[var(--los-secondary)]">续费方式：</span>
                当前不支持自动扣款；到期前请主动续费
              </p>
              {subscription?.renewalDue && !cancelAtPeriodEnd ? (
                <p className="text-amber-700">套餐即将到期（{periodEnd}）</p>
              ) : null}
              {status === 'GRACE_PERIOD' ? (
                <p className="text-amber-700">
                  套餐已到期，处于宽限期
                  {subscription?.gracePeriodEndLabel ? `，宽限至 ${subscription.gracePeriodEndLabel}` : ''}
                </p>
              ) : null}
              {subscription?.pendingPlan ? (
                <p className="text-amber-700">
                  待生效套餐：{subscription.pendingPlan.name}
                  {subscription.nextChange ? ` · ${subscription.nextChange}` : ''}
                </p>
              ) : null}
              {cancelAtPeriodEnd ? (
                <p className="text-amber-700">将在 {periodEnd} 到期后结束</p>
              ) : null}
            </div>
            <div className="flex flex-col gap-2">
              <PrimaryButton type="button" onClick={() => setAdjustOpen(true)}>
                调整计划
              </PrimaryButton>
              {cancelAtPeriodEnd ? (
                <SecondaryButton
                  type="button"
                  onClick={() => {
                    void api('/billing/subscription/resume', { method: 'POST', body: '{}' })
                      .then(() => {
                        setMessage('已恢复订阅状态');
                        load();
                      })
                      .catch((reason) =>
                        setError(reason instanceof ApiError ? reason.message : '恢复失败'),
                      );
                  }}
                >
                  恢复订阅
                </SecondaryButton>
              ) : null}
            </div>
          </div>
        </Card>
      </Section>

      <Section className="mt-6" title="支付记录">
        {!history.length ? (
          <EmptyState
            title="还没有支付记录"
            description="购买套餐后，支付记录会显示在这里。"
          />
        ) : (
          <Card className="overflow-x-auto p-0">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-[var(--los-border)] bg-zinc-50 text-xs text-[var(--los-secondary)]">
                <tr>
                  <th className="px-4 py-2">支付时间</th>
                  <th className="px-4 py-2">套餐</th>
                  <th className="px-4 py-2">金额</th>
                  <th className="px-4 py-2">状态</th>
                  <th className="px-4 py-2">发票</th>
                </tr>
              </thead>
              <tbody>
                {history.map((item) => (
                  <tr key={item.orderNumber} className="border-b border-[var(--los-border)]">
                    <td className="px-4 py-3 text-[var(--los-secondary)]">
                      {item.payments[0]?.paidAt
                        ? new Date(item.payments[0].paidAt).toLocaleString()
                        : item.createdAt
                          ? new Date(item.createdAt).toLocaleString()
                          : '—'}
                    </td>
                    <td className="px-4 py-3">{item.planName || planName}</td>
                    <td className="px-4 py-3">
                      {item.totalAmount == null ? '金额待确认' : `${item.totalAmount} ${item.currency}`}
                    </td>
                    <td className="px-4 py-3">{item.statusLabel}</td>
                    <td className="px-4 py-3">{item.invoiceNumber || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </Section>

      <Section className="mt-6" title="发票">
        {(billing?.invoices?.length || 0) > 0 ? (
          <Card className="divide-y divide-[var(--los-border)] p-0 text-sm">
            {billing!.invoices.map((invoice) => (
              <div key={invoice.id} className="px-4 py-3">
                {invoice.amount} {invoice.currency} · {invoice.status} ·{' '}
                {new Date(invoice.createdAt).toLocaleDateString()}
              </div>
            ))}
          </Card>
        ) : (
          <Card className="p-5 text-sm text-[var(--los-secondary)]">发票能力预留，后续开放。</Card>
        )}
      </Section>

      <div className="mt-6">
        <SubscriptionCancelSection
          canCancel={Boolean(subscription?.canCancel)}
          cancelAtPeriodEnd={cancelAtPeriodEnd}
          periodEndLabel={periodEnd}
          onChanged={() => {
            setMessage(cancelAtPeriodEnd ? '已恢复订阅状态' : '已预约到期取消');
            load();
          }}
        />
      </div>

      <AdjustPlanDialog
        open={adjustOpen}
        currentPlanCode={planCode}
        onClose={() => setAdjustOpen(false)}
        onChanged={() => {
          setMessage('计划已更新（未触发真实支付）');
          load();
        }}
      />
    </ControlCenter>
  );
}
