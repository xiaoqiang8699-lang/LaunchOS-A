export const CLOUD_ESTIMATE_DISCLAIMER = '预计云资源费用仅供参考，最终以实际云厂商费用为准。云资源费用为估算，最终费用以实际使用和云厂商结算为准。';
export const TAX_PENDING_COPY = '税费将在正式结算时确认';
export const COUPON_CLOSED_COPY = '本阶段不开放优惠码';
export const SETTLEMENT_REQUIRED_COPY = '只有真实结算时才写入账单事实';

export const COMMERCIAL_NOTIFICATION_TYPES = [
  'BILLING_PROFILE_INCOMPLETE',
  'ORDER_CREATED',
  'PAYMENT_PENDING',
  'PAYMENT_SUCCEEDED',
  'PAYMENT_FAILED',
  'INVOICE_AVAILABLE',
] as const;

export const CLOUD_COST_TYPES = ['SERVER', 'DATABASE', 'REDIS', 'STORAGE', 'BANDWIDTH', 'DOMAIN', 'OTHER'] as const;
export type CloudCostType = (typeof CLOUD_COST_TYPES)[number];
export type CostAmount = number | 'unknown';

export type CloudCostInput = {
  workspaceId: string | null;
  shared: boolean;
  resourceType: CloudCostType;
  resourceId: string;
  amount: number | null;
};

export function billingProfileAccess(role: string): { read: boolean; edit: boolean } {
  if (role === 'OWNER' || role === 'ADMIN') return { read: true, edit: true };
  if (role === 'MEMBER' || role === 'VIEWER') return { read: true, edit: false };
  return { read: false, edit: false };
}

export function validateBillingProfile(input: { billingEmail?: string | null; companyName?: string | null; taxId?: string | null }): { ok: true } | { ok: false; message: string } {
  const email = input.billingEmail?.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, message: '账单邮箱格式不正确' };
  return { ok: true };
}

export function profileIncomplete(input: { billingName?: string | null; billingEmail?: string | null }): boolean {
  return !input.billingName?.trim() || !input.billingEmail?.trim();
}

export function attributeCloudCosts(workspaceId: string, resources: CloudCostInput[]): CloudCostInput[] {
  return resources.filter((resource) => resource.workspaceId === workspaceId && resource.shared !== true);
}

function fold(items: CloudCostInput[], type: CloudCostType): CostAmount {
  const owned = items.filter((item) => item.resourceType === type);
  if (owned.length === 0) return 0;
  if (owned.some((item) => item.amount == null)) return 'unknown';
  return owned.reduce((sum, item) => sum + (item.amount ?? 0), 0);
}

export function estimateWorkspaceCloudCost(workspaceId: string, resources: CloudCostInput[]): {
  serverCost: CostAmount;
  databaseCost: CostAmount;
  redisCost: CostAmount;
  storageCost: CostAmount;
  bandwidthCost: CostAmount;
  domainCost: CostAmount;
  otherCost: CostAmount;
  totalEstimatedCloudCost: CostAmount;
} {
  const owned = attributeCloudCosts(workspaceId, resources);
  const serverCost = fold(owned, 'SERVER');
  const databaseCost = fold(owned, 'DATABASE');
  const redisCost = fold(owned, 'REDIS');
  const storageCost = fold(owned, 'STORAGE');
  const bandwidthCost = fold(owned, 'BANDWIDTH');
  const domainCost = fold(owned, 'DOMAIN');
  const otherCost = fold(owned, 'OTHER');
  const parts = [serverCost, databaseCost, redisCost, storageCost, bandwidthCost, domainCost, otherCost];
  const totalEstimatedCloudCost = parts.some((part) => part === 'unknown')
    ? 'unknown'
    : parts.reduce<number>((sum, part) => sum + (part === 'unknown' ? 0 : part), 0);
  return { serverCost, databaseCost, redisCost, storageCost, bandwidthCost, domainCost, otherCost, totalEstimatedCloudCost };
}

