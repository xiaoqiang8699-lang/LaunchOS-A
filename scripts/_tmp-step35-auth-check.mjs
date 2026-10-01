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
const server = await prisma.serverInstance.findFirst({ where: { host: '116.62.198.184' } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});
const r = await runner.execute(
  shellCommand(`podman exec launchos-cmuo3p33x0 sh -c 'if [ -n "\$AUTH_SECRET" ]; then echo AUTH_SECRET_present=true; else echo AUTH_SECRET_present=false; fi'; podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT tablename FROM pg_tables WHERE schemaname='"'"'public'"'"' AND tablename ILIKE '%onfig%' ORDER BY 1;" | head -40; curl -sS -k -o /dev/null -w 'recheck=%{http_code}\\n' --max-time 15 https://web-ceshi.zsaos.com/; podman inspect launchos-cmuo3p33x0 --format '{{.State.Status}}'`),
  { timeoutMs: 60000 },
);
console.log(r.stdout || r.stderr);
await runner.disconnect();
await prisma.$disconnect();
