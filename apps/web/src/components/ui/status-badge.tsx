import { cn } from '@/lib/utils';

export type StatusTone =
  | 'success'
  | 'warning'
  | 'error'
  | 'info'
  | 'neutral'
  | 'progress';

const TONE_CLASS: Record<StatusTone, string> = {
  success: 'bg-[var(--los-success-bg)] text-[var(--los-success)]',
  warning: 'bg-[var(--los-warning-bg)] text-[var(--los-warning)]',
  error: 'bg-[var(--los-error-bg)] text-[var(--los-error)]',
  info: 'bg-[var(--los-info-bg)] text-[var(--los-info)]',
  progress: 'bg-[var(--los-info-bg)] text-[var(--los-info)]',
  neutral: 'bg-[var(--los-neutral-bg)] text-[var(--los-neutral)]',
};

/** Map product/runtime status codes → user label + tone */
export function resolveStatusPresentation(raw: string | null | undefined): {
  label: string;
  tone: StatusTone;
} {
  const s = String(raw || 'UNKNOWN').toUpperCase();
  if (['HEALTHY', 'SUCCESS', 'OK', 'RUNNING', 'ACTIVE', 'READY'].includes(s)) {
    if (s === 'RUNNING' || s === 'ACTIVE') return { label: s === 'RUNNING' ? '运行中' : '正常', tone: 'success' };
    if (s === 'SUCCESS') return { label: '上线成功', tone: 'success' };
    return { label: '正常', tone: 'success' };
  }
  if (['DEPLOYING', 'QUEUED', 'CREATED', 'UPLOADING', 'BUILDING'].includes(s)) {
    return { label: '正在上线', tone: 'progress' };
  }
  if (['RESTORING', 'ROLLING_BACK'].includes(s)) {
    return { label: '正在恢复', tone: 'progress' };
  }
  if (['WARNING', 'DEGRADED', 'NEAR_LIMIT', 'STATUS_PENDING'].includes(s)) {
    return {
      label: s === 'STATUS_PENDING' ? '状态待确认' : '需要处理',
      tone: 'warning',
    };
  }
  if (['FAILED', 'ERROR', 'UNHEALTHY', 'OVER_LIMIT'].includes(s)) {
    return { label: s === 'FAILED' ? '上线失败' : '异常', tone: 'error' };
  }
  if (['STOPPED', 'CANCELLED', 'INACTIVE', 'EXPIRED'].includes(s)) {
    return { label: '已停止', tone: 'neutral' };
  }
  return { label: '状态待确认', tone: 'neutral' };
}

export function StatusBadge({
  status,
  label,
  tone,
  className,
}: {
  status?: string | null;
  label?: string;
  tone?: StatusTone;
  className?: string;
}) {
  const resolved = resolveStatusPresentation(status);
  const text = label ?? resolved.label;
  const color = tone ?? resolved.tone;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
        TONE_CLASS[color],
        className,
      )}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          color === 'success' && 'bg-[var(--los-success)]',
          color === 'warning' && 'bg-[var(--los-warning)]',
          color === 'error' && 'bg-[var(--los-error)]',
          (color === 'info' || color === 'progress') && 'bg-[var(--los-info)]',
          color === 'neutral' && 'bg-[var(--los-muted)]',
        )}
        aria-hidden
      />
      {text}
    </span>
  );
}
