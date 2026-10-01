import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });

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
  '/opt/launchos/tmp/step34-buserr.sh',
  `#!/bin/sh
set +e
echo '=== host mem ==='
free -h
echo
echo '=== worker stats ==='
podman stats --no-stream launchos-alpha-worker 2>&1
echo
echo '=== worker inspect Memory ==='
podman inspect launchos-alpha-worker --format 'Memory={{.HostConfig.Memory}} MemorySwap={{.HostConfig.MemorySwap}} NanoCpus={{.HostConfig.NanoCpus}}'
echo
echo '=== dmesg OOM/bus ==='
dmesg 2>/dev/null | tail -50 | grep -iE 'oom|killed|bus error|Out of memory' || journalctl -k -n 50 --no-pager 2>/dev/null | grep -iE 'oom|killed|bus' || echo no-dmesg
echo
echo '=== try next build briefly in worker ==='
podman exec launchos-alpha-worker sh -c 'cd /tmp/launchos-repos/cmunsm2lk00ctrl01nnu1pwyd && NODE_OPTIONS=--max-old-space-size=2048 timeout 60 npx next build 2>&1 | tail -30; echo EXIT=$?'
echo
echo '=== ulimit in worker ==='
podman exec launchos-alpha-worker sh -c 'ulimit -a; cat /sys/fs/cgroup/memory.max 2>/dev/null; cat /sys/fs/cgroup/memory.current 2>/dev/null'
`,
);
const r = await runner.execute(shellCommand('chmod 700 /opt/launchos/tmp/step34-buserr.sh && /opt/launchos/tmp/step34-buserr.sh'), {
  timeoutMs: 180000,
});
const out = String(r.stdout || '') + '\n' + String(r.stderr || '');
writeFileSync(join(ARTIFACT_DIR, 'step34-buserr.txt'), out);
console.log(out.slice(0, 10000));
await prisma.$disconnect();
await runner.disconnect().catch(() => undefined);
