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

const script = `#!/bin/bash
set +e
echo ===DNS===
getent hosts api-launchos-multi-demo-5.launchos.app || true
getent hosts web-launchos-multi-demo-5.launchos.app || true
getent hosts launchos-multi-demo-5.launchos.app || true
getent hosts alpha.zsaos.com || true
dig +short api-launchos-multi-demo-5.launchos.app A || true
dig +short web-launchos-multi-demo-5.launchos.app A || true
echo ===ZONE_ENV===
grep -E 'SYSTEM_DOMAIN|DOMAIN_ZONE|LAUNCHOS_.*DOMAIN' /opt/launchos/config/alpha-api.env | sed -E 's/(SECRET|TOKEN|PASSWORD|KEY)=.*/\\1=***/'
echo ===ROUTES_CONF===
grep -n 'multi-demo-5' /opt/launchos/gateway/active/launchos-routes.conf | head -50
echo ===SYNC_TEST===
# show whether DomainManager sync wiped routes
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT count(*) FROM \\"ApplicationDomain\\";"
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT count(*) FROM \\"GatewayRoute\\";"
`;
await runner.writeTextFile('/opt/launchos/bin/step317-dns-zone.sh', script);
const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/bin/step317-dns-zone.sh && /opt/launchos/bin/step317-dns-zone.sh'),
  { timeoutMs: 60000 },
);
console.log(r.stdout || r.stderr);
await runner.disconnect();
await prisma.$disconnect();
