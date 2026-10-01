/**
 * Step 29 Phase 3A fixtures — confirm path + DNS write lock invariants.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDockerFiles } from '../packages/runtime/dist/dockerfile.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = readFileSync(
  resolve(root, 'scripts/step-29-public-entry-phase3a.mjs'),
  'utf8',
);

describe('step-29 phase3a public entry apply', () => {
  it('requires --confirm-public-entry --phase=3a', () => {
    assert.match(script, /--confirm-public-entry/);
    assert.match(script, /--phase=3a/);
    assert.match(script, /Phase 3A requires --confirm-public-entry --phase=3a/);
  });

  it('forbids DNS writes and Access Entry ACTIVE', () => {
    assert.match(script, /DNS_WRITES_EXECUTED = false/);
    assert.match(script, /READY_FOR_DNS/);
    assert.match(script, /accessEntryStatus !== 'ACTIVE'/);
    assert.doesNotMatch(script, /createDomainRecord|AddDomainRecord|updateDomainRecord/);
  });

  it('keeps old gateway host read-only and preserves API', () => {
    assert.match(script, /oldServerWrites = 0/);
    assert.match(script, /oldServerReadOnly = true/);
    assert.match(script, /apiPreserved/);
    assert.match(script, /PREVIOUS_HEALTHY_REVISION/);
  });

  it('Vite dockerfile injects public build args before npm run build', () => {
    const files = generateDockerFiles({
      framework: 'VITE',
      buildArgKeys: ['NEXT_PUBLIC_API_URL'],
      port: 80,
    });
    assert.match(files.dockerfile, /ARG NEXT_PUBLIC_API_URL/);
    assert.match(files.dockerfile, /ENV NEXT_PUBLIC_API_URL=\$NEXT_PUBLIC_API_URL/);
    const argIdx = files.dockerfile.indexOf('ARG NEXT_PUBLIC_API_URL');
    const buildIdx = files.dockerfile.indexOf('RUN npm run build');
    assert.ok(argIdx >= 0 && buildIdx > argIdx);
  });
});
