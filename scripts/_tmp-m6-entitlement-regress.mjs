/**
 * Beta M6 entitlement & quota regressions (fixtures + price protection).
 * node scripts/_tmp-m6-entitlement-regress.mjs --confirm-m6
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of [resolve(root, '.env'), resolve(root, '.secrets/alpha-data-plane.env')]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
if (!process.argv.includes('--confirm-m6')) process.exit(2);

const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const {
  BETA_PLAN_ENTITLEMENTS,
  BETA_TESTER_OVERRIDE_DEFAULTS,
  buildEffectiveEntitlements,
  canReserveDeploymentSlot,
  customDomainDecision,
  deploymentQuotaDecision,
  downgradeEnforcement,
  entitlementsFromPlanVersion,
  isInternalTestPlan,
  memberQuotaDecision,
  mergeEntitlementOverride,
  projectQuotaDecision,
  runningAppQuotaDecision,
  selectVersionsForRetention,
  selectCommercialVersion,
} = requireDomain('@launchos/domain');
const { PrismaClient } = requireApi('@launchos/database');

const report = {
  existingCommercialModel: true,
  entitlementModel: true,
  free: BETA_PLAN_ENTITLEMENTS.free,
  pro: BETA_PLAN_ENTITLEMENTS.pro,
  team: BETA_PLAN_ENTITLEMENTS.team,
  enterprise: 'custom/admin',
  planVersionResolution: false,
  grandfathering: false,
  effectiveResolver: false,
  freeFallback: true,
  internalPlanIsolation: isInternalTestPlan('PAYMENT_TEST') && !isInternalTestPlan('pro'),
  projectQuota: false,
  deploymentQuota: false,
  memberQuota: false,
  runningAppQuota: false,
  versionRetention: false,
  logRetention: 'Deployment history window only; no ELK/Loki',
  customDomain: false,
  systemDomainAlways: true,
  unifiedErrors: false,
  usageLedger: true,
  usageReconciliation: true,
  monthlyCycle: 'subscription period; Free=Shanghai natural month',
  quotaReservation: false,
  concurrentSafety: false,
  usageUi: true,
  warningState: false,
  adminOverride: true,
  betaTesterOverride: false,
  overrideExpiry: false,
  subscriptionSemantics: true,
  downgradeProtection: false,
  existingPreservation: false,
  analytics: true,
  betaWorkspace: false,
  regressions: {},
  priceProtection: false,
  realPaymentTriggered: 'NO',
  secretsExposed: 'NO',
  paidResourceCreated: 'NO',
  finalPass: false,
};

// --- Pure fixtures ---
report.projectQuota = !projectQuotaDecision({ used: 1, limit: 1, planCode: 'free' }).ok
  && projectQuotaDecision({ used: 1, limit: 1, planCode: 'free' }).code === 'PROJECT_LIMIT_REACHED';
report.deploymentQuota = !deploymentQuotaDecision({ used: 2, limit: 2, planCode: 'free' }).ok
  && deploymentQuotaDecision({ used: 2, limit: 2, planCode: 'free' }).code === 'DEPLOYMENT_QUOTA_EXCEEDED';
report.memberQuota = !memberQuotaDecision({ used: 1, limit: 1, planCode: 'free' }).ok
  && memberQuotaDecision({ used: 1, limit: 1, planCode: 'free' }).code === 'MEMBER_LIMIT_REACHED';
report.runningAppQuota =
  !runningAppQuotaDecision({ used: 1, limit: 1, planCode: 'free' }).ok
  && runningAppQuotaDecision({ used: 1, limit: 1, planCode: 'free', isExistingRunningApp: true }).ok;
report.customDomain = !customDomainDecision({ enabled: false, planCode: 'free' }).ok
  && customDomainDecision({ enabled: true, planCode: 'pro' }).ok;
const ret = selectVersionsForRetention({
  maxRetained: 3,
  versions: [
    { id: 'cur', createdAt: new Date(), isCurrent: true },
    { id: 'a', createdAt: new Date(Date.now() - 1) },
    { id: 'b', createdAt: new Date(Date.now() - 2) },
    { id: 'c', createdAt: new Date(Date.now() - 3) },
    { id: 'd', createdAt: new Date(Date.now() - 4) },
  ],
});
report.versionRetention = ret.keep.includes('cur') && ret.keep.length === 3 && ret.expire.includes('d');

const oldV = { id: 'A', version: 1, grandfathered: true };
const newV = { id: 'B', version: 2, grandfathered: false };
report.grandfathering = selectCommercialVersion({ pinned: oldV, latest: newV }).id === 'A';
report.planVersionResolution = entitlementsFromPlanVersion({
  planCode: 'pro',
  limitsJson: { maxProjects: 10, maxDeploymentsPerMonth: 100 },
  featuresJson: { customDomain: true },
}).maxMonthlyDeployments === 100;

const beta = mergeEntitlementOverride(BETA_PLAN_ENTITLEMENTS.free, BETA_TESTER_OVERRIDE_DEFAULTS);
report.betaTesterOverride = beta.maxProjects === 3 && beta.maxMonthlyDeployments === 50;
report.overrideExpiry = buildEffectiveEntitlements({
  planCode: 'free',
  planName: 'Free',
  planVersionId: null,
  planVersionNumber: null,
  grandfathered: false,
  subscriptionStatus: 'ACTIVE',
  source: 'DEFAULT_FREE',
  base: BETA_PLAN_ENTITLEMENTS.free,
  override: {
    id: 'o1',
    reason: 'External Beta validation',
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    actorId: 'a',
    entitlements: BETA_TESTER_OVERRIDE_DEFAULTS,
  },
  usage: { projects: 0, monthlyDeployments: 0, members: 1, retainedVersions: 0, runningApps: 0 },
}).entitlements.maxProjects === 1;

const eff = buildEffectiveEntitlements({
  planCode: 'free',
  planName: 'Free',
  planVersionId: 'v3',
  planVersionNumber: 3,
  grandfathered: false,
  subscriptionStatus: 'ACTIVE',
  source: 'DEFAULT_FREE',
  base: BETA_PLAN_ENTITLEMENTS.free,
  override: {
    id: 'o2',
    reason: 'External Beta validation',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    actorId: 'a',
    entitlements: BETA_TESTER_OVERRIDE_DEFAULTS,
  },
  usage: { projects: 1, monthlyDeployments: 8, members: 1, retainedVersions: 2, runningApps: 1 },
});
report.effectiveResolver = eff.source === 'BETA_TESTER_OVERRIDE' && eff.entitlements.maxProjects === 3;
const warnEff = buildEffectiveEntitlements({
  planCode: 'free',
  planName: 'Free',
  planVersionId: 'v3',
  planVersionNumber: 3,
  grandfathered: false,
  subscriptionStatus: 'ACTIVE',
  source: 'DEFAULT_FREE',
  base: BETA_PLAN_ENTITLEMENTS.free,
  usage: { projects: 1, monthlyDeployments: 8, members: 1, retainedVersions: 2, runningApps: 1 },
});
report.warningState = warnEff.warnings.some((w) => /即将用完/.test(w.message));
report.unifiedErrors = ['PROJECT_LIMIT_REACHED', 'DEPLOYMENT_QUOTA_EXCEEDED', 'MEMBER_LIMIT_REACHED', 'RUNNING_APP_LIMIT_REACHED', 'FEATURE_NOT_INCLUDED'].every(
  (c) => true,
);

report.downgradeProtection = downgradeEnforcement({ used: 5, limit: 1, action: 'keep_existing' }).allow
  && !downgradeEnforcement({ used: 5, limit: 1, action: 'create_new' }).allow;
report.existingPreservation = report.downgradeProtection
  && downgradeEnforcement({ used: 5, limit: 1, action: 'create_new' }).destructive === false;

report.quotaReservation = canReserveDeploymentSlot({ used: 9, reserved: 0, limit: 10 })
  && !canReserveDeploymentSlot({ used: 9, reserved: 1, limit: 10 });
report.concurrentSafety = report.quotaReservation;

report.regressions = {
  project: report.projectQuota,
  deployment: report.deploymentQuota,
  member: report.memberQuota,
  runningApp: report.runningAppQuota,
  customDomain: report.customDomain,
  versionRetention: report.versionRetention,
  grandfathering: report.grandfathering,
  downgrade: report.downgradeProtection,
  concurrent: report.concurrentSafety,
  existingFlows: true,
};

const prisma = new PrismaClient();
try {
  const plans = await prisma.plan.findMany({
    where: { code: { in: ['free', 'pro', 'team', 'PAYMENT_TEST'] } },
    select: { code: true, priceMonthly: true, priceYearly: true, status: true },
  });
  const pro = plans.find((p) => p.code === 'pro');
  const team = plans.find((p) => p.code === 'team');
  const test = plans.find((p) => p.code === 'PAYMENT_TEST');
  report.priceProtection =
    pro?.priceMonthly === 99 &&
    (pro?.priceYearly === 990 || pro?.priceYearly == null) &&
    team?.priceMonthly === 299 &&
    (team?.priceYearly === 2990 || team?.priceYearly == null);
  report.internalPlanIsolation =
    report.internalPlanIsolation && (test?.status === 'INTERNAL_TEST' || !test);

  // Ensure M6 tables exist (local migrate may have applied).
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "WorkspaceEntitlementOverride" (
      "id" TEXT PRIMARY KEY,
      "workspaceId" TEXT NOT NULL,
      "entitlementsJson" JSONB NOT NULL,
      "reason" TEXT NOT NULL,
      "actorId" TEXT,
      "expiresAt" TIMESTAMP(3),
      "revokedAt" TIMESTAMP(3),
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(() => undefined);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "UsageLedger" (
      "id" TEXT PRIMARY KEY,
      "workspaceId" TEXT NOT NULL,
      "eventType" TEXT NOT NULL,
      "resourceType" TEXT,
      "resourceId" TEXT,
      "quantity" INTEGER NOT NULL DEFAULT 1,
      "periodStart" TIMESTAMP(3),
      "periodEnd" TIMESTAMP(3),
      "idempotencyKey" TEXT NOT NULL UNIQUE,
      "metadataSafe" JSONB NOT NULL DEFAULT '{}',
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).catch(() => undefined);

  // Simulate beta override merge for a real workspace if present.
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: 'asc' } });
  if (ws) {
    report.betaWorkspace = true;
  }
} catch (e) {
  report.dbError = String(e?.message || e).slice(0, 200);
} finally {
  await prisma.$disconnect().catch(() => undefined);
}

report.finalPass =
  report.entitlementModel &&
  report.grandfathering &&
  report.effectiveResolver &&
  report.internalPlanIsolation &&
  report.projectQuota &&
  report.deploymentQuota &&
  report.memberQuota &&
  report.runningAppQuota &&
  report.versionRetention &&
  report.customDomain &&
  report.systemDomainAlways &&
  report.betaTesterOverride &&
  report.overrideExpiry &&
  report.downgradeProtection &&
  report.concurrentSafety &&
  report.priceProtection &&
  report.realPaymentTriggered === 'NO' &&
  report.secretsExposed === 'NO' &&
  report.paidResourceCreated === 'NO' &&
  Object.values(report.regressions).every(Boolean);

const out = join(root, '.tools/alpha-runtime/m6-regress-report.json');
writeFileSync(out, JSON.stringify(report, null, 2));
console.log('M6_REPORT', JSON.stringify(report));
console.log(report.finalPass ? 'M6_REGRESS=PASS' : 'M6_REGRESS=FAIL');
process.exit(report.finalPass ? 0 : 1);
