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
  '/opt/launchos/tmp/step34-ghapp-diag.sh',
  `#!/bin/sh
set +e
echo '=== api inspect ==='
podman inspect launchos-alpha-api --format 'image={{.Config.Image}} running={{.State.Running}} mounts={{range .Mounts}}{{.Source}}->{{.Destination}};{{end}}'
echo
echo '=== api env keys (redacted) ==='
podman exec launchos-alpha-api sh -c 'env | grep -E "^GITHUB_|^GH_" | sed -E "s/(=.+$)/=***/" | sort'
echo
echo '=== pem file ==='
ls -la /opt/launchos/config/github-app.pem 2>&1
podman exec launchos-alpha-api sh -c 'ls -la /run/secrets/github-app.pem 2>&1; wc -c /run/secrets/github-app.pem 2>&1; echo PEM_START=$(head -c 30 /run/secrets/github-app.pem 2>/dev/null)'
echo
echo '=== worker env keys ==='
podman exec launchos-alpha-worker sh -c 'env | grep -E "^GITHUB_|^GH_" | sed -E "s/(=.+$)/=***/" | sort'
echo
echo '=== alpha-api.env github lines ==='
grep -E 'GITHUB|GH_' /opt/launchos/config/alpha-api.env 2>/dev/null | sed -E 's/(=.+$)/=***/' || true
echo
echo '=== alpha-github.env ==='
ls -la /opt/launchos/config/alpha-github.env 2>&1
grep -E 'GITHUB|GH_' /opt/launchos/config/alpha-github.env 2>/dev/null | sed -E 's/(=.+$)/=***/' || true
echo
echo '=== recent api logs ==='
podman logs --tail 40 launchos-alpha-api 2>&1 | sed -E 's/gh[pousr]_[A-Za-z0-9_]{20,}/***/g; s/enc:v1:[A-Za-z0-9+/=:_-]+/enc:v1:***/g'
echo
echo '=== deployment detail ==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT id, status, coalesce(\\"failureCode\\",''), left(coalesce(\\"errorMessage\\",''),300) FROM \\"Deployment\\" WHERE id='cmunxlwnr0011rl01g49d369r';"
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT \\"stepKey\\", status, left(coalesce(\\"errorMessage\\",''),300) FROM \\"DeploymentStep\\" WHERE \\"deploymentId\\"='cmunxlwnr0011rl01g49d369r' ORDER BY \\"createdAt\\";"
`,
);

const r = await runner.execute(shellCommand('chmod 700 /opt/launchos/tmp/step34-ghapp-diag.sh && /opt/launchos/tmp/step34-ghapp-diag.sh'), {
  timeoutMs: 120000,
});
const out = String(r.stdout || '') + '\n' + String(r.stderr || '');
writeFileSync(join(ARTIFACT_DIR, 'step34-ghapp-diag.txt'), out);
console.log(out.slice(0, 6000));
console.log('exit', r.exitCode);
await prisma.$disconnect();
await runner.disconnect().catch(() => undefined);
