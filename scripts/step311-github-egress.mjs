import { createRequire } from 'node:module';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
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
  "echo TCP443; timeout 8 bash -c 'echo >/dev/tcp/20.205.243.166/443' && echo OPEN || echo CLOSED_OR_TIMEOUT",
  "echo OPENSSL; timeout 8 openssl s_client -connect 20.205.243.166:443 -servername github.com </dev/null 2>&1 | head -15 || true",
  "echo LOCAL_CLONE; podman exec launchos-alpha-api sh -c 'rm -rf /tmp/t.git /tmp/t2 && git init --bare /tmp/t.git >/dev/null && git clone /tmp/t.git /tmp/t2 2>&1 && echo LOCAL_CLONE_OK'",
].join('; ');
const r = await runner.execute(shellCommand(cmd), { timeoutMs: 60000 });
console.log(String(r.stdout || '').slice(0, 4000));
console.log(String(r.stderr || '').slice(0, 1000));
await runner.disconnect();
await prisma.$disconnect();

const reportPath = resolve(root, '.tools/step311-git-runtime-fix-report.json');
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
report.publicRepoAnalyze = {
  ...report.publicRepoAnalyze,
  residualError:
    'Git binary present; public GitHub HTTPS from host hangs (TCP/openssl timeout to github.com). API error was GitError 无法拉取代码：fatal: expected flush after ref listing / 504. Not 本机未安装 Git.',
  githubEgress: 'BLOCKED_OR_FILTERED from 116.62.198.184',
  gitMissingError: false,
  ok: false,
};
report.final = 'FAIL';
writeFileSync(reportPath, JSON.stringify(report, null, 2));
