import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of [resolve(root, '.env'), resolve(root, '.secrets/alpha-data-plane.env')]) {
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
await runner.connect({ host: server.host, port: server.port, username: resolveServerSshUsername(server.username), password: decryptCredential(server.credentialEncrypted), readyTimeoutMs: 20000 });

await runner.writeTextFile('/opt/launchos/tmp/step314-src.sql', `SELECT id, type, url, branch, "isPrivate", "connectionId", "projectId", "authStatus"
FROM "SourceRepository"
ORDER BY "createdAt" DESC
LIMIT 8;
`);
const sql = await runner.execute(
  shellCommand(`podman cp /opt/launchos/tmp/step314-src.sql launchos-alpha-postgres:/tmp/step314-src.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -f /tmp/step314-src.sql`),
  { timeoutMs: 30000 },
);
console.log('SOURCES', sql.stdout);

const cloneTest = await runner.execute(
  shellCommand(`podman exec -w /app/apps/api launchos-alpha-api node -e "const {createRequire}=require('module'); const r=createRequire('/app/apps/api/package.json'); const {GitService}=r('@launchos/git'); const g=new GitService(); (async()=>{ const d='/tmp/launchos-repos/_probe_hw'; try { await g.cloneRepository('https://github.com/octocat/Hello-World.git', d, 'master'); console.log('CLONE_OK'); } catch(e){ console.log('CLONE_FAIL', e && e.message); } })();"`),
  { timeoutMs: 120000 },
);
console.log('CLONE_TEST', cloneTest.stdout, cloneTest.stderr, cloneTest.exitCode);

await runner.disconnect(); await prisma.$disconnect();
