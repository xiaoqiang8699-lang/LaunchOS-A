ALTER TABLE "Plan" ADD COLUMN "priceMonthlyCents" INTEGER;
ALTER TABLE "PlanVersion" ADD COLUMN "priceMonthlyCents" INTEGER;
ALTER TABLE "CommercialOrder" ADD COLUMN "totalAmountCents" INTEGER;
ALTER TABLE "Payment" ADD COLUMN "isProductionTest" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Payment" ADD COLUMN "amountCents" INTEGER;
ALTER TABLE "Invoice" ADD COLUMN "amountCents" INTEGER;
ALTER TABLE "Invoice" ADD COLUMN "productionTest" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Refund" ADD COLUMN "amountCents" INTEGER;

INSERT INTO "Plan" (
  "id", "code", "name", "description", "priceMonthly", "priceMonthlyCents", "currency",
  "contactSales", "billingIntervalOptions", "status", "displayOrder", "highlighted",
  "featuresJson", "createdAt", "updatedAt"
)
SELECT
  'plan_payment_test',
  'PAYMENT_TEST',
  '支付联调测试',
  '仅供平台管理员在指定测试工作空间做支付宝生产小额联调。',
  0,
  90,
  'CNY',
  false,
  '["monthly"]'::jsonb,
  'INTERNAL_TEST',
  90,
  false,
  '{}'::jsonb,
  NOW(),
  NOW()
WHERE NOT EXISTS (SELECT 1 FROM "Plan" WHERE "code" = 'PAYMENT_TEST');

INSERT INTO "PlanVersion" (
  "id", "planId", "version", "effectiveFrom", "priceMonthly", "priceMonthlyCents",
  "currency", "limitsJson", "featuresJson", "grandfathered", "createdAt"
)
SELECT
  'plan_payment_test_v1',
  'plan_payment_test',
  1,
  NOW(),
  0,
  90,
  'CNY',
  '{}'::jsonb,
  '{}'::jsonb,
  false,
  NOW()
WHERE NOT EXISTS (SELECT 1 FROM "PlanVersion" WHERE "id" = 'plan_payment_test_v1');
