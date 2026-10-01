/**
 * Step 29 Phase 3B fixtures — DNS activation gate unlock; real DNS remain locked.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = readFileSync(
  resolve(root, 'scripts/step-29-dns-activation-phase3b-gate.mjs'),
  'utf8',
);

describe('step-29 phase3b dns activation gate', () => {
  it('requires --gate-only with --confirm-dns-activation', () => {
    assert.match(script, /--confirm-dns-activation/);
    assert.match(script, /--gate-only/);
    assert.match(script, /Phase 3B refuses real --confirm-dns-activation without --gate-only/);
  });

  it('keeps all write flags false', () => {
    assert.match(script, /DNS_WRITES_EXECUTED = false/);
    assert.match(script, /GATEWAY_WRITES_EXECUTED = false/);
    assert.match(script, /CERTIFICATE_WRITES_EXECUTED = false/);
    assert.match(script, /DEPLOYMENT_ENQUEUED = false/);
    assert.match(script, /WRITE_COMMANDS_EXECUTED_THIS_RUN = false/);
    assert.doesNotMatch(script, /AddDomainRecord|UpdateDomainRecord|createDomainRecord/);
  });

  it('uses fresh DNS read + ownership + propagation + lock', () => {
    assert.match(script, /findARecordsReadOnly/);
    assert.match(script, /planDnsARecord/);
    assert.match(script, /buildDnsOwnershipFromPlan/);
    assert.match(script, /dnsPropagationStrategy/);
    assert.match(script, /evaluateDnsActivationGate/);
    assert.match(script, /publicEntryLockKey/);
    assert.match(script, /STEP29_PHASE3B_BASELINE/);
  });
});
