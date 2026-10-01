/**
 * Reproduce docker build for web-ceshi on alpha builder to capture real npm stderr.
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

const PROJECT = 'cmunsm2lk00ctrl01nnu1pwyd';
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });

function redact(t) {
  return String(t || '')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer|x-access-token)[=:]\S+/gi, '$1=***');
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
  '/opt/launchos/tmp/step34-repro.sh',
  `#!/bin/bash
set +e
REPO=/tmp/launchos-repos/${PROJECT}
OUT=/opt/launchos/tmp/step34-repro-out.txt
exec >"$OUT" 2>&1
echo ===BEGIN===
date
echo REPO=$REPO
ls -la "$REPO" | head -40
echo ===LOCKS===
ls -la "$REPO"/package.json "$REPO"/package-lock.json "$REPO"/pnpm-lock.yaml "$REPO"/yarn.lock 2>&1
echo ===PKG_JSON_HEAD===
head -c 2500 "$REPO/package.json"
echo
echo ===ENGINES===
node -e 'const p=require("/tmp/launchos-repos/${PROJECT}/package.json"); console.log(JSON.stringify({name:p.name,engines:p.engines,packageManager:p.packageManager,scripts:p.scripts},null,2))'
echo ===DOCKER===
which docker; which podman; docker version 2>&1 | head -20; podman version 2>&1 | head -10
echo ===BASE_IMAGE===
podman image exists node:20-alpine && echo BASE_OK || echo BASE_MISSING
docker image inspect node:20-alpine >/dev/null 2>&1 && echo DOCKER_BASE_OK || echo DOCKER_BASE_MISSING
echo ===WRITE_DOCKERFILE===
cat > "$REPO/Dockerfile.launchos.step34" <<'EOF'
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* yarn.lock* pnpm-lock.yaml* ./
RUN npm config set registry https://registry.npmmirror.com
RUN npm install
COPY . .
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000
CMD ["npm","run","start"]
EOF
echo ===BUILD===
cd "$REPO" || exit 2
# Prefer same CLI LaunchOS uses
if command -v docker >/dev/null 2>&1; then
  docker build --progress=plain -f Dockerfile.launchos.step34 -t launchos/step34-repro:test . 
  echo DOCKER_EXIT=$?
else
  podman build --format docker -f Dockerfile.launchos.step34 -t launchos/step34-repro:test .
  echo PODMAN_EXIT=$?
fi
echo ===REGISTRY===
curl -sS -o /dev/null -w 'npmmirror:%{http_code} time:%{time_total}\n' --max-time 20 https://registry.npmmirror.com/
curl -sS -o /dev/null -w 'npmjs:%{http_code} time:%{time_total}\n' --max-time 20 https://registry.npmjs.org/
echo ===END===
date
`,
);

const run = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/tmp/step34-repro.sh && /opt/launchos/tmp/step34-repro.sh'),
  { timeoutMs: 900000 },
);
const cat = await runner.execute(shellCommand('wc -c /opt/launchos/tmp/step34-repro-out.txt; tail -c 80000 /opt/launchos/tmp/step34-repro-out.txt'), {
  timeoutMs: 60000,
});
const text = redact(String(cat.stdout || '') + '\n' + String(run.stderr || ''));
writeFileSync(join(ARTIFACT_DIR, 'step34-repro.txt'), text);
console.log(text.slice(-12000));
await prisma.$disconnect();
await runner.disconnect();
