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

function redact(t) {
  return String(t || '')
    .replace(/postgresql:\/\/[^@\s]+@/gi, 'postgresql://***:***@')
    .replace(/redis:\/\/[^@\s]+@/gi, 'redis://***:***@')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer)[=:][^\s]+/gi, '$1=***');
}

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: '116.62.198.184' } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
  readyTimeoutMs: 20000,
});

const r = await runner.execute(
  shellCommand(`
set -e
DBURL=$(grep -E '^DATABASE_URL=' /opt/launchos/config/alpha-api.env | head -n1 | cut -d= -f2- | sed 's/^"//;s/"$//')
REDISURL=$(grep -E '^REDIS_URL=' /opt/launchos/config/alpha-api.env | head -n1 | cut -d= -f2- | sed 's/^"//;s/"$//' || true)
if [ -z "$REDISURL" ]; then REDISURL='redis://127.0.0.1:6379/3'; fi
DEMO_DBURL=$(node -e 'const u=process.argv[1]; const x=new URL(u); x.pathname="/launchos_alpha_demo_multi"; console.log(x.toString())' "$DBURL")
DEMO_REDIS=$(node -e 'const u=process.argv[1]; try{const x=new URL(u); x.pathname="/3"; console.log(x.toString())}catch(e){console.log("redis://127.0.0.1:6379/3")}' "$REDISURL")
umask 077
printf 'DEMO_DATABASE_URL=%s\nDEMO_REDIS_URL=%s\n' "$DEMO_DBURL" "$DEMO_REDIS" > /opt/launchos/tmp/step317-demo-urls.env
podman cp /opt/launchos/tmp/step317-demo-urls.env launchos-alpha-api:/tmp/step317-demo-urls.env
podman cp /opt/launchos/tmp/step317-bind-deps.mjs launchos-alpha-api:/tmp/step317-bind-deps.mjs
podman exec -w /app launchos-alpha-api /bin/sh -c 'set -a; . /tmp/step317-demo-urls.env; set +a; node /tmp/step317-bind-deps.mjs' ; echo EXIT:$?
`),
  { timeoutMs: 120000 },
);
console.log(redact(r.stdout || ''));
console.log('STDERR', redact(r.stderr || ''));
console.log('code', r.exitCode);

await runner.disconnect();
await prisma.$disconnect();
