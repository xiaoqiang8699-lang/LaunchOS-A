/**
 * Legacy Phase 1 fixture renamed — Phase 1 refuse is unlocked; keep targeting checks.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const e2e = readFileSync(
  resolve(root, 'scripts/step-28-multi-unit-managed-deployment-e2e.mjs'),
  'utf8',
);
const prepare = readFileSync(
  resolve(root, 'scripts/step-28-prepare-web-docker-image.mjs'),
  'utf8',
);
const engine = readFileSync(
  resolve(root, 'packages/deployment/src/engine/deployment-engine.service.ts'),
  'utf8',
);
const shared = readFileSync(
  resolve(root, 'packages/shared/src/managed-deployment.ts'),
  'utf8',
);

describe('step-28 multi-unit targeting', () => {
  it('no longer globally refuses --confirm-deploy (Phase 2 unlocked)', () => {
    assert.equal(e2e.includes('Phase 1 refuses --confirm-deploy'), false);
    assert.equal(e2e.includes('phase2ConfirmPathEnabled'), true);
  });

  it('targets Web unit and preserves API service instance', () => {
    assert.match(e2e, /cmu3j27340007ri7wcno1xrai/);
    assert.match(e2e, /cmuc66642002hritk6h3cbwhe/);
    assert.match(e2e, /apiPreserved/);
    assert.match(e2e, /webSecretIsolation/);
    assert.match(e2e, /ACCESS_ENTRY_PENDING/);
    assert.match(e2e, /NOT_REQUIRED/);
  });

  it('reuses managed deploy path helpers (no second deploy system)', () => {
    assert.match(e2e, /planNextRuntimePort/);
    assert.match(e2e, /summarizeManagedDeployGate/);
    assert.match(e2e, /resolveUnitHealthCheck/);
    assert.match(e2e, /filterRuntimeEnvForUnitType/);
    assert.match(prepare, /buildAndSaveImageArchive/);
    assert.match(prepare, /Does NOT SSH to managed ECS/);
  });

  it('engine applies health + secret isolation for WEB', () => {
    assert.match(engine, /resolveUnitHealthCheck/);
    assert.match(engine, /filterRuntimeEnvForUnitType/);
    assert.match(engine, /webSecretIsolation/);
    assert.match(shared, /STEP28_MULTI_UNIT_DEPLOY_WHITELIST/);
    assert.match(shared, /ROOT_FALLBACK/);
  });
});
