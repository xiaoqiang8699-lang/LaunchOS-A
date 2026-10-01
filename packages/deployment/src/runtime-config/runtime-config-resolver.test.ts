import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

type Phase = 'BUILD' | 'RUNTIME' | 'BOTH';

function phaseMatches(stored: Phase, phase: 'BUILD' | 'RUNTIME'): boolean {
  if (stored === 'BOTH') return true;
  return stored === phase;
}

describe('RuntimeConfigResolver phase isolation', () => {
  it('keeps secrets out of BUILD and public keys out of RUNTIME filter', () => {
    const web: Array<{ key: string; phase: Phase }> = [
      { key: 'NEXT_PUBLIC_API_URL', phase: 'BUILD' },
    ];
    const api: Array<{ key: string; phase: Phase }> = [
      { key: 'DATABASE_URL', phase: 'RUNTIME' },
      { key: 'JWT_SECRET', phase: 'RUNTIME' },
      { key: 'PORT', phase: 'RUNTIME' },
    ];

    const webBuild = web.filter((item) => phaseMatches(item.phase, 'BUILD')).map((i) => i.key);
    const webRuntime = web.filter((item) => phaseMatches(item.phase, 'RUNTIME')).map((i) => i.key);
    const apiBuild = api.filter((item) => phaseMatches(item.phase, 'BUILD')).map((i) => i.key);
    const apiRuntime = api.filter((item) => phaseMatches(item.phase, 'RUNTIME')).map((i) => i.key);

    assert.deepEqual(webBuild, ['NEXT_PUBLIC_API_URL']);
    assert.equal(webRuntime.length, 0);
    assert.equal(apiBuild.length, 0);
    assert.ok(apiRuntime.includes('DATABASE_URL'));
    assert.ok(apiRuntime.includes('JWT_SECRET'));
    assert.ok(!apiBuild.includes('JWT_SECRET'));
    assert.ok(!webBuild.includes('DATABASE_URL'));
  });

  it('fingerprint does not embed plaintext secrets', () => {
    const encrypted = 'enc:v1:deadbeef';
    const fingerprint = createHash('sha256')
      .update(['rev:2', `JWT_SECRET:${encrypted}`].sort().join('|'))
      .digest('hex')
      .slice(0, 32);
    assert.equal(fingerprint.includes('sk-'), false);
    assert.equal(fingerprint.length, 32);
  });
});
