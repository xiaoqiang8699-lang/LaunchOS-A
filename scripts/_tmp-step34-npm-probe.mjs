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
  '/opt/launchos/tmp/step34-npm-probe.sh',
  `#!/bin/sh
set +e
REPO=/tmp/launchos-repos/cmunsm2lk00ctrl01nnu1pwyd
echo '=== repo ==='
ls -la "$REPO" 2>&1 | head -20
echo
echo '=== package manager files ==='
ls -la "$REPO"/package.json "$REPO"/package-lock.json "$REPO"/pnpm-lock.yaml "$REPO"/yarn.lock 2>&1
echo
echo '=== engines / postinstall ==='
podman exec launchos-alpha-worker sh -c "node -e \\"const p=require('$REPO/package.json'); console.log(JSON.stringify({engines:p.engines,scripts:p.scripts,packageManager:p.packageManager},null,2))\\"" 2>&1 | head -40
echo
echo '=== network from worker ==='
podman exec launchos-alpha-worker sh -c 'node -e "fetch(\\"https://registry.npmjs.org/npm\\").then(r=>console.log(\\"npmjs\\",r.status)).catch(e=>console.log(\\"npmjs ERR\\",e.message)); fetch(\\"https://registry.npmmirror.com/npm\\").then(r=>console.log(\\"npmmirror\\",r.status)).catch(e=>console.log(\\"npmmirror ERR\\",e.message));"' 2>&1
echo
echo '=== npm config in worker ==='
podman exec launchos-alpha-worker sh -c 'npm config get registry; node -v; npm -v' 2>&1
echo
echo '=== quick npm install dry probe (90s) ==='
podman exec launchos-alpha-worker sh -c "cd $REPO && NPM_CONFIG_PRODUCTION=false timeout 90 npm install --prefer-offline --no-audit --no-fund 2>&1 | tail -40; echo EXIT=\$?"
`,
);
const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/tmp/step34-npm-probe.sh && /opt/launchos/tmp/step34-npm-probe.sh'),
  { timeoutMs: 180000 },
);
const out = String(r.stdout || '') + '\n' + String(r.stderr || '');
writeFileSync(join(ARTIFACT_DIR, 'step34-npm-probe.txt'), out);
console.log(out.slice(0, 12000));
await prisma.$disconnect();
await runner.disconnect().catch(() => undefined);
