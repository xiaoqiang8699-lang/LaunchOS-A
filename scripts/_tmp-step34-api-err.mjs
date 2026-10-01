import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of [resolve(root, '.env'), resolve(root, '.secrets/alpha-data-plane.env')]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: '116.62.198.184' } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});

await runner.writeTextFile(
  '/opt/launchos/tmp/step34-api-err.sh',
  `#!/bin/sh
set +e
echo '=== full api logs around launch ==='
podman logs --since 15m launchos-alpha-api 2>&1 | sed -n '/cmunxrbyc000vrl0170al164h/,+40p' | head -120
echo
echo '=== api errors ==='
podman logs --since 15m launchos-alpha-api 2>&1 | grep -iE 'ERROR|Exception|failed|GitHub App|尚未配置|ServiceUnavailable|ECONN|stack' | sed -E 's/gh[pousr]_[A-Za-z0-9_]{20,}/***/g' | tail -60
echo
echo '=== git connection for project ==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "
SELECT sr.id, sr.\\"fullName\\", sr.\\"authStatus\\", sr.\\"connectionId\\",
  gpc.status as conn_status, gpc.\\"installationId\\"
FROM \\"SourceRepository\\" sr
LEFT JOIN \\"GitProviderConnection\\" gpc ON gpc.id = sr.\\"connectionId\\"
WHERE sr.\\"projectId\\"='cmunsm2lk00ctrl01nnu1pwyd';
"
echo
echo '=== try github token from worker node process ==='
podman exec launchos-alpha-worker node -e "
const { createInstallationAccessToken, readGitHubAppCredentials, readGitHubAppConfig, isGitHubAppConfigured } = require('@launchos/github');
console.log('configured', isGitHubAppConfigured());
console.log('creds', !!readGitHubAppCredentials());
console.log('config', !!readGitHubAppConfig());
" 2>&1 | head -40
`,
);
const r = await runner.execute(shellCommand('chmod 700 /opt/launchos/tmp/step34-api-err.sh && /opt/launchos/tmp/step34-api-err.sh'), {
  timeoutMs: 120000,
});
const out = String(r.stdout || '') + '\n' + String(r.stderr || '');
writeFileSync(join(ARTIFACT_DIR, 'step34-api-err.txt'), out);
console.log(out.slice(0, 14000));
await prisma.$disconnect();
await runner.disconnect().catch(() => undefined);
