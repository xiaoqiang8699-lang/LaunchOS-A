import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redactSecrets } from './secret-redaction';

describe('redactSecrets', () => {
  it('redacts known secrets and KEY=value forms', () => {
    const out = redactSecrets('OPENAI_API_KEY=sk-abc1234567890 hello sk-abc1234567890', [
      'sk-abc1234567890',
    ]);
    assert.equal(out.includes('sk-abc1234567890'), false);
    assert.ok(out.includes('[REDACTED]'));
  });
});
