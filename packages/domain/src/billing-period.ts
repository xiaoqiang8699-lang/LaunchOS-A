import { addCalendarMonths, zonedParts, zonedDateTimeToUtc, DEFAULT_BUSINESS_TIMEZONE } from './subscription-operations';
import { type BillingCycle, parseBillingCycle } from './subscription-lifecycle';

export function addCalendarYears(instant: Date, years: number, timeZone: string): Date {
  return addCalendarMonths(instant, years * 12, timeZone);
}

/**
 * Calendar billing period end (UTC stored; computed in business timezone).
 * MONTHLY / YEARLY use calendar arithmetic — never fixed 30/365 days.
 * NONE returns startAt unchanged (Free / no paid period).
 */
export function calculatePeriodEnd(
  startAt: Date,
  billingCycle: BillingCycle | string,
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE,
): Date {
  const cycle = typeof billingCycle === 'string' ? parseBillingCycle(billingCycle) : billingCycle;
  if (cycle === 'NONE') return new Date(startAt.getTime());
  if (cycle === 'YEARLY') return addCalendarYears(startAt, 1, timeZone);
  return addCalendarMonths(startAt, 1, timeZone);
}

export function renewalDue(input: {
  currentPeriodEnd: Date | string;
  now: Date;
  windowDays?: number;
}): boolean {
  const end = typeof input.currentPeriodEnd === 'string' ? new Date(input.currentPeriodEnd) : input.currentPeriodEnd;
  const windowMs = (input.windowDays ?? 7) * 24 * 60 * 60 * 1000;
  const now = input.now.getTime();
  const endMs = end.getTime();
  return now >= endMs - windowMs && now < endMs;
}

export function gracePeriodEndFrom(periodEnd: Date, graceDays: number, timeZone: string = DEFAULT_BUSINESS_TIMEZONE): Date {
  const local = zonedParts(periodEnd, timeZone);
  const probe = new Date(Date.UTC(local.year, local.month - 1, local.day + graceDays, 12, 0, 0));
  return zonedDateTimeToUtc(
    {
      year: probe.getUTCFullYear(),
      month: probe.getUTCMonth() + 1,
      day: probe.getUTCDate(),
      hour: local.hour,
      minute: local.minute,
      second: local.second,
    },
    timeZone,
  );
}
