/**
 * Fixture: Step 26.3 Phase 2 gate unlock — Phase 1 refuse must be gone;
 * dry-run without --confirm-initialize must stay read-only.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = readFileSync(
  resolve(root, 'scripts/step-263-server-initialization-e2e.mjs'),
  'utf8',
);

describe('step-263 phase2 gate unlock', () => {
  it('removes Phase 1 global refuse of --confirm-initialize', () => {
    assert.equal(
      script.includes('Phase 1 forbids --confirm-initialize'),
      false,
    );
    assert.equal(
      script.includes('is not allowed in Phase 1 engineering+dry-run'),
      false,
    );
  });

  it('keeps confirm gate and whitelist', () => {
    assert.equal(script.includes('--confirm-initialize'), true);
    assert.equal(script.includes('cmub78pz001sdripco5pexhdz'), true);
    assert.equal(script.includes('i-bp18fpmcju7ntitybcm8'), true);
    assert.equal(script.includes('116.62.198.184'), true);
    assert.equal(script.includes('8.138.113.134'), true);
    assert.equal(script.includes('REAL_INITIALIZATION_GATE'), true);
    assert.equal(script.includes('WRITE_COMMANDS_EXECUTED'), true);
    assert.equal(script.includes('phase2ConfirmPathEnabled'), true);
  });

  it('dry-run path still returns before enqueue when CONFIRM is false', () => {
    assert.equal(script.includes('if (!CONFIRM)'), true);
    assert.equal(script.includes('DRY_RUN complete. WRITE_COMMANDS_EXECUTED=false'), true);
  });
});
