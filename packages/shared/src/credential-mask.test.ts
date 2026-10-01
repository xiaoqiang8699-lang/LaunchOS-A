import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { maskAccessKeyId } from './credential-mask';

describe('maskAccessKeyId', () => {
  it('masks middle of access key', () => {
    assert.equal(maskAccessKeyId('LTAI5tAbCdEfGhIj'), 'LTAI****GhIj');
  });

  it('handles short keys', () => {
    assert.equal(maskAccessKeyId('short'), '****');
  });
});
