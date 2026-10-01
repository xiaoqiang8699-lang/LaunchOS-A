'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';

type Item = {
  id: string;
  orderNumber: string;
  workspaceName: string;
  provider: string | null;
  providerLabel?: string | null;
  amount: number;
  currency: string;
  statusLabel: string;
  attemptNumber: number;
  paidAt: string | null;
  createdAt: string;
  isTestPayment: boolean;
};

export default function AdminPaymentsPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [summary, setSummary] = useState<{ testRevenue: number; realRevenue: number } | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');

  function load(nextQ = q, nextStatus = status) {
    const params = new URLSearchParams();
    if (nextQ) params.set('q', nextQ);
    if (nextStatus) params.set('status', nextStatus);
    api<{ items: Item[] }>(`/admin/payments?${params.toString()}`).then((payload) => setItems(payload.items)).catch((reason) => setError(reason instanceof ApiError ? reason.message : '加载失败'));
  }

  useEffect(() => {
    load();
    api<{ testRevenue: number; realRevenue: number }>('/admin/payments/summary').then(setSummary).catch(() => undefined);
  }, []);

  return (
    <section className="space-y-4">
      <h2 className="text-xl font-semibold">支付</h2>
      <p className="text-sm text-zinc-500">测试收入 {summary?.testRevenue ?? 0} CNY。真实收入 {summary?.realRevenue ?? 0} CNY。模拟支付不计入真实收入。</p>
      <div className="flex gap-2">
        <input className="rounded border px-3 py-1.5 text-sm" placeholder="搜索订单或工作空间" value={q} onChange={(event) => setQ(event.target.value)} />
        <select className="rounded border px-3 py-1.5 text-sm" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">全部状态</option>
          <option value="PENDING">待支付</option>
          <option value="SUCCEEDED">支付成功</option>
          <option value="FAILED">支付失败</option>
          <option value="REQUIRES_REVIEW">待核对</option>
        </select>
        <button className="rounded border px-3 py-1.5 text-sm" type="button" onClick={() => load()}>筛选</button>
      </div>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <ul className="divide-y rounded-lg border bg-white">
        {items.length === 0 ? <li className="px-4 py-3 text-sm text-zinc-500">还没有支付</li> : null}
        {items.map((item) => (
          <li key={item.id} className="px-4 py-3 text-sm">
            <Link className="font-medium underline" href={`/admin/payments/${item.id}`}>{item.orderNumber}</Link>
            <p>{item.providerLabel ?? item.provider} · {item.amount} {item.currency}</p>
            <p>{item.statusLabel} · 第 {item.attemptNumber} 次 · {item.isTestPayment ? '测试支付' : '正式支付'}</p>
            <p>{item.paidAt ? new Date(item.paidAt).toLocaleString() : '未支付'} · 创建于 {new Date(item.createdAt).toLocaleString()}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
