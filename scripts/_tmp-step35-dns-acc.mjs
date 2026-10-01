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
echo '===TABLES==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -At -c "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename ILIKE '%dns%' OR tablename ILIKE '%provider%';"
echo '===DNS_ACCOUNT==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "\\d \\"DnsProviderAccount\\"" 2>/dev/null | head -40 || true
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, \\"providerId\\", status::text FROM \\"DnsProviderAccount\\" LIMIT 5;" 2>/dev/null || true
echo '===CLOUD_PROVIDER==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, type::text, name FROM \\"CloudProvider\\" WHERE type::text ILIKE '%DNS%' OR type::text ILIKE '%ALIYUN%' LIMIT 10;" 2>/dev/null || true
echo '===APP_DOMAIN_COLS==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -At -c "SELECT column_name FROM information_schema.columns WHERE table_name='ApplicationDomain' ORDER BY ordinal_position;"
echo '===ZSAOS_DOMAINS==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT domain, status::text, \\"dnsStatus\\"::text, \\"sslStatus\\"::text FROM \\"ApplicationDomain\\" WHERE domain LIKE '%.zsaos.com' ORDER BY \\"updatedAt\\" DESC LIMIT 25;"
echo '===LAUNCHOS_APP_DOMAINS==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT domain, status::text, \\"dnsStatus\\"::text FROM \\"ApplicationDomain\\" WHERE domain LIKE '%.launchos.app' ORDER BY \\"updatedAt\\" DESC LIMIT 10;"
`;
await runner.writeTextFile('/opt/launchos/tmp/step35-dns-acc.sh', script);
const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/tmp/step35-dns-acc.sh && /opt/launchos/tmp/step35-dns-acc.sh'),
  { timeoutMs: 60000 },
);
console.log(r.stdout || r.stderr);
await runner.disconnect();
await prisma.$disconnect();
