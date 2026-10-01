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
  '/opt/launchos/tmp/step34-minio2.sh',
  `#!/bin/bash
set +e
echo '=== images with minio ==='
podman images --format '{{.Repository}}:{{.Tag}} {{.ID}}' | grep -i minio || echo none
echo
echo '=== endpoint keys only ==='
grep -E '^(MINIO_|S3_|AWS_).*=' /opt/launchos/config/alpha-worker.env | cut -d= -f1
grep -E '^(MINIO_|S3_|AWS_).*=' /opt/launchos/config/alpha-api.env 2>/dev/null | cut -d= -f1 || true
echo
echo '=== endpoint values redacted host/port ==='
python3 - <<'PY'
import re
for path in ['/opt/launchos/config/alpha-worker.env','/opt/launchos/config/alpha-api.env']:
  try:
    text=open(path).read()
  except Exception:
    continue
  print('FILE', path)
  for line in text.splitlines():
    if not line or line.startswith('#') or '=' not in line: continue
    k,v=line.split('=',1)
    if not re.search(r'MINIO|S3_|AWS_', k): continue
    if 'KEY' in k or 'SECRET' in k or 'PASSWORD' in k:
      print(k+'=***')
    else:
      # keep host/port shape only
      v2=re.sub(r'(://)[^/@]+@', r'\\1***@', v)
      print(k+'='+v2)
PY
echo
echo '=== find containers that ever used 9000 ==='
podman ps -a --format '{{.Names}} {{.Image}} {{.Status}} {{.Ports}}' | head -80
echo
echo '=== /opt/launchos for minio dirs ==='
ls -la /opt/launchos 2>/dev/null | head -40
ls -la /opt/launchos/minio 2>/dev/null | head || true
# try quay or mirror if image missing
echo
echo '=== try start existing stopped minio containers ==='
podman ps -a --format '{{.Names}}' | while read n; do
  case "$n" in
    *minio*|*-s3*|artifact*) echo try $n; podman start "$n"; esac
done
ss -lntp | grep -E ':9000|:9001' || echo 'no 9000/9001'
`,
);
const r = await runner.execute(shellCommand('chmod 700 /opt/launchos/tmp/step34-minio2.sh && /opt/launchos/tmp/step34-minio2.sh'), {
  timeoutMs: 120000,
});
const out = String(r.stdout || '') + '\n' + String(r.stderr || '');
writeFileSync(join(ARTIFACT_DIR, 'step34-minio2.txt'), out);
console.log(out.slice(0, 8000));
await prisma.$disconnect();
await runner.disconnect().catch(() => undefined);
