'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ControlCenter } from '@/components/control-center';
import { EmptyState, InlineAlert, Skeleton } from '@/components/ui/feedback';
import { Card, PageHeader, Section } from '@/components/ui/section';
import { api, ApiError } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';

type HistoryItem = {
  orderNumber: string;
  statusLabel: string;
  totalAmount: number | null;
  currency: string;
  invoiceNumber: string | null;
  payments: Array<{ statusLabel: string; paidAt: string | null; attemptNumber: number }>;
  refunds: Array<{ amount: number; statusLabel: string }>;
};

type View = {
  plan: { code: string; name: string };
  presentation: {
    subscriptionFeeLabel: string;
    cloudCostLabel: string;
    discountLabel: string;
    taxLabel: string;
    totalLabel: string;
    disclaimer: string;
  };
  invoices: Array<{
    id: string;
    amount: number;
    currency: string;
    status: string;
    createdAt: string;
  }>;
  subscription?: { statusLabel?: string } | null;
};

type BillingResponse = View & { commercial?: View; paymentHistory?: HistoryItem[] };

export default function BillingPage() {
  const router = useRouter();
  const [view, setView] = useState<View | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }
    void api<BillingResponse>('/account/billing')
      .then((payload) => {
        setView(payload.commercial ?? payload);
        setHistory(payload.paymentHistory ?? []);
      })
      .catch((reason) => setError(reason instanceof ApiError ? reason.message : '加载失败'));
  }, [router]);

  if (!view && !error) {
    return (
      <ControlCenter>
        <PageHeader title="账单" description="订单、支付与发票" />
        <Skeleton className="h-40" />
      </ControlCenter>
    );
  }

  return (
    <ControlCenter>
      <PageHeader
        title="账单"
        description="订单、支付与发票"
        action={
          <Link className="text-sm underline" href="/plan">
            查看套餐
          </Link>
        }
      />

      {error ? <InlineAlert className="mb-4" tone="error" title={error} /> : null}

      {view ? (
        <Card className="mb-5 space-y-1 p-5 text-sm">
          <p className="text-xs text-[var(--los-secondary)]">当前订阅</p>
          <p className="text-lg font-semibold">{view.plan.name}</p>
          <p>{view.presentation.subscriptionFeeLabel}</p>
          <p className="text-[var(--los-secondary)]">{view.presentation.disclaimer}</p>
        </Card>
      ) : null}

      <Section title="订单与支付记录">
        {!history.length ? (
          <EmptyState
            title="还没有账单记录"
            description="购买套餐后，订单与支付记录会显示在这里。"
            actionLabel="查看套餐"
            actionHref="/plan"
          />
        ) : (
          <Card className="divide-y divide-[var(--los-border)] p-0">
            {history.map((item) => (
              <div key={item.orderNumber} className="px-4 py-3 text-sm">
                <p className="font-medium">
                  订单 {item.orderNumber} · {item.statusLabel}
                </p>
                <p className="text-[var(--los-secondary)]">
                  {item.totalAmount == null
                    ? '金额待确认'
                    : `${item.totalAmount} ${item.currency}`}
                </p>
                {item.payments.map((payment) => (
                  <p key={`${item.orderNumber}-${payment.attemptNumber}`} className="text-[var(--los-secondary)]">
                    支付 {payment.statusLabel}
                    {payment.paidAt ? ` · ${new Date(payment.paidAt).toLocaleString()}` : ''}
                  </p>
                ))}
                {item.invoiceNumber ? <p>发票 {item.invoiceNumber}</p> : null}
                {item.refunds.map((refund, index) => (
                  <p key={`${item.orderNumber}-r-${index}`}>
                    退款 {refund.amount} · {refund.statusLabel}
                  </p>
                ))}
              </div>
            ))}
          </Card>
        )}
      </Section>

      {view && view.invoices.length > 0 ? (
        <Section className="mt-6" title="发票">
          <Card className="divide-y divide-[var(--los-border)] p-0 text-sm">
            {view.invoices.map((invoice) => (
              <div key={invoice.id} className="px-4 py-3">
                {invoice.amount} {invoice.currency} · {invoice.status}
              </div>
            ))}
          </Card>
        </Section>
      ) : null}
    </ControlCenter>
  );
}
