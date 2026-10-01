'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';

type Row = {
  workspaceId: string;
  workspaceName: string;
  ownerEmail: string;
  planName: string;
  subscriptionFee: number | null;
  currency: string;
  estimatedCloudCost: number | null;
  estimatedGrossMargin: number | null;
  profileStatus: string;
  orderStatus: string;
};

const ORDER: Record<string, string> = { NONE: '无订单', DRAFT: '草稿', PENDING_PAYMENT: '待支付', PAID: '已支付', CANCELED: '已取消', EXPIRED: '已过期' };

export default function AdminBillingPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api<Row[]>('/admin/billing').then(setRows).catch((reason) => setError(reason instanceof ApiError ? reason.message : '加载失败'));
  }, []);

  return (
    <section className="space-y-4">
      <h2 className="text-xl font-semibold">计费</h2>
      <p className="text-sm text-zinc-500">毛利只在确认订阅收入和实际云成本之后计算。手动开通和估算费用不算利润。</p>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <ul className="divide-y rounded-lg border bg-white">
        {rows.map((row) => (
          <li key={row.workspaceId} className="space-y-1 px-4 py-3 text-sm">
            <p className="font-medium">{row.workspaceName}</p>
            <p>{row.ownerEmail} · {row.planName}</p>
            <p>套餐费 {row.subscriptionFee == null ? '联系销售' : `${row.subscriptionFee} ${row.currency}`}</p>
            <p>预计云资源 {row.estimatedCloudCost == null ? '暂未估算' : `${row.estimatedCloudCost} ${row.currency}`}</p>
            <p>预计毛利 {row.estimatedGrossMargin == null ? '暂无' : row.estimatedGrossMargin}</p>
            <p>账单资料 {row.profileStatus} · 订单 {ORDER[row.orderStatus] ?? row.orderStatus}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
