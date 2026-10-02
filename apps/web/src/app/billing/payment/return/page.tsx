'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api } from '@/lib/api';

type View = {
  statusCopy: string;
  fulfillmentCopy: string;
  returnCopy: string;
  planName: string;
  invoiceNumber: string | null;
  paidAt: string | null;
  payableAmount: number | null;
  currency: string;
};

function PaymentReturnInner() {
  const params = useSearchParams();
  const orderId = params.get('orderId') || params.get('out_trade_no') || '';
  const [view, setView] = useState<View | null>(null);
  const [isTest, setIsTest] = useState(false);

  useEffect(() => {
    if (!orderId) return;
    let stopped = false;
    const tick = () => {
      api<View & { planName?: string }>(`/checkout/${orderId}/status`)
        .then((payload) => {
          if (stopped) return;
          setView(payload);
          setIsTest(/联调|PAYMENT_TEST|支付测试/i.test(payload.planName ?? ''));
        })
        .catch(() => undefined);
    };
    tick();
    const timer = window.setInterval(tick, 2000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [orderId]);

  if (!orderId) {
    return (
      <main className="mx-auto max-w-xl space-y-3 px-6 py-10 text-sm">
        <h1 className="text-2xl font-semibold">付款结果</h1>
        <p>缺少订单信息。请从账单页重新进入。</p>
        <Link className="underline" href="/billing">
          返回账单
        </Link>
      </main>
    );
  }

  const done = view?.statusCopy === '开通完成' || view?.statusCopy === '支付成功，正在开通';
  const failed = view?.statusCopy === '支付未完成';

  return (
    <main className="mx-auto max-w-xl space-y-3 px-6 py-10 text-sm">
      <h1 className="text-2xl font-semibold">
        {failed ? '付款未完成' : done ? (isTest ? '支付测试成功' : '付款成功') : (view?.returnCopy ?? '正在确认付款')}
      </h1>
      <p>{view?.fulfillmentCopy ?? '正在同步支付结果… 浏览器回跳不能作为付款成功依据。'}</p>
      {done && isTest ? <p>这是内部支付联调，不会升级正式套餐权益。</p> : null}
      {done && !isTest ? <p>{view?.planName} 套餐处理中或已生效。</p> : null}
      {view?.invoiceNumber ? <p>账单号 {view.invoiceNumber}</p> : null}
      <Link className="inline-block rounded bg-zinc-900 px-3 py-2 text-white" href="/billing">
        返回账单
      </Link>
    </main>
  );
}

export default function BillingPaymentReturnPage() {
  return (
    <Suspense fallback={<p className="p-10 text-sm text-zinc-500">正在确认付款…</p>}>
      <PaymentReturnInner />
    </Suspense>
  );
}
