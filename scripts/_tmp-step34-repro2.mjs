/**
 * Fetch web-ceshi via worker path / artifact and reproduce docker build with full logs.
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

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
const bcryptLib = requireApi('bcrypt');

const PROJECT = 'cmunsm2lk00ctrl01nnu1pwyd';
const DEP = 'cmunvd5xl0015rl01xbv001ex';
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
  '/opt/launchos/tmp/step34-repro2.sh',
  `#!/bin/bash
set +e
OUT=/opt/launchos/tmp/step34-repro2-out.txt
exec >"$OUT" 2>&1
echo ===BEGIN===; date
echo ===WORKER_MOUNTS===
podman inspect launchos-alpha-worker --format '{{range .Mounts}}{{.Source}} -> {{.Destination}} ({{.Type}}){{"\\n"}}{{end}}' 2>&1 | head -40
echo ===ARTIFACT===
ls -la /opt/launchos/artifacts/launchos-artifacts/deployments/${DEP}/ 2>&1 | head -20
ls -la /opt/launchos/artifacts/ 2>&1 | head -20
# Unpack build artifact if present
WORKDIR=/opt/launchos/tmp/step34-buildctx
rm -rf "$WORKDIR"
mkdir -p "$WORKDIR"
ART=/opt/launchos/artifacts/launchos-artifacts/deployments/${DEP}/build-output.tar
if [ -f "$ART" ]; then
  echo USING_ARTIFACT=$ART
  tar -xf "$ART" -C "$WORKDIR" 2>&1 | tail -20
else
  echo NO_ARTIFACT
  # try worker container copy
  podman cp launchos-alpha-worker:/tmp/launchos-repos/${PROJECT}/. "$WORKDIR/" 2>&1 | tail -20
fi
echo ===CTX===
ls -la "$WORKDIR" | head -40
echo ===LOCKS===
ls -la "$WORKDIR"/package.json "$WORKDIR"/package-lock.json "$WORKDIR"/pnpm-lock.yaml "$WORKDIR"/yarn.lock 2>&1
if [ -f "$WORKDIR/package.json" ]; then
  podman run --rm -v "$WORKDIR:/app:ro" node:20-alpine node -e 'const p=require("/app/package.json"); console.log(JSON.stringify({name:p.name,engines:p.engines,packageManager:p.packageManager,hasLock:false,scripts:p.scripts,depCount:Object.keys(p.dependencies||{}).length,devDepCount:Object.keys(p.devDependencies||{}).length},null,2))'
fi
echo ===DOCKERFILE===
cat > "$WORKDIR/Dockerfile.launchos.step34" <<'EOF'
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
echo ===BUILD_PLAIN===
cd "$WORKDIR" || exit 2
# Match worker: docker CLI which is podman alias
docker build --progress=plain -f Dockerfile.launchos.step34 -t launchos/step34-repro:test . 
echo DOCKER_EXIT=$?
echo ===ALSO_TRY_NPM_IN_CONTAINER===
# isolate npm install to see real stderr
podman run --rm -v "$WORKDIR:/app" -w /app node:20-alpine sh -c 'npm config set registry https://registry.npmmirror.com; npm install' 
echo NPM_IN_CONTAINER_EXIT=$?
echo ===REGISTRY===
curl -sS -o /dev/null -w 'npmmirror:%{http_code}\n' --max-time 20 https://registry.npmmirror.com/ || echo npmmirror_fail
curl -sS -o /dev/null -w 'npmjs:%{http_code}\n' --max-time 20 https://registry.npmjs.org/ || echo npmjs_fail
echo ===END===; date
`,
);

const run = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/tmp/step34-repro2.sh && /opt/launchos/tmp/step34-repro2.sh'),
  { timeoutMs: 900000 },
);
const cat = await runner.execute(
  shellCommand('wc -c /opt/launchos/tmp/step34-repro2-out.txt; tail -c 120000 /opt/launchos/tmp/step34-repro2-out.txt'),
  { timeoutMs: 60000 },
);
const text = redact(String(cat.stdout || '') + '\nRUN_ERR=\n' + String(run.stderr || ''));
writeFileSync(join(ARTIFACT_DIR, 'step34-repro2.txt'), text);
console.log(text.slice(0, 8000));
console.log('\n===== TAIL =====\n');
console.log(text.slice(-10000));
await prisma.$disconnect();
await runner.disconnect();
