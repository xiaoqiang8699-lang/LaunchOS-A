import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BETA_PLAN_ENTITLEMENTS,
  BETA_TESTER_OVERRIDE_DEFAULTS,
  buildEffectiveEntitlements,
  canReserveDeploymentSlot,
  customDomainDecision,
  deploymentConsumesQuota,
  deploymentQuotaDecision,
  downgradeEnforcement,
  entitlementsFromPlanVersion,
  isInternalTestPlan,
  isOverrideActive,
  memberQuotaDecision,
  mergeEntitlementOverride,
  projectQuotaDecision,
  runningAppQuotaDecision,
  selectVersionsForRetention,
  subscriptionEntitlementBehavior,
  toPlanVersionJson,
} from './plan-entitlements.js';

describe('plan entitlements M6', () => {
  it('exposes Beta Free/Pro/Team defaults', () => {
    assert.equal(BETA_PLAN_ENTITLEMENTS.free.maxProjects, 1);
    assert.equal(BETA_PLAN_ENTITLEMENTS.free.maxMonthlyDeployments, 10);
    assert.equal(BETA_PLAN_ENTITLEMENTS.pro.maxProjects, 10);
    assert.equal(BETA_PLAN_ENTITLEMENTS.pro.maxWorkspaceMembers, 2);
    assert.equal(BETA_PLAN_ENTITLEMENTS.team.maxWorkspaceMembers, 5);
    assert.equal(BETA_PLAN_ENTITLEMENTS.free.customDomainEnabled, false);
    assert.equal(BETA_PLAN_ENTITLEMENTS.free.rollbackEnabled, true);
  });

  it('hides PAYMENT_TEST as internal', () => {
    assert.equal(isInternalTestPlan('PAYMENT_TEST'), true);
    assert.equal(isInternalTestPlan('pro'), false);
  });

  it('merges beta tester override on Free base', () => {
    const merged = mergeEntitlementOverride(
      BETA_PLAN_ENTITLEMENTS.free,
      BETA_TESTER_OVERRIDE_DEFAULTS,
    );
    assert.equal(merged.maxProjects, 3);
    assert.equal(merged.maxMonthlyDeployments, 50);
    assert.equal(merged.maxRunningApps, 3);
    assert.equal(merged.customDomainEnabled, false);
    assert.equal(merged.rollbackEnabled, true);
  });

  it('parses PlanVersion json with legacy aliases', () => {
    const ent = entitlementsFromPlanVersion({
      planCode: 'pro',
      limitsJson: { maxProjects: 10, maxDeploymentsPerMonth: 100, maxMembers: 1 },
      featuresJson: { customDomain: true },
    });
    assert.equal(ent.maxMonthlyDeployments, 100);
    assert.equal(ent.maxWorkspaceMembers, 1);
    assert.equal(ent.customDomainEnabled, true);
  });

  it('blocks project/member/deployment/running quotas with upgrade codes', () => {
    assert.equal(projectQuotaDecision({ used: 1, limit: 1, planCode: 'free' }).ok, false);
    assert.equal(
      (projectQuotaDecision({ used: 1, limit: 1, planCode: 'free' }) as { code: string }).code,
      'PROJECT_LIMIT_REACHED',
    );
    assert.equal(memberQuotaDecision({ used: 1, limit: 1, planCode: 'free' }).ok, false);
    assert.equal(deploymentQuotaDecision({ used: 10, limit: 10, planCode: 'free' }).ok, false);
    assert.equal(
      runningAppQuotaDecision({ used: 1, limit: 1, planCode: 'free' }).ok,
      false,
    );
    assert.equal(
      runningAppQuotaDecision({ used: 1, limit: 1, planCode: 'free', isExistingRunningApp: true }).ok,
      true,
    );
  });

  it('gates custom domain on Free', () => {
    const d = customDomainDecision({ enabled: false, planCode: 'free' });
    assert.equal(d.ok, false);
    if (!d.ok) assert.match(d.message, /Pro/);
  });

  it('counts real deploy/redeploy/rollback only', () => {
    assert.equal(deploymentConsumesQuota({ kind: 'deploy' }), true);
    assert.equal(deploymentConsumesQuota({ kind: 'rollback' }), true);
    assert.equal(deploymentConsumesQuota({ kind: 'analyze' }), false);
    assert.equal(deploymentConsumesQuota({ usageClass: 'GATE_ONLY' }), false);
  });

  it('keeps current version when selecting retention', () => {
    const now = Date.now();
    const { keep, expire } = selectVersionsForRetention({
      maxRetained: 3,
      versions: [
        { id: 'cur', createdAt: new Date(now), isCurrent: true },
        { id: 'a', createdAt: new Date(now - 1) },
        { id: 'b', createdAt: new Date(now - 2) },
        { id: 'c', createdAt: new Date(now - 3) },
        { id: 'd', createdAt: new Date(now - 4) },
      ],
    });
    assert.ok(keep.includes('cur'));
    assert.equal(keep.length, 3);
    assert.ok(expire.includes('d'));
  });

  it('grandfathering: override expiry falls back', () => {
    assert.equal(isOverrideActive({ expiresAt: new Date(Date.now() + 60_000).toISOString() }), true);
    assert.equal(isOverrideActive({ expiresAt: new Date(Date.now() - 1000).toISOString() }), false);
  });

  it('effective entitlements show remaining and 80% warning', () => {
    const eff = buildEffectiveEntitlements({
      planCode: 'free',
      planName: 'Free',
      planVersionId: 'v',
      planVersionNumber: 3,
      grandfathered: false,
      subscriptionStatus: 'ACTIVE',
      source: 'DEFAULT_FREE',
      base: BETA_PLAN_ENTITLEMENTS.free,
      usage: {
        projects: 1,
        monthlyDeployments: 8,
        members: 1,
        retainedVersions: 2,
        runningApps: 1,
      },
    });
    assert.equal(eff.remaining.monthlyDeployments, 2);
    assert.ok(eff.warnings.some((w) => w.metric === 'monthlyDeployments'));
  });

  it('downgrade is non-destructive', () => {
    assert.equal(
      downgradeEnforcement({ used: 5, limit: 1, action: 'keep_existing' }).allow,
      true,
    );
    assert.equal(downgradeEnforcement({ used: 5, limit: 1, action: 'create_new' }).allow, false);
    assert.equal(
      downgradeEnforcement({ used: 5, limit: 1, action: 'create_new' }).destructive,
      false,
    );
  });

  it('concurrent reservation only allows one last slot', () => {
    assert.equal(canReserveDeploymentSlot({ used: 9, reserved: 0, limit: 10 }), true);
    assert.equal(canReserveDeploymentSlot({ used: 9, reserved: 1, limit: 10 }), false);
  });

  it('PAST_DUE blocks new consuming without stopping apps', () => {
    const b = subscriptionEntitlementBehavior('PAST_DUE');
    assert.equal(b.blockNewConsumingActions, true);
    assert.equal(b.stopRunningApps, false);
  });

  it('toPlanVersionJson does not include prices', () => {
    const json = toPlanVersionJson(BETA_PLAN_ENTITLEMENTS.pro, 'pro');
    assert.equal('priceMonthly' in json.limitsJson, false);
    assert.equal(json.limitsJson.maxProjects, 10);
  });
});
