'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
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

export default function CheckoutReturnPage() {
  const params = useParams<{ orderId: string }>();
  const [view, setView] = useState<View | null>(null);

  useEffect(() => {
    let stopped = false;
    const tick = () => {
      api<View>(`/checkout/${params.orderId}/status`)
        .then((payload) => {
          if (!stopped) setView(payload);
        })
        .catch(() => undefined);
    };
    tick();
    const timer = window.setInterval(tick, 2000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [params.orderId]);

  const done = view?.statusCopy === '开通完成';
  return (
    <main className="mx-auto max-w-xl space-y-3 px-6 py-10 text-sm">
      <h1 className="text-2xl font-semibold">
        {done ? '支付成功' : (view?.returnCopy ?? '正在确认支付结果')}
      </h1>
      <p>{view?.fulfillmentCopy ?? '正在确认支付结果'}</p>
      {done ? <p>{view?.planName} 套餐已开通</p> : null}
      {view?.invoiceNumber ? <p>账单号 {view.invoiceNumber}</p> : null}
      {view?.paidAt ? <p>生效时间 {new Date(view.paidAt).toLocaleString()}</p> : null}
      {done ? (
        <Link className="inline-block rounded bg-zinc-900 px-3 py-2 text-white" href="/dashboard">
          返回 LaunchOS
        </Link>
      ) : null}
    </main>
  );
}
