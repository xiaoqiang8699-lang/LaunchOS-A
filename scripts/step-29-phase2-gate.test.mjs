/**
 * Step 29 Phase 2 fixtures — gate unlock; real apply remains locked.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = readFileSync(
  resolve(root, 'scripts/step-29-public-entry-phase2-gate.mjs'),
  'utf8',
);

describe('step-29 phase2 public entry gate', () => {
  it('requires --gate-only with --confirm-public-entry', () => {
    assert.match(script, /--confirm-public-entry/);
    assert.match(script, /--gate-only/);
    assert.match(script, /Phase 2 refuses real --confirm-public-entry without --gate-only/);
  });

  it('keeps all write flags false on gate-only path', () => {
    assert.match(script, /DNS_WRITES_EXECUTED = false/);
    assert.match(script, /GATEWAY_WRITES_EXECUTED = false/);
    assert.match(script, /CERTIFICATE_WRITES_EXECUTED = false/);
    assert.match(script, /WRITE_COMMANDS_EXECUTED_THIS_RUN = false/);
    assert.match(script, /DEPLOYMENT_ENQUEUED = false/);
    assert.doesNotMatch(script, /apt-get install -y nginx/);
    assert.doesNotMatch(script, /createDomainRecord|updateDomainRecord|AddDomainRecord/);
  });

  it('uses NGINX provider, certificate material, DNS plan, and lock', () => {
    assert.match(script, /NginxGatewayProvider/);
    assert.match(script, /certificateMaterialAvailable/);
    assert.match(script, /planDnsARecord/);
    assert.match(script, /publicEntryLockKey/);
    assert.match(script, /classifyPublicEntryPortBlocker/);
    assert.match(script, /detectActualWebApiEnvUsage/);
  });
});
