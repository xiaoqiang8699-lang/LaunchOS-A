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
const server = await prisma.serverInstance.findFirst({ where: { id: 'cmuma9i480001rij49yv4yw2q' } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername({ serverUsername: server.username, provider: server.provider }),
  password: decryptCredential(server.credentialEncrypted),
  readyTimeoutMs: 30000,
});
async function remote(cmd, timeoutMs = 60000) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs });
  console.log('>>>', cmd.slice(0, 160));
  console.log(((r.stdout || '') + (r.stderr || '')).slice(-5000));
  return r;
}
await remote('podman ps -a --filter name=launchos-alpha-web --format "{{.Names}} {{.Status}} {{.Ports}} {{.Image}}"');
await remote('podman logs --tail 80 launchos-alpha-web 2>&1');
await remote('curl -sS -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:39100/ || echo FAIL');
await remote('curl -sS -o /dev/null -w "%{http_code}" --max-time 5 http://127.0.0.1:39100/billing || echo FAIL');
await remote('ss -lntp | grep -E "39100|39110" || netstat -lntp | grep -E "39100|39110" || true');
await remote('sed -n "1,120p" /opt/launchos/bin/m5-run-web.sh');
await runner.disconnect();
await prisma.$disconnect();
