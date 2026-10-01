'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';

type Account = {
  environment: string;
  appId: string | null;
  status: string;
  privateKeyConfigured: boolean;
  lastVerifiedAt: string | null;
  lastWebhookStatus: string | null;
};

export default function PaymentProvidersPage() {
  const [sandbox, setSandbox] = useState<Account | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ sandbox: Account }>('/admin/payment-providers/alipay').then((payload) => setSandbox(payload.sandbox)).catch((reason) => setError(reason instanceof ApiError ? reason.message : '加载失败'));
  }, []);

  return (
    <section className="space-y-4 text-sm">
      <h2 className="text-xl font-semibold">支付渠道</h2>
      <p className="text-zinc-500">当前正式渠道只准备支付宝。微信支付和 Stripe 尚未接入。真实扣款默认关闭。</p>
      {error ? <p className="text-red-600">{error}</p> : null}
      <Link className="block rounded-lg border bg-white px-4 py-3" href="/admin/payment-providers/alipay">
        <p className="font-medium">支付宝</p>
        <p className="text-zinc-500">{sandbox ? `${sandbox.environment} · ${sandbox.appId ?? '未填写 AppID'} · ${sandbox.status}` : '加载中'}</p>
      </Link>
    </section>
  );
}