export function calculateWorkspacePriceBreakdown(input: {
  subscriptionFee: number | null;
  cloudResourceEstimatedCost: CostAmount;
  discount: number;
  currency: string;
}): {
  subscriptionFee: number | null;
  cloudResourceEstimatedCost: CostAmount;
  discount: number;
  taxEstimated: null;
  totalEstimated: number | 'unknown' | null;
  currency: string;
} {
  const cloud = input.cloudResourceEstimatedCost;
  const totalEstimated =
    input.subscriptionFee == null || cloud === 'unknown' ? (cloud === 'unknown' ? 'unknown' : null) : input.subscriptionFee + cloud - input.discount;
  return {
    subscriptionFee: input.subscriptionFee,
    cloudResourceEstimatedCost: cloud,
    discount: input.discount,
    taxEstimated: null,
    totalEstimated,
    currency: input.currency,
  };
}

export function presentPriceBreakdown(input: {
  planName: string;
  subscriptionFee: number | null;
  contactSales: boolean;
  cloudResourceEstimatedCost: CostAmount;
  discount: number;
  totalEstimated: number | 'unknown' | null;
  currency: string;
  billingInterval?: 'monthly' | 'yearly';
}): {
  subscriptionFeeLabel: string;
  cloudCostLabel: string;
  discountLabel: string;
  taxLabel: string;
  totalLabel: string;
  disclaimer: string;
} {
  const period = input.billingInterval === 'yearly' ? '年' : '月';
  const money = (value: number) => `${value} ${input.currency} / ${period}`;
  const subscriptionFeeLabel = input.contactSales
    ? `${input.planName}：联系销售`
    : input.subscriptionFee == null
      ? `${input.planName}：价格尚未配置`
      : `${input.planName}：${money(input.subscriptionFee)}`;
  const cloudCostLabel = input.cloudResourceEstimatedCost === 'unknown'
    ? '预计云资源费用：暂未估算'
    : `预计云资源费用：${money(input.cloudResourceEstimatedCost)}`;
  const totalLabel = input.totalEstimated === 'unknown' || input.totalEstimated == null
    ? '预计合计：暂未估算'
    : `预计合计：${money(input.totalEstimated)}`;
  return {
    subscriptionFeeLabel,
    cloudCostLabel,
    discountLabel: input.discount > 0 ? `折扣：${input.discount} ${input.currency}` : '折扣：无',
    taxLabel: TAX_PENDING_COPY,
    totalLabel,
    disclaimer: CLOUD_ESTIMATE_DISCLAIMER,
  };
}

export function rejectCouponEntry(): { ok: false; message: string } {
  return { ok: false, message: COUPON_CLOSED_COPY };
}

export function buildCheckoutDraft(input: {
  orderNumber: string;
  type: 'SUBSCRIPTION_NEW' | 'SUBSCRIPTION_UPGRADE' | 'SUBSCRIPTION_RENEWAL' | 'OTHER';
  planId: string;
  planVersionId: string | null;
  billingInterval: 'monthly' | 'yearly';
  breakdown: ReturnType<typeof calculateWorkspacePriceBreakdown>;
}): {
  orderNumber: string;
  status: 'DRAFT';
  type: typeof input.type;
  planId: string;
  planVersionId: string | null;
  billingInterval: 'monthly' | 'yearly';
  subscriptionFee: number | null;
  cloudCostEstimate: number | null;
  discountAmount: number;
  taxAmount: null;
  totalAmount: number | null;
  payment: null;
  invoice: null;
} {
  return {
    orderNumber: input.orderNumber,
    status: 'DRAFT',
    type: input.type,
    planId: input.planId,
    planVersionId: input.planVersionId,
    billingInterval: input.billingInterval,
    subscriptionFee: input.breakdown.subscriptionFee,
    cloudCostEstimate: input.breakdown.cloudResourceEstimatedCost === 'unknown' ? null : input.breakdown.cloudResourceEstimatedCost,
    discountAmount: input.breakdown.discount,
    taxAmount: null,
    totalAmount: typeof input.breakdown.totalEstimated === 'number' ? input.breakdown.totalEstimated : null,
    payment: null,
    invoice: null,
  };
}

