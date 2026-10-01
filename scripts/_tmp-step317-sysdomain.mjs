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
echo ===SYS_DOMAIN_CFG===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, coalesce(\\"rootDomain\\",''), coalesce(\\"dnsStatus\\"::text,''), coalesce(\\"gatewayPublicIp\\",''), coalesce(\\"gatewayServerId\\",'') FROM \\"SystemDomainConfig\\" ORDER BY \\"createdAt\\" ASC;"
echo ===ALL_AD===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT domain, status, \\"projectId\\", coalesce(\\"deployableUnitId\\",''), coalesce(\\"runtimePort\\"::text,''), coalesce(\\"dnsStatus\\"::text,'') FROM \\"ApplicationDomain\\" ORDER BY \\"updatedAt\\" DESC LIMIT 30;"
echo ===ENV_DOMAIN===
grep -E 'DOMAIN|ZONE|GATEWAY|ZSAOS|LAUNCHOS_SYSTEM' /opt/launchos/config/alpha-api.env | sed -E 's/(SECRET|TOKEN|PASSWORD|PRIVATE)=.*/\\1=***/'
echo ===DIG_MORE===
dig +short launchos.app NS || true
dig +short zsaos.com NS || true
dig +short '*.zsaos.com' A || true
dig +short api-alpha.zsaos.com A || true
`;
await runner.writeTextFile('/opt/launchos/bin/step317-sysdomain.sh', script);
const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/bin/step317-sysdomain.sh && /opt/launchos/bin/step317-sysdomain.sh'),
  { timeoutMs: 60000 },
);
console.log(r.stdout || r.stderr);
await runner.disconnect();
await prisma.$disconnect();
