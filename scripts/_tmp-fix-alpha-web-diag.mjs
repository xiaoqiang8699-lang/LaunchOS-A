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
const server = await prisma.serverInstance.findFirst({ where: { host: '116.62.198.184' } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});

await runner.writeTextFile(
  '/opt/launchos/tmp/step35-web-diag.sh',
  `#!/bin/bash
set +e
echo '===PS==='
podman ps -a --filter name=launchos-alpha-web --format '{{.Names}} {{.Status}} {{.Ports}} {{.Image}}'
echo '===LOGS==='
podman logs --tail 50 launchos-alpha-web 2>&1
echo '===ENV_IN_IMAGE==='
podman inspect launchos-alpha-web --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep -E 'PORT|HOST|API|NEXT' || true
echo '===CMD==='
podman inspect launchos-alpha-web --format 'Cmd={{json .Config.Cmd}} Entrypoint={{json .Config.Entrypoint}}'
`,
);
const diag = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/tmp/step35-web-diag.sh && /opt/launchos/tmp/step35-web-diag.sh'),
  { timeoutMs: 60000 },
);
console.log(diag.stdout || diag.stderr);

await runner.disconnect();
await prisma.$disconnect();
