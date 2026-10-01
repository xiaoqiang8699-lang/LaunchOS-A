/**
 * Step 29 Phase 1 fixtures — dry-run must stay read-only.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = readFileSync(
  resolve(root, 'scripts/step-29-gateway-phase1-dry-run.mjs'),
  'utf8',
);
const access = readFileSync(
  resolve(root, 'packages/domain/src/gateway-access.ts'),
  'utf8',
);

describe('step-29 phase1 dry-run readonly', () => {
  it('forbids mutate paths', () => {
    assert.match(script, /READ-ONLY/);
    assert.match(script, /WRITE_COMMANDS_EXECUTED_THIS_RUN = false/);
    assert.equal(/nginx -s reload/.test(script), false);
    assert.equal(/addDomainRecord|createTxtRecord|AddDomainRecord/.test(script), false);
    assert.equal(/podman (start|stop|rm)/.test(script), false);
    assert.match(script, /ACCESS_ENTRY_PENDING/);
    assert.match(access, /generateGatewayConfig/);
    assert.match(access, /GATEWAY_TARGET_HOST_FORBIDDEN/);
    assert.match(access, /STEP29_GATEWAY_WHITELIST/);
  });
});
