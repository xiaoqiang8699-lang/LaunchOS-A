import { readCertRenewBeforeDays } from '@launchos/shared';

export type RenewWindowInput = {
  expiresAt: Date | string | null | undefined;
  now?: Date;
  renewBeforeDays?: number;
};

export type RenewWindowDecision = {
  shouldRenew: boolean;
  daysRemaining: number | null;
  renewBeforeDays: number;
  reason: 'MISSING_EXPIRY' | 'WITHIN_WINDOW' | 'NOT_YET' | 'EXPIRED';
};

export function daysUntil(expiresAt: Date, now = new Date()): number {
  const ms = expiresAt.getTime() - now.getTime();
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

export function shouldRenewCertificate(input: RenewWindowInput): RenewWindowDecision {
  const renewBeforeDays = input.renewBeforeDays ?? readCertRenewBeforeDays();
  if (!input.expiresAt) {
    return {
      shouldRenew: false,
      daysRemaining: null,
      renewBeforeDays,
      reason: 'MISSING_EXPIRY',
    };
  }
  const expiresAt =
    input.expiresAt instanceof Date ? input.expiresAt : new Date(input.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) {
    return {
      shouldRenew: false,
      daysRemaining: null,
      renewBeforeDays,
      reason: 'MISSING_EXPIRY',
    };
  }
  const now = input.now ?? new Date();
  const remaining = daysUntil(expiresAt, now);
  if (remaining <= 0) {
    return {
      shouldRenew: true,
      daysRemaining: remaining,
      renewBeforeDays,
      reason: 'EXPIRED',
    };
  }
  if (remaining <= renewBeforeDays) {
    return {
      shouldRenew: true,
      daysRemaining: remaining,
      renewBeforeDays,
      reason: 'WITHIN_WINDOW',
    };
  }
  return {
    shouldRenew: false,
    daysRemaining: remaining,
    renewBeforeDays,
    reason: 'NOT_YET',
  };
}

export function acmeChallengeHost(rootDomain: string): string {
  return `_acme-challenge.${rootDomain.trim().toLowerCase().replace(/^\.+|\.+$/g, '')}`;
}

export function systemWildcardDomain(rootDomain: string): string {
  return `*.${rootDomain.trim().toLowerCase().replace(/^\.+|\.+$/g, '')}`;
}
