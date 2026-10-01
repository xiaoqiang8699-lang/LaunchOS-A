import { createRequire } from 'node:module';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
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
const { resolveHostnameIpv4 } = requireApi('@launchos/domain');
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });

const hosts = [
  'launchos-real-test.zsaos.com',
  'web-ceshi.zsaos.com',
  'launchos-multi-demo-5.zsaos.com',
  'web-ceshi.launchos.app',
  'api-alpha.zsaos.com',
];

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: '116.62.198.184' } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});

const digScript = `#!/bin/bash
set +e
for h in ${hosts.join(' ')}; do
  echo "HOST=$h"
  dig +short "$h" A || true
  getent ahostsv4 "$h" 2>/dev/null | head -3 || true
  echo ---
done
echo PUBLIC_IP=$(curl -sS --max-time 5 ifconfig.me || true)
`;
await runner.writeTextFile('/opt/launchos/tmp/step35-dig.sh', digScript);
const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/tmp/step35-dig.sh && /opt/launchos/tmp/step35-dig.sh'),
  { timeoutMs: 60000 },
);
console.log('===REMOTE_DIG===\n' + (r.stdout || r.stderr));

const doh = {};
for (const h of hosts) {
  doh[h] = await resolveHostnameIpv4(h);
}
writeFileSync(join(ARTIFACT_DIR, 'step35-dns-resolve.json'), JSON.stringify({ remote: r.stdout, doh }, null, 2));
console.log('===DOH===\n' + JSON.stringify(doh, null, 2));

await runner.disconnect();
await prisma.$disconnect();
