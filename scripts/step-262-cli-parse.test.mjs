/**
 * Unit tests for Step 26.2 CLI argv parsing (no network / no billing).
 */
import assert from 'node:assert/strict';
import { parseStep262Argv } from './lib/step-262-cli.mjs';

{
  const r = parseStep262Argv(['node', 'script.mjs', '--cloud-resource-id=abc123']);
  assert.equal(r.cloudResourceId, 'abc123');
  assert.equal(r.confirmBilling, false);
}

{
  const r = parseStep262Argv(['node', 'script.mjs', '--cloud-resource-id', 'abc123']);
  assert.equal(r.cloudResourceId, 'abc123');
  assert.equal(r.confirmBilling, false);
}

{
  const r = parseStep262Argv(['node', 'script.mjs']);
  assert.equal(r.cloudResourceId, null);
  assert.equal(r.confirmBilling, false);
}

{
  const r = parseStep262Argv([
    'node',
    'script.mjs',
    '--cloud-resource-id=cmuas8iiz0001riown1l1a0o3',
    '--confirm-billing',
  ]);
  assert.equal(r.cloudResourceId, 'cmuas8iiz0001riown1l1a0o3');
  assert.equal(r.confirmBilling, true);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      cases: [
        { argv: '--cloud-resource-id=abc123', cloudResourceId: 'abc123' },
        { argv: '--cloud-resource-id abc123', cloudResourceId: 'abc123' },
        { argv: '(none)', cloudResourceId: null },
      ],
    },
    null,
    2,
  ),
);
