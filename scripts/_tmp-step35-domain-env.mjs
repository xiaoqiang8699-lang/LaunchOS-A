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

function redact(t) {
  return String(t || '')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer|accessToken|AUTH_SECRET)\s*[=:]\s*\S+/gi, '$1=***')
    .replace(/enc:v1:[A-Za-z0-9+/=:_-]+/g, 'enc:v1:***');
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

async function remoteOk(cmd, label, opts = {}) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs: opts.timeoutMs ?? 120000 });
  if (r.exitCode !== 0) throw new Error(`${label}: ${redact(r.stderr || r.stdout || '').slice(0, 2000)}`);
  return r;
}

await runner.writeTextFile(
  '/opt/launchos/tmp/step35-domain-env.sh',
  `#!/bin/sh
set +e
echo '=== system domain env ==='
podman exec launchos-alpha-api sh -c 'tr "\\0" "\\n" < /proc/1/environ | grep -E "^LAUNCHOS_SYSTEM_DOMAIN=|^LAUNCHOS_DOMAIN_ZONE=|^ARTIFACT_STORE=|^UPLOAD" || true'
podman exec launchos-alpha-worker sh -c 'tr "\\0" "\\n" < /proc/1/environ | grep -E "^LAUNCHOS_SYSTEM_DOMAIN=|^LAUNCHOS_DOMAIN_ZONE=|^ARTIFACT_STORE=|^UPLOAD|TIMEOUT" || true'
grep -E 'LAUNCHOS_SYSTEM_DOMAIN|LAUNCHOS_DOMAIN_ZONE|ARTIFACT_STORE|UPLOAD' /opt/launchos/config/alpha-api.env /opt/launchos/config/alpha-worker.env 2>/dev/null || true
echo
echo '=== existing zsaos domains ==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "SELECT domain, status, \\"dnsStatus\\", \\"sslStatus\\" FROM \\"ApplicationDomain\\" WHERE domain ILIKE '%zsaos.com%' ORDER BY \\"updatedAt\\" DESC LIMIT 15;"
echo
echo '=== worker process sample (upload?) ==='
podman exec launchos-alpha-worker sh -c 'ps aux | head -30'
echo
echo '=== ssh/scp processes ==='
ps aux | grep -iE 'scp|sftp|ssh|rsync' | grep -v grep | head -20
echo
echo '=== open files for large tar ==='
ls -lah /tmp/launchos-image-archives/ 2>/dev/null
ls -lah /opt/launchos/cmuo1j5k5001vrl01aio07lf3 2>/dev/null || echo 'remoteDir not created yet'
`,
);
const r = await remoteOk('chmod 700 /opt/launchos/tmp/step35-domain-env.sh && /opt/launchos/tmp/step35-domain-env.sh', 'env');
const out = redact(String(r.stdout || ''));
writeFileSync(join(ARTIFACT_DIR, 'step35-domain-env.txt'), out);
console.log(out);
await prisma.$disconnect();
await runner.disconnect().catch(() => undefined);
