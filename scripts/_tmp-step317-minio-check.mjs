import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

function redact(t) {
  return String(t || '')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|ACCESS_KEY|SECRET_KEY|MINIO_SECRET)[=:][^\s]+/gi, '$1=***')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***');
}

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
  '/opt/launchos/bin/step317-minio-check.sh',
  `#!/bin/bash
set -uo pipefail
echo ===CONTAINERS===
podman ps -a --format '{{.Names}} {{.Status}} {{.Ports}}' | sed -n '/minio\\|9000\\|redis\\|postgres\\|alpha/p'
echo ===PORTS===
ss -lntp 2>/dev/null | sed -n '/:9000\\|:9001\\|:391/p' || netstat -lntp 2>/dev/null | sed -n '/:9000\\|:9001/p'
echo ===API_ENV_MINIO===
sed -n '/MINIO\\|S3_\\|ARTIFACT/s/=.*$/=***/p' /opt/launchos/config/alpha-api.env
echo ===WORKER_ENV_MINIO===
podman inspect launchos-alpha-worker --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n '/MINIO\\|S3_\\|ARTIFACT/s/=.*$/=***/p'
echo ===DISK===
df -h /opt /var | head -n 20
echo ===IMAGES===
podman images | sed -n '1p;/minio/p'
`,
);

const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/bin/step317-minio-check.sh && /opt/launchos/bin/step317-minio-check.sh'),
  { timeoutMs: 60000 },
);
const out = redact((r.stdout || '') + (r.stderr || ''));
writeFileSync(join(root, '.tools/alpha-runtime/step317-minio-check.txt'), out);
console.log(out);
await runner.disconnect();
await prisma.$disconnect();
