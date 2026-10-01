import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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
const server = await prisma.serverInstance.findFirst({ where: { host: '116.62.198.184' } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});

const r = await runner.execute(
  shellCommand(`echo '===CONTAINERS==='; podman ps --filter name=launchos-alpha --format '{{.Names}} {{.Status}} {{.Ports}}'; echo '===LOCAL_HEALTH==='; curl -sS -m 8 http://127.0.0.1:39110/api/v1/health || echo LOCAL_FAIL; echo; echo '===PUBLIC_HEALTH==='; curl -sS -k -m 8 https://api-alpha.zsaos.com/api/v1/health || echo PUBLIC_FAIL; echo`),
  { timeoutMs: 60000 },
);
console.log(r.stdout || r.stderr);

const ext = spawnSync(
  'curl.exe',
  ['-k', '-sS', '-m', '15', '-w', '\nHTTP:%{http_code}\n', 'https://api-alpha.zsaos.com/api/v1/health'],
  { encoding: 'utf8' },
);
console.log('===FROM_PC===\n', ext.stdout, ext.stderr);

await runner.disconnect();
await prisma.$disconnect();
