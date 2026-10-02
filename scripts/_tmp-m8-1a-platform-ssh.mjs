/**
 * SSH with PLATFORM_MANAGED server credential only.
 * node scripts/_tmp-m8-1a-platform-ssh.mjs
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
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({
  where: { id: 'cmuma9i480001rij49yv4yw2q' },
});
if (!server) throw new Error('platform server missing');
const password = decryptCredential(server.credentialEncrypted);
const username = resolveServerSshUsername({
  serverUsername: server.username,
  provider: server.provider,
});

console.log(
  JSON.stringify({
    id: server.id,
    scope: server.scope,
    host: server.host,
    username,
    passwordLen: password.length,
    passwordFp: createHash('sha256').update(password).digest('hex').slice(0, 12),
  }),
);

const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port || 22,
  username,
  password,
  readyTimeoutMs: 30000,
});
const r = await runner.execute(shellCommand('echo SSH_OK && hostname && whoami && date -Is'), {
  timeoutMs: 20000,
});
console.log(JSON.stringify({ exitCode: r.exitCode, stdout: String(r.stdout || '').trim(), stderr: String(r.stderr || '').trim().slice(0, 200) }));
await runner.disconnect();
await prisma.$disconnect();
if (r.exitCode !== 0) process.exit(1);
console.log('SSH_OK=true');
