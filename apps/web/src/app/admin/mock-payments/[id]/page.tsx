'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';

const ACTIONS: Array<[string, string]> = [
  ['succeed', '模拟支付成功'],
  ['fail', '模拟支付失败'],
  ['cancel', '模拟取消'],
  ['duplicate', '模拟重复回调'],
  ['mismatch', '模拟金额不匹配'],
  ['currency-mismatch', '模拟币种不匹配'],
  ['arm-failure', '模拟开通失败一次'],
  ['refund', '模拟退款'],
  ['partial-refund', '模拟部分退款'],
];

export default function MockPaymentPage() {
  const params = useParams<{ id: string }>();
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function run(action: string) {
    setError('');
    try {
      const result = await api<unknown>(`/admin/mock-payments/${params.id}/${action}`, { method: 'POST' });
      setMessage(JSON.stringify(result));
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : '操作失败');
    }
  }

  return (
    <section className="space-y-4">
      <h2 className="text-xl font-semibold">模拟支付</h2>
      <p className="text-sm text-zinc-500">只在开发和测试环境给平台管理员使用。普通用户账单页不会出现这些按钮。</p>
      <Link className="text-sm underline" href={`/admin/payments/${params.id}`}>返回支付详情</Link>
      <div className="flex flex-wrap gap-2">
        {ACTIONS.map(([action, label]) => (
          <button key={action} className="rounded border px-3 py-1.5 text-sm" type="button" onClick={() => void run(action)}>{label}</button>
        ))}
      </div>
      {message ? <pre className="overflow-auto rounded bg-white p-3 text-xs">{message}</pre> : null}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </section>
  );
}
