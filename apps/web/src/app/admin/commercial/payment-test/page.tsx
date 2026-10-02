'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { PageHeader, Section, Card } from '@/components/ui/section';
import { PrimaryButton, SecondaryButton } from '@/components/ui/button';
import { InlineAlert } from '@/components/ui/feedback';

type ReusablePending = {
  paymentId: string;
  orderId: string;
  outTradeNo: string;
  amountFen: number;
  amountLabel: string;
  status: string;
  statusLabel: string;
  createdAt: string;
  orderNumber: string | null;
  providerNote: string | null;
};

type Status = {
  amountFen: number;
  amountLabel: string;
  environment: string;
  planCode: string;
  planStatus: string | null;
  hidden: boolean;
  internalOnly: boolean;
  buttonEnabled: boolean;
  disabledReason: string | null;
  warning: string;
  providerConfigured: boolean;
  providerStatus: string;
  workspaceId: string | null;
  reusablePending: ReusablePending | null;
  canCreateNew: boolean;
  emptyPendingLabel: string;
  gates: {
    REAL_PAYMENTS_ENABLED: boolean;
    PAYMENT_TEST_REAL_ENABLED: boolean;
    ALIPAY_PRODUCTION_TEST_ENABLED: boolean;
  };
};

function formatCreatedAt(value: string) {
  try {
    return new Date(value).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return value;
  }
}

export default function AdminPaymentTestPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  function load() {
    api<Status>('/admin/commercial/payment-test')
      .then(setStatus)
      .catch((reason) => setError(reason instanceof ApiError ? reason.message : '加载失败'));
  }

  useEffect(() => {
    load();
  }, []);

  async function continuePay() {
    if (!status?.buttonEnabled || !status.reusablePending) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await api<{ checkoutUrl?: string; paymentId?: string; reused?: boolean; merchantOrderNo?: string }>(
        '/admin/payment-providers/alipay/production-test/continue',
        {
          method: 'POST',
          body: JSON.stringify({ paymentId: status.reusablePending.paymentId }),
        },
      );
      setMessage(`继续支付 ${result.merchantOrderNo ?? result.paymentId ?? ''}。请在支付宝完成真实付款。`);
      if (result.checkoutUrl) window.location.href = result.checkoutUrl;
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : '继续支付失败');
      load();
    } finally {
      setBusy(false);
    }
  }

  async function startTest() {
    if (!status?.buttonEnabled || !status.canCreateNew) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await api<{ checkoutUrl?: string; paymentId?: string; reused?: boolean; merchantOrderNo?: string }>(
        '/admin/payment-providers/alipay/production-test',
        {
          method: 'POST',
          body: '{}',
        },
      );
      setMessage(
        result.reused
          ? `已复用待支付订单 ${result.merchantOrderNo ?? result.paymentId ?? ''}。请在支付宝完成真实付款。`
          : `已创建测试订单 ${result.merchantOrderNo ?? result.paymentId ?? ''}。请在支付宝完成真实付款。`,
      );
      if (result.checkoutUrl) window.location.href = result.checkoutUrl;
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : '创建失败');
    } finally {
      setBusy(false);
    }
  }

  if (!status && !error) return <p className="text-sm text-zinc-500">加载中…</p>;

  const reusable = status?.reusablePending ?? null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="真实支付宝支付测试"
        description="仅 PLATFORM_ADMIN。用于后续 ¥0.90 生产小额联调，不会开放正式套餐收费。"
      />
      <Link className="text-sm underline" href="/admin/commercial">
        返回商业与订阅
      </Link>
      {error ? <InlineAlert tone="error" title={error} /> : null}
      {message ? <InlineAlert tone="success" title={message} /> : null}
      {status ? (
        <Section title="PAYMENT_TEST">
          <Card className="space-y-3 p-4 text-sm">
            <p className="font-semibold text-amber-700">{status.warning}</p>
            <p>
              支付环境：
              <strong className="ml-1">{status.environment === 'PRODUCTION' ? '支付宝生产环境（PRODUCTION）' : status.environment}</strong>
            </p>
            <p>金额：{status.amountLabel}（{status.amountFen} 分）</p>
            <p>套餐：{status.planCode} · 状态 {status.planStatus ?? '—'}</p>
            <p>隐藏套餐：{status.hidden ? '是' : '否'} · 仅内部：{status.internalOnly ? '是' : '否'}</p>
            <p>Provider 状态：{status.providerStatus} · 已配置：{status.providerConfigured ? '是' : '否'}</p>
            <p>测试工作空间：{status.workspaceId ?? '未配置 ALIPAY_PRODUCTION_TEST_WORKSPACE_ID'}</p>
            <p>
              Feature Gate：REAL_PAYMENTS_ENABLED={String(status.gates.REAL_PAYMENTS_ENABLED)} ·
              PAYMENT_TEST_REAL_ENABLED={String(status.gates.PAYMENT_TEST_REAL_ENABLED)}
            </p>
            {!status.buttonEnabled ? (
              <InlineAlert tone="warning" title={status.disabledReason ?? '真实测试尚未开启。'} />
            ) : null}

            {reusable ? (
              <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3">
                <p className="font-semibold text-amber-900">待支付测试订单</p>
                <p>订单号：{reusable.outTradeNo}</p>
                <p>金额：{reusable.amountLabel}</p>
                <p>状态：{reusable.statusLabel}</p>
                <p>创建时间：{formatCreatedAt(reusable.createdAt)}</p>
                {reusable.providerNote ? <p className="text-zinc-600">说明：{reusable.providerNote}</p> : null}
                <div className="flex gap-2 pt-1">
                  <PrimaryButton disabled={!status.buttonEnabled || busy} onClick={() => void continuePay()}>
                    继续支付
                  </PrimaryButton>
                  <SecondaryButton onClick={load}>刷新状态</SecondaryButton>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-zinc-700">{status.emptyPendingLabel}</p>
                <div className="flex gap-2">
                  <PrimaryButton disabled={!status.buttonEnabled || !status.canCreateNew || busy} onClick={() => void startTest()}>
                    创建 ¥0.90 测试订单
                  </PrimaryButton>
                  <SecondaryButton onClick={load}>刷新状态</SecondaryButton>
                </div>
              </div>
            )}
          </Card>
        </Section>
      ) : null}
    </div>
  );
}
