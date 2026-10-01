'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';

type Order = {
  id: string;
  orderNumber: string;
  workspaceName: string;
  ownerEmail: string;
  type: string;
  planName: string;
  totalAmount: number | null;
  subscriptionFee: number | null;
  currency: string;
  status: string;
  createdAt: string;
};

const STATUS: Record<string, string> = {
  DRAFT: '草稿',
  PENDING_PAYMENT: '待支付',
  PAID: '已支付',
  CANCELED: '已取消',
  EXPIRED: '已过期',
};

const TYPE: Record<string, string> = {
  SUBSCRIPTION_NEW: '新订阅',
  SUBSCRIPTION_UPGRADE: '升级',
  SUBSCRIPTION_RENEWAL: '续费',
  OTHER: '其他',
};

export default function AdminOrdersPage() {
  const [rows, setRows] = useState<Order[]>([]);
  const [error, setError] = useState('');

  function load() {
    api<Order[]>('/admin/orders').then(setRows).catch((reason) => setError(reason instanceof ApiError ? reason.message : '加载失败'));
  }

  useEffect(() => { load(); }, []);

  return (
    <section className="space-y-4">
      <h2 className="text-xl font-semibold">订单</h2>
      <p className="text-sm text-zinc-500">订单表示准备购买的内容。这里的草稿还没有支付，也不会写成账单。</p>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <ul className="divide-y rounded-lg border bg-white">
        {rows.length === 0 ? <li className="px-4 py-3 text-sm text-zinc-500">还没有订单</li> : null}
        {rows.map((row) => (
          <li key={row.id} className="space-y-1 px-4 py-3 text-sm">
            <p className="font-medium">{row.orderNumber}</p>
            <p>{row.workspaceName} · {row.ownerEmail}</p>
            <p>{TYPE[row.type] ?? row.type} · {row.planName} · {STATUS[row.status] ?? row.status}</p>
            <p>{row.totalAmount == null ? '预计应付暂未估算' : `${row.totalAmount} ${row.currency}`} · {new Date(row.createdAt).toLocaleString()}</p>
            {row.status === 'DRAFT' ? (
              <button className="rounded border px-3 py-1" type="button" onClick={() => void api(`/admin/orders/${row.id}/cancel`, { method: 'POST' }).then(load)}>取消草稿</button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
