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
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const { resolveHostnameIpv4, verifyHostnamePointsToIp } = requireDomain('@launchos/domain');

const HOST = 'web-ceshi.zsaos.com';
const IP = '116.62.198.184';

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: IP } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});

const dig = await runner.execute(
  shellCommand(`dig +short ${HOST} A; dig @dns3.hichina.com +short ${HOST} A; dig @8.8.8.8 +short ${HOST} A; dig @1.1.1.1 +short ${HOST} A`),
  { timeoutMs: 60000 },
);
console.log('REMOTE_DIG\n', dig.stdout);
const doh = await resolveHostnameIpv4(HOST);
const match = await verifyHostnamePointsToIp(HOST, IP);
console.log('DOH', JSON.stringify(doh, null, 2));
console.log('MATCH', JSON.stringify(match, null, 2));
const ns = spawnSync('nslookup', [HOST], { encoding: 'utf8' });
console.log('NSLOOKUP', ns.stdout, ns.stderr);

const curl = spawnSync(
  'curl.exe',
  ['-k', '-sS', '-L', '--max-time', '20', '-w', '\nCODE:%{http_code} IP:%{remote_ip}\n', `https://${HOST}/`],
  { encoding: 'utf8', maxBuffer: 2_000_000 },
);
console.log('CURL', curl.stdout?.slice(0, 300), curl.stderr?.slice(0, 200));

await runner.disconnect();
await prisma.$disconnect();
