'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';

type View = {
  planName: string;
  billingInterval: string;
  subscriptionFee: number | null;
  cloudCostNote: string;
  payableAmount: number | null;
  currency: string;
  showAlipay: boolean;
  statusCopy: string;
  fulfillmentCopy: string;
  invoiceNumber: string | null;
};

export default function CheckoutPage() {
  const params = useParams<{ orderId: string }>();
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<View>(`/checkout/${params.orderId}`)
      .then(setView)
      .catch((reason) => setError(reason instanceof ApiError ? reason.message : '加载失败'));
  }, [params.orderId]);

  async function pay() {
    setError('');
    const result = await api<{ checkoutUrl: string }>(`/checkout/${params.orderId}/alipay`, {
      method: 'POST',
      body: JSON.stringify({ amount: 0.01 }),
    }).catch((reason) => {
      setError(reason instanceof ApiError ? reason.message : '支付没有完成');
      return null;
    });
    if (result?.checkoutUrl) window.location.href = result.checkoutUrl;
  }

  if (!view)
    return (
      <main className="mx-auto max-w-xl px-6 py-10 text-sm text-zinc-500">
        {error || '加载中…'}
      </main>
    );
  return (
    <main className="mx-auto max-w-xl space-y-4 px-6 py-10 text-sm">
      <h1 className="text-2xl font-semibold">确认套餐支付</h1>
      <p>目标套餐 {view.planName}</p>
      <p>计费周期 {view.billingInterval}</p>
      <p>
        套餐费用 {view.subscriptionFee ?? '待确认'} {view.currency}
      </p>
      <p>{view.cloudCostNote}</p>
      <p className="font-medium">
        应付套餐金额 {view.payableAmount ?? '待确认'} {view.currency}
      </p>
      {view.showAlipay ? (
        <button
          className="rounded bg-zinc-900 px-3 py-2 text-white"
          type="button"
          onClick={() => void pay()}
        >
          支付宝
        </button>
      ) : (
        <p>支付宝暂未向当前账号开放。</p>
      )}
      <p>{view.fulfillmentCopy}</p>
      {view.invoiceNumber ? <p>账单号 {view.invoiceNumber}</p> : null}
      {error ? <p className="text-red-600">{error}</p> : null}
      <Link className="underline" href="/account?tab=billing">
        返回账单
      </Link>
    </main>
  );
}
