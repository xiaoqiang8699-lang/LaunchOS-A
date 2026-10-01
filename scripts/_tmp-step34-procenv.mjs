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
  '/opt/launchos/tmp/step34-procenv.sh',
  `#!/bin/sh
set +e
check_proc() {
  NAME="$1"
  echo "=== $NAME /proc/1/environ github keys ==="
  podman exec "$NAME" sh -c 'tr "\\0" "\\n" < /proc/1/environ | grep -E "^GITHUB_|^GH_" | sed -E "s/(GITHUB_APP_PRIVATE_KEY=).*/\\1YES_LEN=$(tr \"\\0\" \"\\n\" < /proc/1/environ | grep ^GITHUB_APP_PRIVATE_KEY= | wc -c)/; s/(=.+)$/=***/" | sort'
  echo "=== $NAME PK present in proc? ==="
  podman exec "$NAME" sh -c 'tr "\\0" "\\n" < /proc/1/environ | grep -q "^GITHUB_APP_PRIVATE_KEY=-----" && echo PK=YES || echo PK=NO'
  echo "=== $NAME CALLBACK in proc? ==="
  podman exec "$NAME" sh -c 'tr "\\0" "\\n" < /proc/1/environ | grep -q "^GITHUB_APP_CALLBACK_URL=." && echo CB=YES || echo CB=NO'
}
check_proc launchos-alpha-api
check_proc launchos-alpha-worker
echo '=== worker.env github ==='
grep -E 'GITHUB|GH_' /opt/launchos/config/alpha-worker.env 2>/dev/null | sed -E 's/(=.+)$/=***/' || true
echo '=== worker recent logs ==='
podman logs --tail 80 launchos-alpha-worker 2>&1 | sed -E 's/gh[pousr]_[A-Za-z0-9_]{20,}/***/g; s/enc:v1:[A-Za-z0-9+/=:_-]+/enc:v1:***/g; s/Bearer [A-Za-z0-9._-]+/Bearer ***/g'
`,
);
const r = await runner.execute(shellCommand('chmod 700 /opt/launchos/tmp/step34-procenv.sh && /opt/launchos/tmp/step34-procenv.sh'), {
  timeoutMs: 90000,
});
const out = String(r.stdout || '') + '\n' + String(r.stderr || '');
writeFileSync(join(ARTIFACT_DIR, 'step34-procenv.txt'), out);
console.log(out.slice(0, 8000));
await prisma.$disconnect();
await runner.disconnect().catch(() => undefined);
