/**
 * Try both ServerInstance credentials for 116.62.198.184.
 * node scripts/_tmp-m8-1a-dual-server-ssh.mjs
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
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
const { decryptCredential, resolveServerSshUsername } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');

function fp(v) {
  return createHash('sha256').update(String(v)).digest('hex').slice(0, 12);
}

const prisma = new PrismaClient();
const servers = await prisma.serverInstance.findMany({
  where: { host: '116.62.198.184' },
  orderBy: { createdAt: 'asc' },
});

const results = [];
for (const server of servers) {
  let password;
  try {
    password = decryptCredential(server.credentialEncrypted);
  } catch (error) {
    results.push({
      id: server.id,
      scope: server.scope,
      name: server.name,
      decryptOk: false,
      error: error instanceof Error ? error.message : String(error),
    });
    continue;
  }
  const username = resolveServerSshUsername({
    serverUsername: server.username,
    provider: server.provider,
    imageName: server.metadata?.imageName,
    osName: server.metadata?.osName,
  });
  const runner = new RemoteRunner();
  try {
    await runner.connect({
      host: server.host,
      port: server.port || 22,
      username,
      password,
      readyTimeoutMs: 25000,
    });
    const r = await runner.execute({ command: 'echo SSH_OK && hostname && whoami' }, { timeoutMs: 15000 });
    results.push({
      id: server.id,
      scope: server.scope,
      name: server.name,
      username,
      passwordLen: password.length,
      passwordFp: fp(password),
      ssh: 'ok',
      out: String(r.stdout || '').trim(),
    });
    await runner.disconnect();
    break;
  } catch (error) {
    results.push({
      id: server.id,
      scope: server.scope,
      name: server.name,
      username,
      passwordLen: password.length,
      passwordFp: fp(password),
      ssh: 'fail',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

console.log(JSON.stringify({ count: servers.length, results }, null, 2));
await prisma.$disconnect();
if (!results.some((r) => r.ssh === 'ok')) process.exit(1);
