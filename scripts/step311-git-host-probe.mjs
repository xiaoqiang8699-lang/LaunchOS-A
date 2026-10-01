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

await runner.writeTextFile(
  '/opt/launchos/bin/step311-git-host.sh',
  `#!/bin/sh
echo HOST_GIT_VER
command -v git; git --version || echo NO_HOST_GIT
echo HOST_LS
GIT_TERMINAL_PROMPT=0 git -c http.version=HTTP/1.1 ls-remote --heads https://github.com/octocat/Hello-World.git > /tmp/hg-out.txt 2> /tmp/hg-err.txt & pid=$!
i=0
while kill -0 $pid 2>/dev/null; do
  i=$((i+1))
  if [ "$i" -gt 30 ]; then kill $pid 2>/dev/null; wait $pid 2>/dev/null; echo KILLED; break; fi
  sleep 1
done
wait $pid
echo EXIT:$?
echo OUT; cat /tmp/hg-out.txt
echo ERR; cat /tmp/hg-err.txt
echo CTR_HTTP11
podman exec launchos-alpha-api sh -c 'GIT_TERMINAL_PROMPT=0 GIT_TRACE_PACKET=1 GIT_CURL_VERBOSE=1 git -c http.version=HTTP/1.1 ls-remote --heads https://github.com/octocat/Hello-World.git' > /tmp/cg-out.txt 2> /tmp/cg-err.txt & pid=$!
i=0
while kill -0 $pid 2>/dev/null; do
  i=$((i+1))
  if [ "$i" -gt 25 ]; then kill $pid 2>/dev/null; wait $pid 2>/dev/null; echo CTR_KILLED; break; fi
  sleep 1
done
wait $pid
echo CTR_EXIT:$?
echo CTR_OUT; cat /tmp/cg-out.txt | tail -40
echo CTR_ERR; cat /tmp/cg-err.txt | tail -60
`,
);
const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/bin/step311-git-host.sh && /opt/launchos/bin/step311-git-host.sh'),
  { timeoutMs: 120000 },
);
console.log(String(r.stdout || '').slice(0, 7000));
console.log(String(r.stderr || '').slice(0, 1500));
await runner.disconnect();
await prisma.$disconnect();
