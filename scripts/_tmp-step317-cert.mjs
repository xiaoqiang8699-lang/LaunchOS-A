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
echo ===CERT===
echo | openssl s_client -connect 127.0.0.1:443 -servername web-launchos-multi-demo-5.launchos.app 2>/dev/null | openssl x509 -noout -subject -issuer -ext subjectAltName 2>/dev/null | head -40
echo ===CERT2===
echo | openssl s_client -connect 127.0.0.1:443 -servername web-launchos.zsaos.com 2>/dev/null | openssl x509 -noout -subject -ext subjectAltName 2>/dev/null | head -20
echo ===ROUTE_SNIPPET===
sed -n '200,290p' /opt/launchos/gateway/active/launchos-routes.conf
`;
await runner.writeTextFile('/opt/launchos/bin/step317-cert.sh', script);
const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/bin/step317-cert.sh && /opt/launchos/bin/step317-cert.sh'),
  { timeoutMs: 60000 },
);
console.log(r.stdout || r.stderr);
await runner.disconnect();
await prisma.$disconnect();
