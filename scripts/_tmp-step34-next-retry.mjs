import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of [resolve(root, '.secrets/alpha-data-plane.env'), resolve(root, '.env')]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    // Prefer alpha-data-plane over local .env for DB/SSH secrets.
    if (file.includes('alpha-data-plane') || process.env[k] === undefined) process.env[k] = v;
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
  '/opt/launchos/tmp/step34-next-retry.sh',
  `#!/bin/sh
set +e
echo '=== mem/swap ==='
free -h
swapon --show
echo
echo '=== next build (10 min max) ==='
podman exec launchos-alpha-worker sh -c 'cd /tmp/launchos-repos/cmunsm2lk00ctrl01nnu1pwyd && NODE_OPTIONS=--max-old-space-size=1536 timeout 600 npm run build 2>&1 | tail -80; echo EXIT=$?'
echo
echo '=== .next exists? ==='
podman exec launchos-alpha-worker sh -c 'ls -la /tmp/launchos-repos/cmunsm2lk00ctrl01nnu1pwyd/.next 2>&1 | head -10'
`,
);
const r = await runner.execute(shellCommand('chmod 700 /opt/launchos/tmp/step34-next-retry.sh && /opt/launchos/tmp/step34-next-retry.sh'), {
  timeoutMs: 700000,
});
const out = String(r.stdout || '') + '\n' + String(r.stderr || '');
writeFileSync(join(ARTIFACT_DIR, 'step34-next-retry.txt'), out);
console.log(out.slice(0, 12000));
console.log('exit', r.exitCode);
await prisma.$disconnect();
await runner.disconnect().catch(() => undefined);
