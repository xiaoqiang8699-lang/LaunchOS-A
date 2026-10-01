import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import {
  classifyConfigKey,
  parseEnvExampleContent,
  scanUnitRuntimeConfig,
  SECRET_ENV_ARTIFACT_EXCLUDES,
} from './runtime-config-scanner';

describe('parseEnvExampleContent', () => {
  it('parses keys and empty defaults as required candidates', () => {
    const parsed = parseEnvExampleContent(
      'DATABASE_URL=\nJWT_SECRET=\nPORT=3000\n# comment\nNEXT_PUBLIC_SITE_NAME=LaunchOS\n',
      '.env.example',
    );
    assert.equal(parsed.find((i) => i.key === 'DATABASE_URL')?.hasDefault, false);
    assert.equal(parsed.find((i) => i.key === 'PORT')?.hasDefault, true);
    assert.equal(parsed.find((i) => i.key === 'NEXT_PUBLIC_SITE_NAME')?.defaultValue, 'LaunchOS');
  });
});

describe('classifyConfigKey', () => {
  it('marks secrets and system keys', () => {
    assert.equal(classifyConfigKey('JWT_SECRET').sensitive, true);
    assert.equal(classifyConfigKey('DATABASE_URL').sensitive, true);
    assert.equal(classifyConfigKey('NEXT_PUBLIC_API_URL').publicSafe, true);
    assert.equal(classifyConfigKey('PORT').managedByLaunchOS, true);
    assert.equal(classifyConfigKey('NEXT_PUBLIC_API_URL').injectionPhase, 'BUILD');
    assert.equal(classifyConfigKey('JWT_SECRET').injectionPhase, 'RUNTIME');
    assert.equal(classifyConfigKey('PORT').injectionPhase, 'RUNTIME');
  });
});

describe('SECRET_ENV_ARTIFACT_EXCLUDES', () => {
  it('excludes real secret env files but not .env.example', () => {
    assert.ok(SECRET_ENV_ARTIFACT_EXCLUDES.includes('.env'));
    assert.ok(SECRET_ENV_ARTIFACT_EXCLUDES.includes('.env.local'));
    assert.ok(SECRET_ENV_ARTIFACT_EXCLUDES.includes('.env.production'));
    assert.ok(!SECRET_ENV_ARTIFACT_EXCLUDES.includes('.env.example'));
  });
});

describe('scanUnitRuntimeConfig fixture', () => {
  it('matches Step 24.1 web/api expectations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'launchos-config-'));
    try {
      const web = join(root, 'apps', 'web');
      const api = join(root, 'apps', 'api');
      mkdirSync(web, { recursive: true });
      mkdirSync(api, { recursive: true });
      writeFileSync(
        join(web, '.env.example'),
        'NEXT_PUBLIC_API_URL=\nNEXT_PUBLIC_SITE_NAME=LaunchOS\n',
      );
      writeFileSync(join(web, '.env'), 'NEXT_PUBLIC_API_URL=http://secret.local\n');
      writeFileSync(join(api, '.env.example'), 'DATABASE_URL=\nJWT_SECRET=\nPORT=3000\n');
      writeFileSync(
        join(api, 'server.js'),
        "const db=process.env.DATABASE_URL;\nconst jwt=process.env.JWT_SECRET;\nconst port=process.env.PORT || 3000;\n",
      );

      const webScan = await scanUnitRuntimeConfig(web);
      assert.ok(webScan.secretFilesDetected.includes('.env'));
      const webApi = webScan.requirements.find((r) => r.key === 'NEXT_PUBLIC_API_URL');
      const webName = webScan.requirements.find((r) => r.key === 'NEXT_PUBLIC_SITE_NAME');
      assert.equal(webApi?.required, true);
      assert.equal(webApi?.sensitive, false);
      assert.equal(webName?.required, false);

      const apiScan = await scanUnitRuntimeConfig(api);
      const db = apiScan.requirements.find((r) => r.key === 'DATABASE_URL');
      const jwt = apiScan.requirements.find((r) => r.key === 'JWT_SECRET');
      const port = apiScan.requirements.find((r) => r.key === 'PORT');
      assert.equal(db?.required, true);
      assert.equal(db?.sensitive, true);
      assert.equal(jwt?.required, true);
      assert.equal(jwt?.sensitive, true);
      assert.equal(port?.managedByLaunchOS, true);
      assert.equal(port?.required, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
