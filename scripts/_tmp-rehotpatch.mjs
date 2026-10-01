import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
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

const LIVE = 'launchos-alpha-api';
const files = [
  { local: resolve(root, 'packages/git/dist/git.service.js'), remoteHost: '/opt/launchos/tmp/step314-git.service.js', remoteCtr: '/app/packages/git/dist/git.service.js' },
  { local: resolve(root, 'apps/api/dist/analyses/analyses.service.js'), remoteHost: '/opt/launchos/tmp/step314-analyses.service.js', remoteCtr: '/app/apps/api/dist/analyses/analyses.service.js' },
  { local: resolve(root, 'apps/api/dist/analyses/analyses.module.js'), remoteHost: '/opt/launchos/tmp/step314-analyses.module.js', remoteCtr: '/app/apps/api/dist/analyses/analyses.module.js' },
];

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: '116.62.198.184' } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
  readyTimeoutMs: 20000,
});

await runner.execute(shellCommand('mkdir -p /opt/launchos/tmp'), { timeoutMs: 15000 });
for (const f of files) {
  if (!existsSync(f.local)) throw new Error('missing ' + f.local);
  await runner.upload(f.local, f.remoteHost, { timeoutMs: 60000 });
  const cp = await runner.execute(
    shellCommand(`podman cp ${f.remoteHost} ${LIVE}:${f.remoteCtr}`),
    { timeoutMs: 30000 },
  );
  if (cp.exitCode !== 0) throw new Error('cp failed ' + f.remoteCtr + ' ' + (cp.stderr || cp.stdout));
  console.log('COPIED', f.remoteCtr);
}

// Restart container to load patched modules
const restart = await runner.execute(
  shellCommand(`podman restart ${LIVE} && sleep 5 && podman exec ${LIVE} /bin/sh -c 'grep -n "http.version=HTTP/1.1" /app/packages/git/dist/git.service.js | head -n1; grep -n resolveAuthForSource /app/apps/api/dist/analyses/analyses.service.js | head -n1; grep -n GitHubConnectionsModule /app/apps/api/dist/analyses/analyses.module.js | head -n1' && curl -sS -m 20 http://127.0.0.1:39110/api/v1/health`),
  { timeoutMs: 120000 },
);
console.log('EXIT', restart.exitCode);
console.log('OUT', restart.stdout);
console.log('ERR', restart.stderr);

await runner.disconnect();
await prisma.$disconnect();
process.exit(restart.exitCode === 0 && /http\.version=HTTP\/1\.1/.test(restart.stdout || '') ? 0 : 1);
