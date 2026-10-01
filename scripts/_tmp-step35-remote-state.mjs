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

const script = `#!/bin/bash
set +e
echo '===ENV_DOMAIN==='
grep -E 'LAUNCHOS_SYSTEM_DOMAIN|LAUNCHOS_DOMAIN_ZONE|GATEWAY_PUBLIC_IP|ARTIFACT_STORE' /opt/launchos/config/alpha-api.env /opt/launchos/config/alpha-worker.env 2>/dev/null || true
echo '===PROC_DOMAIN==='
podman exec launchos-alpha-api sh -c 'tr "\\0" "\\n" < /proc/1/environ' 2>/dev/null | grep -E '^LAUNCHOS_SYSTEM_DOMAIN=|^LAUNCHOS_DOMAIN_ZONE=|^GATEWAY_PUBLIC_IP=|^ARTIFACT_STORE=' || true
podman exec launchos-alpha-worker sh -c 'tr "\\0" "\\n" < /proc/1/environ' 2>/dev/null | grep -E '^LAUNCHOS_SYSTEM_DOMAIN=|^LAUNCHOS_DOMAIN_ZONE=|^GATEWAY_PUBLIC_IP=|^ARTIFACT_STORE=|^UPLOAD' || true
echo '===UPLOAD_TAR==='
ls -lh /tmp/launchos-image-archives/*/image.tar 2>/dev/null || ls -lh /opt/launchos/*/image.tar 2>/dev/null || true
du -h /tmp/launchos-image-archives/*/image.tar 2>/dev/null || true
echo '===SFTP==='
ps aux | grep -E 'sftp|scp|image.tar' | grep -v grep | head -20 || true
echo '===WORKER_MOUNTS==='
podman inspect launchos-alpha-worker --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}' 2>/dev/null || true
echo '===DNS_ZSAOS==='
dig +short web-ceshi.zsaos.com A || true
dig +short '*.zsaos.com' A || true
dig +short zsaos.com NS || true
echo '===SYS_DOMAIN_CFG==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, coalesce(\\"rootDomain\\",''), coalesce(\\"dnsStatus\\"::text,''), coalesce(\\"gatewayPublicIp\\",'') FROM \\"SystemDomainConfig\\" ORDER BY \\"createdAt\\" ASC LIMIT 5;" 2>/dev/null || true
echo '===WEB_CESHI_DOMAIN==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT domain, status, \\"dnsStatus\\", \\"sslStatus\\", coalesce(\\"runtimePort\\"::text,''), coalesce(\\"runtimeHost\\",'') FROM \\"ApplicationDomain\\" WHERE domain ILIKE '%ceshi%' OR domain ILIKE '%web-ceshi%' ORDER BY \\"updatedAt\\" DESC;" 2>/dev/null || true
echo '===DEP_CUR==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, \\"currentStage\\", \\"uploadStatus\\", \\"lastActivityAt\\", \\"errorMessage\\" FROM \\"Deployment\\" WHERE id='cmuo1j5k5001vrl01aio07lf3';" 2>/dev/null || true
echo '===RUNNING_STALL==='
podman exec launchos-alpha-worker sh -c 'tr "\\0" "\\n" < /proc/1/environ' 2>/dev/null | grep -E 'STALL|TIMEOUT|UPLOAD' || true
`;

await runner.writeTextFile('/opt/launchos/tmp/step35-remote-state.sh', script);
const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/tmp/step35-remote-state.sh && /opt/launchos/tmp/step35-remote-state.sh'),
  { timeoutMs: 90000 },
);
const out = String(r.stdout || '') + String(r.stderr || '');
writeFileSync(join(ARTIFACT_DIR, 'step35-remote-state.txt'), out);
console.log(out);
await runner.disconnect();
await prisma.$disconnect();
