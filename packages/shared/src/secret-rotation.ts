export type SecretRotationStatus =
  | 'CURRENT'
  | 'DUE_SOON'
  | 'OVERDUE'
  | 'PENDING_REDEPLOY'
  | 'MISSING';

export const ROTATION_INTERVAL_OPTIONS = [30, 60, 90, 180] as const;
export type RotationIntervalDays = (typeof ROTATION_INTERVAL_OPTIONS)[number];

export type ComputeRotationStatusInput = {
  configured: boolean;
  needsRedeploy: boolean;
  lastRotatedAt: Date | string | null | undefined;
  rotationIntervalDays: number | null | undefined;
  now?: Date;
};

const DUE_SOON_LEAD_DAYS = 15;

export function daysSince(date: Date | string, now: Date = new Date()): number {
  const then = typeof date === 'string' ? new Date(date) : date;
  const diffMs = now.getTime() - then.getTime();
  return Math.max(0, Math.floor(diffMs / (24 * 60 * 60 * 1000)));
}

export function computeRotationStatus(input: ComputeRotationStatusInput): SecretRotationStatus {
  if (!input.configured) {
    return 'MISSING';
  }
  if (input.needsRedeploy) {
    return 'PENDING_REDEPLOY';
  }

  const interval = input.rotationIntervalDays;
  if (!interval || interval <= 0) {
    return 'CURRENT';
  }

  const anchor = input.lastRotatedAt ?? null;
  if (!anchor) {
    return 'CURRENT';
  }

  const elapsed = daysSince(anchor, input.now);
  if (elapsed >= interval) {
    return 'OVERDUE';
  }
  if (elapsed >= interval - DUE_SOON_LEAD_DAYS) {
    return 'DUE_SOON';
  }
  return 'CURRENT';
}

export function rotationStatusLabel(status: SecretRotationStatus): string {
  switch (status) {
    case 'CURRENT':
      return '当前版本已生效';
    case 'DUE_SOON':
      return '建议更新';
    case 'OVERDUE':
      return '建议更新此密钥';
    case 'PENDING_REDEPLOY':
      return '等待重新上线生效';
    case 'MISSING':
      return '缺失';
    default:
      return status;
  }
}

export function formatDaysAgo(date: Date | string | null | undefined, now: Date = new Date()): string | null {
  if (!date) {
    return null;
  }
  const days = daysSince(date, now);
  if (days === 0) {
    return '刚刚';
  }
  if (days === 1) {
    return '1 天前';
  }
  return `${days} 天前`;
}

export function suggestRotationIntervalDays(key: string): number | null {
  if (/JWT_SECRET|AUTH_SECRET|NEXTAUTH_SECRET|SESSION_SECRET|API_KEY|TOKEN|PASSWORD|DATABASE_URL/i.test(key)) {
    return 90;
  }
  return null;
}
