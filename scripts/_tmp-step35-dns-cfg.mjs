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
echo '===DNS_ENV_KEYS==='
grep -E 'ALIYUN|DNS|DOMAIN|GATEWAY|SYSTEM_DOMAIN' /opt/launchos/config/alpha-api.env 2>/dev/null | sed -E 's/(SECRET|TOKEN|PASSWORD|KEY|ACCESS)=.*/\\1=***/' || true
echo '===DNS_PROVIDER_DB==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, coalesce(name,''), coalesce(type::text,''), coalesce(status::text,'') FROM \\"DnsProviderAccount\\" LIMIT 10;" 2>/dev/null || true
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT column_name FROM information_schema.columns WHERE table_name='SystemDomainConfig' ORDER BY ordinal_position;" 2>/dev/null || true
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "SELECT * FROM \\"SystemDomainConfig\\";" 2>/dev/null | head -40 || true
echo '===REAL_TEST_DOMAIN_ROW==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT domain, status, \\"dnsStatus\\", \\"sslStatus\\", coalesce(\\"providerRecordId\\",'') FROM \\"ApplicationDomain\\" WHERE domain LIKE '%real-test%' OR domain LIKE '%zsaos.com' ORDER BY \\"updatedAt\\" DESC LIMIT 20;" 2>/dev/null || true
`;
await runner.writeTextFile('/opt/launchos/tmp/step35-dns-cfg.sh', script);
const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/tmp/step35-dns-cfg.sh && /opt/launchos/tmp/step35-dns-cfg.sh'),
  { timeoutMs: 60000 },
);
console.log(r.stdout || r.stderr);
await runner.disconnect();
await prisma.$disconnect();
