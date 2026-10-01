/**
 * Verify fixed Dockerfile (prisma COPY before npm install) on alpha build context.
 * Then optionally used by full deploy script.
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
  '/opt/launchos/tmp/step34-verify-dockerfile.sh',
  `#!/bin/bash
set +e
OUT=/opt/launchos/tmp/step34-verify-dockerfile.txt
exec >"$OUT" 2>&1
WORKDIR=/opt/launchos/tmp/step34-buildctx
test -f "$WORKDIR/package.json" || { echo MISSING_CTX; exit 2; }
cat > "$WORKDIR/Dockerfile.launchos.fixed" <<'EOF'
FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY package.json package-lock.json* yarn.lock* pnpm-lock.yaml* ./
COPY prisma ./prisma
RUN npm config set registry https://registry.npmmirror.com
RUN npm install
COPY . .
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000
CMD ["npm","run","start"]
EOF
cd "$WORKDIR"
docker build --progress=plain -f Dockerfile.launchos.fixed -t launchos/step34-fixed:test .
echo DOCKER_EXIT=$?
`,
);
await runner.execute(shellCommand('chmod 700 /opt/launchos/tmp/step34-verify-dockerfile.sh && /opt/launchos/tmp/step34-verify-dockerfile.sh'), {
  timeoutMs: 900000,
});
const cat = await runner.execute(
  shellCommand('tail -c 20000 /opt/launchos/tmp/step34-verify-dockerfile.txt'),
  { timeoutMs: 30000 },
);
const text = String(cat.stdout || '');
writeFileSync(join(ARTIFACT_DIR, 'step34-verify-dockerfile.txt'), text);
console.log(text.slice(-8000));
await prisma.$disconnect();
await runner.disconnect();
process.exit(/DOCKER_EXIT=0/.test(text) ? 0 : 1);
