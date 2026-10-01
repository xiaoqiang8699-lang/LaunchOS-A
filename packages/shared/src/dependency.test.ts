import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  aggregateProjectDependencyStatus,
  detectDependenciesFromRequirementKeys,
  mapProvisionPhaseToProductPhase,
  mapRequirementKeyToDependencyType,
  resolveDependencyStatus,
} from './dependency.js';

describe('dependency mapping', () => {
  it('DATABASE_URL → POSTGRESQL', () => {
    assert.equal(mapRequirementKeyToDependencyType('DATABASE_URL'), 'POSTGRESQL');
  });

  it('REDIS_URL → REDIS', () => {
    assert.equal(mapRequirementKeyToDependencyType('REDIS_URL'), 'REDIS');
  });

  it('detects both from requirement keys', () => {
    const deps = detectDependenciesFromRequirementKeys(['DATABASE_URL', 'REDIS_URL', 'PORT']);
    assert.equal(deps.length, 2);
    assert.ok(deps.some((d) => d.type === 'POSTGRESQL'));
    assert.ok(deps.some((d) => d.type === 'REDIS'));
  });

  it('Web with no db/redis keys → empty required list', () => {
    const deps = detectDependenciesFromRequirementKeys(['PORT', 'NEXT_PUBLIC_SITE_NAME']);
    assert.equal(deps.length, 0);
  });
});

describe('dependency status machine', () => {
  it('binding exists → CONNECTED', () => {
    assert.equal(
      resolveDependencyStatus({
        required: true,
        hasBinding: true,
        connectionStatus: 'CONNECTED',
      }),
      'CONNECTED',
    );
  });

  it('binding missing → MISSING', () => {
    assert.equal(
      resolveDependencyStatus({ required: true, hasBinding: false }),
      'MISSING',
    );
  });

  it('dirty config → NEEDS_REDEPLOY', () => {
    assert.equal(
      resolveDependencyStatus({
        required: true,
        hasBinding: true,
        connectionStatus: 'CONNECTED',
        needsRedeploy: true,
      }),
      'NEEDS_REDEPLOY',
    );
  });

  it('provisioning → CONFIGURING', () => {
    assert.equal(
      resolveDependencyStatus({
        required: true,
        hasBinding: false,
        cloudResourceStatus: 'CREATING',
        cloudResourcePhase: 'PREPARING_NETWORK',
      }),
      'CONFIGURING',
    );
  });

  it('provider locked / unavailable → UNAVAILABLE', () => {
    assert.equal(
      resolveDependencyStatus({
        required: true,
        hasBinding: true,
        connectionStatus: 'UNAVAILABLE',
      }),
      'UNAVAILABLE',
    );
  });

  it('health fail → DEGRADED', () => {
    assert.equal(
      resolveDependencyStatus({
        required: true,
        hasBinding: true,
        connectionStatus: 'CONNECTED',
        healthStatus: 'UNHEALTHY',
      }),
      'DEGRADED',
    );
  });

  it('not required → NOT_REQUIRED', () => {
    assert.equal(
      resolveDependencyStatus({ required: false, hasBinding: false }),
      'NOT_REQUIRED',
    );
  });
});

describe('project aggregate', () => {
  it('all connected → READY', () => {
    const agg = aggregateProjectDependencyStatus([
      { required: true, status: 'CONNECTED' },
      { required: true, status: 'CONNECTED' },
      { required: false, status: 'NOT_REQUIRED' },
    ]);
    assert.equal(agg.status, 'READY');
    assert.equal(agg.required, 2);
    assert.equal(agg.connected, 2);
    assert.equal(agg.missing, 0);
  });

  it('one missing → ACTION_REQUIRED', () => {
    const agg = aggregateProjectDependencyStatus([
      { required: true, status: 'CONNECTED' },
      { required: true, status: 'MISSING' },
    ]);
    assert.equal(agg.status, 'ACTION_REQUIRED');
    assert.equal(agg.missing, 1);
  });
});

describe('product phase mapping', () => {
  it('maps redis/db phases', () => {
    assert.equal(mapProvisionPhaseToProductPhase('PREPARING_NETWORK'), 'PREPARING_NETWORK');
    assert.equal(mapProvisionPhaseToProductPhase('TESTING_CONNECTION'), 'TESTING');
    assert.equal(mapProvisionPhaseToProductPhase('BINDING'), 'BINDING');
    assert.equal(mapProvisionPhaseToProductPhase('DONE'), 'DONE');
  });
});
