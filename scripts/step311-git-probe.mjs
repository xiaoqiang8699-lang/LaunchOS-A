import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of [resolve(root, '.env')]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
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

const script = `#!/bin/sh
set -x
podman exec launchos-alpha-api sh -c 'git --version; echo; GIT_TERMINAL_PROMPT=0 git ls-remote --heads https://github.com/octocat/Hello-World.git 2>&1 | head -20; echo EXIT:$?; echo; GIT_TERMINAL_PROMPT=0 git ls-remote --symref https://github.com/octocat/Hello-World.git HEAD 2>&1 | head -20; echo EXIT2:$?; echo; curl -sSI --max-time 20 https://github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack 2>&1 | head -20'
`;
await runner.writeTextFile('/opt/launchos/bin/step311-git-probe.sh', script);
const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/bin/step311-git-probe.sh && /opt/launchos/bin/step311-git-probe.sh'),
  { timeoutMs: 120000 },
);
console.log(String(r.stdout || '').slice(0, 5000));
console.log(String(r.stderr || '').slice(0, 2000));
console.log('exit', r.exitCode);
await runner.disconnect();
await prisma.$disconnect();
