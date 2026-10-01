import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertExtractBudget,
  assertZipSizeWithinLimit,
  deriveAppNameFromZip,
  githubConnectErrorUrl,
  githubConnectSuccessUrl,
  isBlockedZipEntry,
  sanitizeInternalReturnTo,
  sanitizeZipEntryPath,
  ZIP_INTAKE_LIMITS,
} from './zip-intake.js';

describe('zip intake + returnTo', () => {
  it('blocks zip slip and ignored directories', () => {
    assert.equal(sanitizeZipEntryPath('../etc/passwd'), null);
    assert.equal(sanitizeZipEntryPath('/abs/path'), null);
    assert.equal(sanitizeZipEntryPath('node_modules/left-pad/index.js'), null);
    assert.equal(sanitizeZipEntryPath('.git/config'), null);
    assert.equal(sanitizeZipEntryPath('src/app.ts'), 'src/app.ts');
    assert.equal(sanitizeZipEntryPath('pkg\\src\\main.ts'), 'pkg/src/main.ts');
  });

  it('blocks dangerous extensions and enforces size limits', () => {
    assert.equal(isBlockedZipEntry('tools/setup.exe'), true);
    assert.equal(isBlockedZipEntry('readme.md'), false);
    assert.throws(() => assertZipSizeWithinLimit(0), /ZIP_EMPTY/);
    assert.throws(
      () => assertZipSizeWithinLimit(ZIP_INTAKE_LIMITS.maxZipBytes + 1),
      /ZIP_TOO_LARGE/,
    );
    assert.throws(
      () => assertExtractBudget({ fileCount: ZIP_INTAKE_LIMITS.maxFileCount + 1, extractedBytes: 1 }),
      /ZIP_TOO_MANY_FILES/,
    );
  });

  it('derives app names and sanitizes returnTo', () => {
    assert.equal(deriveAppNameFromZip({ packageName: 'hello-world' }), 'hello-world');
    assert.equal(deriveAppNameFromZip({ fileName: 'My App.zip' }), 'My-App');
    assert.equal(sanitizeInternalReturnTo('https://evil.com'), '/onboarding/source');
    assert.equal(sanitizeInternalReturnTo('//evil'), '/onboarding/source');
    assert.equal(sanitizeInternalReturnTo('/onboarding/source'), '/onboarding/source');
    assert.match(
      githubConnectSuccessUrl('http://localhost:3000', '/onboarding/source'),
      /github=connected$/,
    );
    assert.match(
      githubConnectErrorUrl('http://localhost:3000', '/onboarding/source', 'invalid'),
      /github=error/,
    );
  });
});
