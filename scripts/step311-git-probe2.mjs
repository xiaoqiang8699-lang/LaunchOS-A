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
  "echo HOST_CURL; curl -sS -o /dev/null -w '%{http_code} time=%{time_total}\\n' --max-time 15 https://github.com/ || true",
  "echo CTR_CURL; podman exec launchos-alpha-api sh -c \"curl -sS -o /dev/null -w '%{http_code} time=%{time_total}\\n' --max-time 15 https://github.com/ || echo CURL_MISSING\"",
  "echo CTR_GIT_TIMEOUT; podman exec launchos-alpha-api sh -c \"timeout 20 env GIT_TERMINAL_PROMPT=0 git -c http.version=HTTP/1.1 ls-remote --heads https://github.com/octocat/Hello-World.git; echo EXIT:$?\"",
  "echo CTR_GIT_HTTP2; podman exec launchos-alpha-api sh -c \"timeout 20 env GIT_TERMINAL_PROMPT=0 git ls-remote --heads https://github.com/octocat/Hello-World.git; echo EXIT:$?\"",
].join('; ');

const r = await runner.execute(shellCommand(cmd), { timeoutMs: 90000 });
console.log(String(r.stdout || '').slice(0, 4000));
console.log(String(r.stderr || '').slice(0, 1500));
console.log('exit', r.exitCode);
await runner.disconnect();
await prisma.$disconnect();
