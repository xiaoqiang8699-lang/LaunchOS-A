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

const cmd = [
  "echo CURL1; curl -4 -v --max-time 20 -o /dev/null https://github.com/ 2>&1 | tail -30",
  "echo CURL2; curl -4 --max-time 20 -sS -o /dev/null -w 'code=%{http_code} connect=%{time_connect} tls=%{time_appconnect} total=%{time_total}\\n' https://api.github.com/zen || true",
  "echo GIT_ONCE; timeout 40 env GIT_TERMINAL_PROMPT=0 git -c http.version=HTTP/1.1 ls-remote --heads https://github.com/octocat/Hello-World.git; echo EXIT:$?",
].join('; ');
const r = await runner.execute(shellCommand(cmd), { timeoutMs: 120000 });
console.log(String(r.stdout || '').slice(0, 6000));
console.log(String(r.stderr || '').slice(0, 1000));
await runner.disconnect();
await prisma.$disconnect();
