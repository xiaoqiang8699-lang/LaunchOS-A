/**
 * Fixture: Step 27 Phase 2 gate unlock — Phase 1 refuse must be gone;
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
  resolve(root, 'scripts/step-27-managed-deployment-e2e.mjs'),
  'utf8',
);

describe('step-27 phase2 gate unlock', () => {
  it('removes Phase 1 global refuse of --confirm-deploy', () => {
    assert.equal(script.includes('Phase 1 refuses --confirm-deploy'), false);
    assert.equal(script.includes('Engineering + dry-run only'), false);
    assert.equal(script.includes('Engineering phase forbids'), false);
  });

  it('keeps confirm gate, whitelist, and write semantics', () => {
    assert.equal(script.includes('--confirm-deploy'), true);
    assert.equal(script.includes('phase2ConfirmPathEnabled'), true);
    assert.equal(script.includes('REAL_MANAGED_DEPLOYMENT_GATE'), true);
    assert.equal(script.includes('cmub78pz001sdripco5pexhdz'), true);
    assert.equal(script.includes('cmu3j272x0005ri7wlxlbajeu'), true);
    assert.equal(script.includes('cmu56y2zy002briz0u5ttr229'), true);
    assert.equal(script.includes('116.62.198.184'), true);
    assert.equal(script.includes('8.138.113.134'), true);
    assert.equal(script.includes('WRITE_COMMANDS_EXECUTED_THIS_RUN'), true);
    assert.equal(script.includes('DEPLOYMENT_ENQUEUED'), true);
    assert.equal(script.includes('GATE_ONLY'), true);
  });

  it('dry-run path still returns before enqueue when CONFIRM is false', () => {
    assert.equal(script.includes('if (!CONFIRM)'), true);
    assert.equal(script.includes('DRY_RUN complete. WRITE_COMMANDS_EXECUTED_THIS_RUN=false'), true);
  });

  it('confirm path can stop at gate-only without enqueue', () => {
    assert.equal(script.includes('CONFIRM_PATH_FIXTURE complete (gate-only)'), true);
    assert.equal(script.includes('wouldEnqueue=true'), true);
  });
});
