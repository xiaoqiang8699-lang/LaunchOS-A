/**
 * Fixture: Step 28 Phase 2 gate unlock — Phase 1 refuse must be gone;
 * dry-run without --confirm-deploy must stay read-only;
 * --confirm-deploy --gate-only enters real gate without enqueue.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = readFileSync(
  resolve(root, 'scripts/step-28-multi-unit-managed-deployment-e2e.mjs'),
  'utf8',
);
const engine = readFileSync(
  resolve(root, 'packages/deployment/src/engine/deployment-engine.service.ts'),
  'utf8',
);

describe('step-28 phase2 gate unlock', () => {
  it('removes Phase 1 global refuse of --confirm-deploy', () => {
    assert.equal(script.includes('Phase 1 refuses --confirm-deploy'), false);
    assert.equal(script.includes('confirmDeployRefused: true'), false);
  });

  it('keeps confirm gate, whitelist, and write semantics', () => {
    assert.equal(script.includes('--confirm-deploy'), true);
    assert.equal(script.includes('phase2ConfirmPathEnabled'), true);
    assert.equal(script.includes('REAL_MANAGED_DEPLOYMENT_GATE'), true);
    assert.equal(script.includes('GATE_ONLY'), true);
    assert.equal(script.includes('cmub78pz001sdripco5pexhdz'), true);
    assert.equal(script.includes('cmu3j27340007ri7wcno1xrai'), true);
    assert.equal(script.includes('cmuc6x7hd0001ri10yvj0rr6o'), true);
    assert.equal(script.includes('cmu3scwr3016fri3c35ryb3y2'), true);
    assert.equal(script.includes('116.62.198.184'), true);
    assert.equal(script.includes('8.138.113.134'), true);
    assert.equal(script.includes('API_BASELINE_NOT_HEALTHY'), true);
    assert.equal(script.includes('webSecretIsolation'), true);
    assert.equal(script.includes('allowedRuntimeKeys'), true);
    assert.equal(script.includes('blockedBackendSecretKeys'), true);
    assert.equal(script.includes('ACCESS_ENTRY_PENDING'), true);
    assert.equal(script.includes('WRITE_COMMANDS_EXECUTED_THIS_RUN'), true);
    assert.equal(script.includes('DEPLOYMENT_ENQUEUED'), true);
  });

  it('dry-run path still returns before enqueue when CONFIRM is false', () => {
    assert.equal(script.includes('if (!CONFIRM)'), true);
    assert.equal(script.includes('DRY_RUN complete. WRITE_COMMANDS_EXECUTED_THIS_RUN=false'), true);
  });

  it('confirm path can stop at gate-only without enqueue', () => {
    assert.equal(script.includes('CONFIRM_PATH_FIXTURE complete (gate-only)'), true);
    assert.equal(script.includes('wouldEnqueue=true'), true);
  });

  it('must not modify API unit on confirm path', () => {
    assert.equal(script.includes('cmu3j272x0005ri7wlxlbajeu'), true);
    assert.equal(script.includes('cmuc66642002hritk6h3cbwhe'), true);
    assert.equal(script.includes('apiUnitUntouched'), true);
    assert.match(engine, /webSecretIsolation=true allowedRuntimeKeys=/);
    assert.match(engine, /WEB_FORBIDDEN_RUNTIME_SECRET_KEYS/);
  });
});
