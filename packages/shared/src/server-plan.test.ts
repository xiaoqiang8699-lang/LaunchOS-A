import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  analyzeServerRequirement,
  buildNetworkPlanDraft,
  estimateRuntimeMemoryNeedGb,
  evaluateExistingServer,
  pickRegionFromHints,
  recommendServerProfile,
  selectLowestMatchingSku,
  SERVER_RESOURCE_PROFILES,
} from './server-plan.js';

describe('ServerRequirementAnalyzer', () => {
  it('API Unit → needServer', () => {
    const r = analyzeServerRequirement({
      units: [{ type: 'API', name: 'api' }],
    });
    assert.equal(r.required, true);
    assert.ok(r.reasons.length > 0);
  });

  it('mobile-only → no server', () => {
    const r = analyzeServerRequirement({
      units: [
        { type: 'IOS', name: 'ios' },
        { type: 'ANDROID', name: 'android' },
      ],
    });
    assert.equal(r.required, false);
  });

  it('Web+API → shared server STANDARD', () => {
    const r = analyzeServerRequirement({
      units: [
        { type: 'WEB', name: 'web' },
        { type: 'API', name: 'api' },
      ],
      dependencyCount: 2,
    });
    assert.equal(r.required, true);
    assert.equal(r.sharedServer, true);
    assert.equal(r.recommendedProfile, 'STANDARD');
    assert.match(r.recommendationReason, /Web|API|2 核|4GB/);
  });
});

describe('profile recommendation', () => {
  it('single API test → DEV', () => {
    assert.equal(
      recommendServerProfile({
        runtimeUnitCount: 1,
        unitTypes: ['API'],
        environmentType: 'development',
      }),
      'DEV',
    );
  });

  it('production → at least STANDARD', () => {
    const p = recommendServerProfile({
      runtimeUnitCount: 1,
      unitTypes: ['API'],
      preferProduction: true,
    });
    assert.ok(p === 'STANDARD' || p === 'PRODUCTION');
  });
});

describe('region / dependency', () => {
  it('dependency region → same region', () => {
    const r = pickRegionFromHints({
      dependencyRegions: ['cn-hangzhou', 'cn-hangzhou'],
      defaultRegion: 'cn-shanghai',
    });
    assert.equal(r.regionId, 'cn-hangzhou');
  });
});

describe('existing server evaluation', () => {
  it('suitable', () => {
    const e = evaluateExistingServer({
      knownVcpu: 2,
      knownMemoryGb: 4,
      recommended: 'STANDARD',
    });
    assert.equal(e.fit, 'SUITABLE');
  });

  it('undersized', () => {
    const e = evaluateExistingServer({
      knownVcpu: 1,
      knownMemoryGb: 1,
      recommended: 'STANDARD',
    });
    assert.equal(e.fit, 'UNDERSIZED');
  });
});

describe('sku selection (no hardcoded permanent SKU)', () => {
  it('picks lowest matching among discovered', () => {
    const pick = selectLowestMatchingSku(
      [
        { instanceType: 'ecs.g6.xlarge', cpu: 4, memoryGb: 16 },
        { instanceType: 'ecs.e-c1m2.large', cpu: 2, memoryGb: 4 },
        { instanceType: 'ecs.t5.small', cpu: 1, memoryGb: 1 },
      ],
      'STANDARD',
    );
    assert.equal(pick?.instanceType, 'ecs.e-c1m2.large');
  });

  it('profiles are product tiers not instance types', () => {
    assert.equal(SERVER_RESOURCE_PROFILES.DEV.vcpu, 1);
    assert.equal(SERVER_RESOURCE_PROFILES.STANDARD.memoryGb, 4);
  });
});

describe('network plan', () => {
  it('no public dynamic ports', () => {
    const plan = buildNetworkPlanDraft({ regionId: 'cn-hangzhou', vpcId: 'vpc-x' });
    assert.deepEqual(plan.securityGroupPlan.allowTcp, [22, 80, 443]);
    assert.equal(plan.securityGroupPlan.denyPublicDynamicContainerPorts, true);
    assert.equal(plan.publicIpRequired, true);
  });
});

describe('capacity headroom', () => {
  it('adds reserve', () => {
    const need = estimateRuntimeMemoryNeedGb({ runtimeUnitCount: 2, dependencyCount: 2 });
    assert.ok(need >= 2);
  });
});
