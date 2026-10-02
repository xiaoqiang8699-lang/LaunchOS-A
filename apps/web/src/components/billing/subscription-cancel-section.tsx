'use client';

import { useState } from 'react';
import { DangerButton, PrimaryButton, SecondaryButton } from '@/components/ui/button';
import { Card, Section } from '@/components/ui/section';
import { InlineAlert } from '@/components/ui/feedback';
import { api, ApiError } from '@/lib/api';

export function SubscriptionCancelSection({
  canCancel,
  cancelAtPeriodEnd,
  periodEndLabel,
  onChanged,
}: {
  canCancel: boolean;
  cancelAtPeriodEnd: boolean;
  periodEndLabel?: string | null;
  onChanged: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function cancel() {
    setBusy(true);
    setError('');
    try {
      await api('/billing/subscription/cancel', { method: 'POST', body: '{}' });
      setConfirmOpen(false);
      onChanged();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : '取消失败');
    } finally {
      setBusy(false);
    }
  }

  async function resume() {
    setBusy(true);
    setError('');
    try {
      await api('/billing/subscription/resume', { method: 'POST', body: '{}' });
      onChanged();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : '恢复失败');
    } finally {
      setBusy(false);
    }
  }

  if (cancelAtPeriodEnd) {
    return (
      <Section title="取消订阅">
        <Card className="space-y-3 p-5">
          <p className="font-medium">已预约到期取消</p>
          <p className="text-sm text-[var(--los-secondary)]">
            当前套餐仍可使用至 {periodEndLabel || '本周期结束'}。到期后将回退到可用的基础套餐，已有数据不会被删除。
          </p>
          <p className="text-sm text-[var(--los-secondary)]">
            恢复后，本周期不会在到期时自动结束。当前版本暂不支持自动扣款，后续周期仍需主动完成续费。
          </p>
          {error ? <InlineAlert tone="error" title={error} /> : null}
          <PrimaryButton type="button" disabled={busy} onClick={() => void resume()}>
            恢复订阅
          </PrimaryButton>
        </Card>
      </Section>
    );
  }

  if (!canCancel) return null;

  return (
    <Section title="取消订阅">
      <Card className="space-y-3 p-5">
        <p className="text-sm text-[var(--los-secondary)]">
          取消后，当前套餐仍可使用至周期结束；到期后回退到基础套餐。已有数据不会被删除。
        </p>
        {error ? <InlineAlert tone="error" title={error} /> : null}
        <DangerButton type="button" onClick={() => setConfirmOpen(true)}>
          取消订阅
        </DangerButton>
      </Card>

      {confirmOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal>
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
            <h3 className="text-lg font-semibold">确认到期取消</h3>
            <p className="mt-2 text-sm text-[var(--los-secondary)]">
              取消后，当前套餐仍可使用至 {periodEndLabel || 'YYYY-MM-DD'}，到期后将自动回退到可用的基础套餐。已有数据不会被删除。
            </p>
            {error ? <InlineAlert className="mt-3" tone="error" title={error} /> : null}
            <div className="mt-4 flex justify-end gap-2">
              <SecondaryButton type="button" disabled={busy} onClick={() => setConfirmOpen(false)}>
                返回
              </SecondaryButton>
              <DangerButton type="button" disabled={busy} onClick={() => void cancel()}>
                确认到期取消
              </DangerButton>
            </div>
          </div>
        </div>
      ) : null}
    </Section>
  );
}
