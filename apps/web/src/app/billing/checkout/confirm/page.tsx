'use client';

import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { PageHeader, Section, Card } from '@/components/ui/section';

type Preview = {
  plan: string;
  billingCycle: string;
  amountFen: number;
  amountDisplay: string;
  currentPlan: string;
  targetPlan: string;
  effectiveRuleSummary: string;
  autoRenew: boolean;
  refundPolicySummary: string;
  cancelPolicySummary: string;
  workspaceName: string;
  realPaymentWarning: string;
  betaNotice: string | null;
  termsVersion: string;
};

function ConfirmInner() {
  const params = useSearchParams();
  const router = useRouter();
  const planCode = (params.get('plan') || 'pro').toLowerCase();
  const cycle = (params.get('cycle') || 'MONTHLY').toUpperCase();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [accept, setAccept] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Preview>('/billing/checkout/preview', {
      method: 'POST',
      body: JSON.stringify({ planCode, billingCycle: cycle }),
    })
      .then(setPreview)
      .catch((e: Error) => setError(e.message || '无法加载购买预览'));
  }, [planCode, cycle]);

  async function confirm() {
    if (!accept || !preview) return;
    setBusy(true);
    setError(null);
    try {
      const intent = await api<{ intentId: string }>('/billing/checkout/confirm', {
        method: 'POST',
        body: JSON.stringify({ planCode, billingCycle: cycle, acceptTerms: true }),
      });
      const checkout = await api<{
        available?: boolean;
        code?: string;
        message?: string;
        checkoutUrl?: string | null;
      }>('/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ planCode, billingCycle: cycle, purchaseIntentId: intent.intentId }),
      });
      if (!checkout.available) {
        setError(checkout.message || '真实支付暂未开放');
        return;
      }
      if (checkout.checkoutUrl) {
        window.location.href = checkout.checkoutUrl;
        return;
      }
      router.push('/billing');
    } catch (e) {
      setError(e instanceof Error ? e.message : '确认失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <PageHeader title="确认购买" description="支付前请核对套餐、金额与工作空间。当前正式收费仍默认关闭。" />
      {error ? <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{error}</p> : null}
      {preview ? (
        <Section title="订单摘要">
          <Card className="space-y-2 p-4 text-sm">
            <p>
              <span className="text-zinc-500">工作空间</span>：{preview.workspaceName}
            </p>
            <p>
              <span className="text-zinc-500">套餐</span>：{preview.targetPlan.toUpperCase()}（当前 {preview.currentPlan}）
            </p>
            <p>
              <span className="text-zinc-500">周期</span>：{preview.billingCycle === 'YEARLY' ? '年付' : '月付'}
            </p>
            <p>
              <span className="text-zinc-500">金额</span>：{preview.amountDisplay}
            </p>
            <p>
              <span className="text-zinc-500">生效</span>：{preview.effectiveRuleSummary}
            </p>
            <p>
              <span className="text-zinc-500">自动续费</span>：当前暂不支持自动续费 / 自动扣款
            </p>
            <p>
              <span className="text-zinc-500">取消</span>：{preview.cancelPolicySummary}
            </p>
            <p>
              <span className="text-zinc-500">退款</span>：{preview.refundPolicySummary}
            </p>
            {preview.betaNotice ? <p className="text-amber-800">{preview.betaNotice}</p> : null}
            <p className="font-medium text-red-700">{preview.realPaymentWarning}</p>
          </Card>
          <label className="mt-3 flex items-start gap-2 text-sm">
            <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} className="mt-1" />
            <span>
              我已确认套餐价格、计费周期、到期与取消规则，并同意服务条款与隐私政策（版本 {preview.termsVersion}）。当前购买为单周期主动支付，不会默认自动续订。
            </span>
          </label>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              disabled={!accept || busy}
              onClick={() => void confirm()}
              className="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? '处理中…' : `确认支付 ${preview.amountDisplay}`}
            </button>
            <Link href="/plan" className="rounded border px-4 py-2 text-sm">
              返回套餐
            </Link>
          </div>
        </Section>
      ) : (
        <p className="text-sm text-zinc-500">加载预览…</p>
      )}
    </div>
  );
}

export default function CheckoutConfirmPage() {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-zinc-500">加载中…</p>}>
      <ConfirmInner />
    </Suspense>
  );
}