export function assertOrderStaysUnpaid(status: string): { ok: true } | { ok: false; message: string } {
  if (status === 'PAID') return { ok: false, message: '未接支付，不能把订单标成已支付' };
  return { ok: true };
}

export function manualActivationMarker(): { paymentStatus: 'NOT_APPLICABLE'; activationSource: 'MANUAL_ADMIN'; createsPaidOrder: false; createsPayment: false } {
  return { paymentStatus: 'NOT_APPLICABLE', activationSource: 'MANUAL_ADMIN', createsPaidOrder: false, createsPayment: false };
}

export function canCreateRealPayment(): false {
  return false;
}

export function recognizedMargin(input: { recognizedSubscriptionRevenue: number | null; actualCloudCost: number | null }): number | null {
  if (input.recognizedSubscriptionRevenue == null || input.actualCloudCost == null) return null;
  return input.recognizedSubscriptionRevenue - input.actualCloudCost;
}

export function estimatedCostEnforcement(): { suspend: false; pastDue: false; dunning: false; reclaim: false } {
  return { suspend: false, pastDue: false, dunning: false, reclaim: false };
}

export interface CloudBillingProvider {
  fetchResourceCosts(input: { workspaceId: string }): Promise<{ available: false; message: string }>;
  fetchWorkspaceCosts(input: { workspaceId: string }): Promise<{ available: false; message: string }>;
  reconcileCosts(input: { workspaceId: string }): Promise<{ available: false; message: string }>;
}

const cloudBillUnavailable = async (): Promise<{ available: false; message: string }> => ({ available: false, message: '云账单接口尚未接入' });

export const unavailableCloudBillingProvider: CloudBillingProvider = {
  fetchResourceCosts: cloudBillUnavailable,
  fetchWorkspaceCosts: cloudBillUnavailable,
  reconcileCosts: cloudBillUnavailable,
};

export function canWriteInvoiceFacts(paymentStatus: string | null): boolean {
  return paymentStatus === 'SUCCEEDED';
}

export function buildInvoiceSnapshot(input: {
  billingProfile: Record<string, string | null>;
  planVersion: { id: string; version: number; priceMonthly: number; priceYearly: number | null; limitsJson: unknown; featuresJson: unknown };
  subscriptionAmount: number | null;
  cloudResourceAmount: number | null;
  discountAmount: number;
  taxAmount: number | null;
  currency: string;
}): {
  billingProfileSnapshot: Record<string, string | null>;
  planVersionSnapshot: { id: string; version: number; priceMonthly: number; priceYearly: number | null; limitsJson: unknown; featuresJson: unknown };
  subscriptionAmount: number | null;
  cloudResourceAmount: number | null;
  discountAmount: number;
  taxAmount: number | null;
  totalAmount: number | null;
  currency: string;
} {
  const totalAmount = input.subscriptionAmount == null || input.cloudResourceAmount == null
    ? null
    : input.subscriptionAmount + input.cloudResourceAmount - input.discountAmount + (input.taxAmount ?? 0);
  return {
    billingProfileSnapshot: { ...input.billingProfile },
    planVersionSnapshot: { ...input.planVersion, limitsJson: input.planVersion.limitsJson, featuresJson: input.planVersion.featuresJson },
    subscriptionAmount: input.subscriptionAmount,
    cloudResourceAmount: input.cloudResourceAmount,
    discountAmount: input.discountAmount,
    taxAmount: input.taxAmount,
    totalAmount,
    currency: input.currency,
  };
}

export function commercialDocuments(): ['CommercialOrder', 'Invoice', 'Payment'] {
  return ['CommercialOrder', 'Invoice', 'Payment'];
}
