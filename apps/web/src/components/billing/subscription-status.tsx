'use client';

import { StatusBadge } from '@/components/ui/status-badge';

export function subscriptionDisplayStatus(input: {
  status?: string | null;
  cancelAtPeriodEnd?: boolean;
  statusLabel?: string | null;
}): { label: string; toneStatus: string } {
  if (input.cancelAtPeriodEnd || input.status === 'CANCEL_AT_PERIOD_END') {
    return { label: '将在周期结束后取消', toneStatus: 'WARNING' };
  }
  if (input.status === 'TRIALING') return { label: '试用中', toneStatus: 'RUNNING' };
  if (input.status === 'PAST_DUE') return { label: '待处理', toneStatus: 'WARNING' };
  if (input.status === 'GRACE_PERIOD') return { label: '宽限期', toneStatus: 'WARNING' };
  if (input.status === 'CANCELED') return { label: '已取消', toneStatus: 'FAILED' };
  if (input.status === 'EXPIRED') return { label: '已过期', toneStatus: 'FAILED' };
  return { label: input.statusLabel || '正常', toneStatus: 'SUCCESS' };
}

export function SubscriptionStatus({
  status,
  cancelAtPeriodEnd,
  statusLabel,
}: {
  status?: string | null;
  cancelAtPeriodEnd?: boolean;
  statusLabel?: string | null;
}) {
  const display = subscriptionDisplayStatus({ status, cancelAtPeriodEnd, statusLabel });
  return <StatusBadge status={display.toneStatus} label={display.label} />;
}
