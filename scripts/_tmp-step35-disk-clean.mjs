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

await runner.writeTextFile(
  '/opt/launchos/tmp/step35-disk-clean.sh',
  `#!/bin/bash
set +e
echo '===BEFORE==='
df -h / /opt /var /tmp 2>/dev/null
du -sh /opt/launchos/*/image.tar 2>/dev/null | sort -hr | head -30
du -sh /opt/launchos/artifacts/* 2>/dev/null | sort -hr | head -20
du -sh /tmp/launchos-image-archives 2>/dev/null
podman system df 2>/dev/null || true
echo '===CLEAN==='
# keep newest 2 deployment image archives; remove older
ls -1dt /opt/launchos/cmu*/image.tar 2>/dev/null | tail -n +3 | while read f; do
  dir=$(dirname "$f")
  echo "rm $dir"
  rm -rf "$dir"
done
rm -rf /tmp/launchos-image-archives/* 2>/dev/null
rm -f /opt/launchos/tmp/*.tar 2>/dev/null
# prune unused images/containers but keep running
podman container prune -f 2>/dev/null || true
podman image prune -af 2>/dev/null || true
# vacuum postgres logs if huge
journalctl --vacuum-size=200M 2>/dev/null || true
echo '===AFTER==='
df -h / /opt /var /tmp 2>/dev/null
podman system df 2>/dev/null || true
echo CLEAN_DONE
`,
);
const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/tmp/step35-disk-clean.sh && /opt/launchos/tmp/step35-disk-clean.sh'),
  { timeoutMs: 300000 },
);
console.log(r.stdout || r.stderr);
await runner.disconnect();
await prisma.$disconnect();
