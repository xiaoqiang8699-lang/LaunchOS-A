'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';

type Detail = {
  payment: { id: string; provider: string | null; providerLabel?: string | null; amount: number; currency: string; statusLabel: string; attemptNumber: number; paidAt: string | null; failureMessageSafe: string | null; isTestPayment: boolean; merchantOrderNo?: string | null; providerTradeNo?: string | null; environment?: string | null; lastQueryState?: string | null };
  order: { orderNumber: string; statusLabel: string; totalAmount: number | null };
  workspace: { name: string };
  invoice: { invoiceNumber: string | null; amount: number } | null;
  subscription: { status: string; plan: string; source: string } | null;
  webhooks: Array<{ id: string; eventType: string; status: string; errorCode: string | null }>;
  refunds: Array<{ amount: number; status: string }>;
  reconciliation: string;
  revenueBucket: string;
};

export default function AdminPaymentDetailPage() {
  const params = useParams<{ id: string }>();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  function load() {
    api<Detail>(`/admin/payments/${params.id}`).then(setDetail).catch((reason) => setError(reason instanceof ApiError ? reason.message : '加载失败'));
  }

  useEffect(() => { load(); }, [params.id]);

  async function act(path: string) {
    setError('');
    try {
      await api(path, { method: 'POST' });
      setMessage('已处理');
      load();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : '操作失败');
    }
  }

  if (!detail) return <p className="text-sm text-zinc-500">{error || '加载中…'}</p>;
  return (
    <section className="space-y-4 text-sm">
      <h2 className="text-xl font-semibold">支付详情</h2>
      <p>{detail.workspace.name} · 订单 {detail.order.orderNumber} · {detail.order.statusLabel}</p>
      <p>{detail.payment.providerLabel ?? detail.payment.provider} · {detail.payment.amount} {detail.payment.currency} · {detail.payment.statusLabel} · 第 {detail.payment.attemptNumber} 次</p>
      {detail.payment.merchantOrderNo ? <p>商户订单号 {detail.payment.merchantOrderNo}</p> : null}
      {detail.payment.providerTradeNo ? <p>支付宝交易号 {detail.payment.providerTradeNo}</p> : null}
      {detail.payment.lastQueryState ? <p>查单状态 {detail.payment.lastQueryState === 'UNKNOWN_PENDING' ? '正在确认' : detail.payment.lastQueryState}</p> : null}
      <p>{detail.payment.isTestPayment ? '测试支付' : '正式支付'} · {detail.payment.paidAt ? new Date(detail.payment.paidAt).toLocaleString() : '未支付'}</p>
      {detail.payment.failureMessageSafe ? <p>{detail.payment.failureMessageSafe}</p> : null}
      <p>订阅 {detail.subscription ? `${detail.subscription.plan} · ${detail.subscription.status}` : '无'} · 账单 {detail.invoice?.invoiceNumber ?? '还没有账单'}</p>
      <p>核对 {detail.reconciliation} · 收入分类 {detail.revenueBucket === 'test' ? '测试' : detail.revenueBucket === 'real' ? '真实' : '未确认'}</p>
      <div className="flex flex-wrap gap-2">
        <button className="rounded border px-3 py-1" type="button" onClick={() => void act(`/admin/payments/${params.id}/retry`)}>重试开通</button>
        <button className="rounded border px-3 py-1" type="button" onClick={() => void act(`/admin/payments/${params.id}/retry-webhook`)}>重试通知处理</button>
        <button className="rounded border px-3 py-1" type="button" onClick={() => void act('/admin/payments/reconcile')}>运行核对</button>
        <Link className="rounded border px-3 py-1" href={`/admin/mock-payments/${params.id}`}>模拟支付操作</Link>
      </div>
      <h3 className="font-medium">通知</h3>
      <ul>{detail.webhooks.map((event) => <li key={event.id}>{event.eventType} · {event.status}{event.errorCode ? ` · ${event.errorCode}` : ''}</li>)}</ul>
      <h3 className="font-medium">退款</h3>
      <ul>{detail.refunds.length === 0 ? <li>没有退款</li> : detail.refunds.map((refund, index) => <li key={index}>{refund.amount} · {refund.status}</li>)}</ul>
      {message ? <p>{message}</p> : null}
      {error ? <p className="text-red-600">{error}</p> : null}
    </section>
  );
}
