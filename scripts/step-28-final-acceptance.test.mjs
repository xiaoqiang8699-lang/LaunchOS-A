/**
 * Fixture: Step 28 final acceptance must stay read-only.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = readFileSync(
  resolve(root, 'scripts/step-28-final-acceptance.mjs'),
  'utf8',
);

describe('step-28 final acceptance readonly', () => {
  it('forbids write paths and Step 29', () => {
    assert.match(script, /READ-ONLY/);
    assert.match(script, /WRITE_COMMANDS_EXECUTED_THIS_RUN = false/);
    assert.equal(script.includes('--confirm-deploy'), true); // mentioned as forbidden
    assert.match(script, /Forbidden: --confirm-deploy/);
    assert.equal(script.includes('podman start'), false);
    assert.equal(script.includes('podman stop'), false);
    assert.equal(script.includes('podman rm'), false);
    assert.equal(/queue\.(add|obliterate)/.test(script), false);
    assert.match(script, /cmuc8ripi0015riagoflj5vdi/);
    assert.match(script, /cmuc66642002hritk6h3cbwhe/);
    assert.match(script, /ACCESS_ENTRY_PENDING/);
    assert.match(script, /webSecretIsolation/);
  });
});
