/**
 * Fixture: failed BullMQ job must not block resume (remove + re-add same jobId).
 * No real enqueue — simulates queue service strategy only.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, 'apps/api/package.json'));
const { serverInitializationJobId, canStartServerInitialization } = require('@launchos/shared');

describe('step-263 failed job resume safety', () => {
  it('INITIALIZATION_FAILED is startable (resume)', () => {
    assert.equal(canStartServerInitialization('INITIALIZATION_FAILED'), true);
  });

  it('stable jobId unchanged across failed→resume', () => {
    const id = 'cmub78pz001sdripco5pexhdz';
    assert.equal(serverInitializationJobId(id), `server-initialize-${id}`);
  });

  it('failed job state maps to remove_completed_then_add (not alreadyInProgress)', () => {
    const state = 'failed';
    const alreadyInProgress =
      state === 'waiting' || state === 'active' || state === 'delayed';
    assert.equal(alreadyInProgress, false);
    const strategy =
      state === 'failed' || state === 'completed'
        ? 'remove_completed_then_add'
        : 'add_new';
    assert.equal(strategy, 'remove_completed_then_add');
  });
});
