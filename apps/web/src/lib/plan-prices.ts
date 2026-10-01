/** Customer-facing plan prices (must stay in sync with public pricing). */
export const PLAN_LIST_PRICES: Record<
  string,
  { monthly: string; yearly: string | null }
> = {
  free: { monthly: '免费', yearly: null },
  pro: { monthly: '¥99 / 月', yearly: '¥990 / 年' },
  team: { monthly: '¥299 / 月', yearly: '¥2990 / 年' },
  enterprise: { monthly: '联系销售', yearly: null },
};

export function presentPlanPrice(
  code: string,
  fallbackLabel?: string | null,
  unit: '月' | '年' = '月',
): string {
  const known = PLAN_LIST_PRICES[code.toLowerCase()];
  if (known) {
    return unit === '年' ? known.yearly ?? known.monthly : known.monthly;
  }
  if (!fallbackLabel) return '价格待确认';
  const matched = fallbackLabel.match(/^(\d+(?:\.\d+)?) CNY \/ (月|年)$/);
  if (matched) return `¥${matched[1]} / ${matched[2]}`;
  return fallbackLabel;
}

export function isBetaEntitlementSource(source?: string | null, reason?: string | null): boolean {
  return source === 'BETA_TESTER_OVERRIDE' || /Beta/i.test(reason || '');
}
