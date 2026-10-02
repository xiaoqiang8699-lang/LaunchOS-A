/**
 * Quick SSH auth probe — no secrets printed.
 * node scripts/_tmp-m8-1a-ssh-probe.mjs
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of [resolve(root, '.env'), resolve(root, '.secrets/alpha-data-plane.env')]) {
  if (!existsSync(file)) {
    console.log('missing', file);
    continue;
  }
  console.log('loaded', file);
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

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({
  where: { OR: [{ id: 'cmuma9i480001rij49yv4yw2q' }, { host: '116.62.198.184' }] },
});
if (!server) throw new Error('server missing');

const username = resolveServerSshUsername({ serverUsername: server.username, provider: server.provider });
let passwordOk = false;
let passwordLen = 0;
try {
  const password = decryptCredential(server.credentialEncrypted);
  passwordOk = typeof password === 'string' && password.length > 0;
  passwordLen = password.length;
} catch (error) {
  console.log(JSON.stringify({ decryptOk: false, error: error instanceof Error ? error.message : String(error) }));
  await prisma.$disconnect();
  process.exit(1);
}

console.log(
  JSON.stringify({
    host: server.host,
    port: server.port,
    username,
    provider: server.provider,
    passwordOk,
    passwordLen,
    jwtPresent: Boolean(process.env.JWT_SECRET),
    jwtFp: process.env.JWT_SECRET
      ? createHash('sha256').update(process.env.JWT_SECRET).digest('hex').slice(0, 8)
      : null,
  }),
);

const runner = new RemoteRunner();
try {
  await runner.connect({
    host: server.host,
    port: server.port,
    username,
    password: decryptCredential(server.credentialEncrypted),
    readyTimeoutMs: 30000,
  });
  const r = await runner.execute({ command: 'echo SSH_OK && hostname' }, { timeoutMs: 15000 });
  console.log(JSON.stringify({ ssh: 'ok', exitCode: r.exitCode, stdout: String(r.stdout || '').trim().slice(0, 200) }));
  await runner.disconnect();
} catch (error) {
  console.log(JSON.stringify({ ssh: 'fail', error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
await prisma.$disconnect();
