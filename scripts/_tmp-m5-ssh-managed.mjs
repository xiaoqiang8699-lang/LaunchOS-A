import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
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

const prisma = new PrismaClient();
const rows = await prisma.serverInstance.findMany({ where: { host: '116.62.198.184' } });
console.log(
  rows.map((s) => ({
    id: s.id,
    name: s.name,
    scope: s.scope,
    username: s.username,
    passLen: decryptCredential(s.credentialEncrypted).length,
  })),
);

const managed = rows.find((s) => s.scope === 'PLATFORM_MANAGED') || rows.find((s) => s.id === 'cmuma9i480001rij49yv4yw2q');
if (!managed) throw new Error('managed missing');
const username = resolveServerSshUsername({
  serverUsername: managed.username,
  provider: managed.provider,
});
const password = decryptCredential(managed.credentialEncrypted);
const runner = new RemoteRunner();
await runner.connect({ host: managed.host, port: managed.port, username, password });
const r = await runner.execute(shellCommand('whoami; hostname; df -h / | tail -1'), { timeoutMs: 20000 });
console.log('OK', (r.stdout || '').trim(), 'exit', r.exitCode);
await runner.disconnect().catch(() => undefined);
await prisma.$disconnect();
