/**
 * Provision independent E2E Redis containers on the remote server.
 * Must NOT reuse LaunchOS BullMQ Redis.
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const { PrismaClient } = require(resolve(ROOT, 'packages/database/generated/client'));
const { decryptCredential } = require(resolve(ROOT, 'packages/shared/dist/index.js'));
const { RemoteRunner } = require(resolve(ROOT, 'packages/remote-runner/dist/index.js'));

const SERVER_ID = process.env.E2E_SERVER_ID || 'cmu22cqo80007ri6wkt4krfsq';
const password = process.env.E2E_REDIS_PASSWORD || `R@d1s:${randomBytes(4).toString('hex')}#%`;
const publicPort = Number(process.env.E2E_REMOTE_REDIS_PORT || 16379);
const loopPort = Number(process.env.E2E_LOOPBACK_REDIS_PORT || 26379);

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findUnique({ where: { id: SERVER_ID } });
if (!server) throw new Error('server missing');
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: server.username,
  password: decryptCredential(server.credentialEncrypted),
});

async function startRedis(name, publish) {
  await runner.execute(`docker rm -f ${name} >/dev/null 2>&1 || true`, { timeoutMs: 30_000 });
  const envPath = `/tmp/${name}.env`;
  await runner.writeTextFile(envPath, `REDIS_PASSWORD=${password}`, 0o600);
  const cmd = [
    `docker run -d --name ${name}`,
    `--env-file ${envPath}`,
    `-p ${publish}`,
    'redis:7-alpine',
    'sh -c',
    `'redis-server --requirepass "$REDIS_PASSWORD" --save "" --appendonly no'`,
  ].join(' ');
  const started = await runner.execute(cmd, { timeoutMs: 120_000 });
  await runner.execute(`rm -f ${envPath}`, { timeoutMs: 5_000 });
  if (started.exitCode !== 0) {
    throw new Error(`failed to start ${name}`);
  }
  for (let i = 0; i < 30; i++) {
    const probeEnv = `/tmp/${name}-probe.env`;
    await runner.writeTextFile(probeEnv, `REDISCLI_AUTH=${password}`, 0o600);
    const ready = await runner.execute(
      `docker run --rm --network host --env-file ${probeEnv} redis:7-alpine redis-cli -h 127.0.0.1 -p ${publish.split(':').pop()?.split('-')[0] || '6379'} PING`,
      { timeoutMs: 15_000 },
    );
    await runner.execute(`rm -f ${probeEnv}`, { timeoutMs: 5_000 });
    if (ready.exitCode === 0 && /PONG/i.test(ready.stdout)) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

await startRedis('launchos-step252-redis', `0.0.0.0:${publicPort}:6379`);
await startRedis('launchos-step252-redis-loop', `127.0.0.1:${loopPort}:6379`);

// no-auth redis for control-plane local tests can be separate; also start one public noauth on 16380 for optional
await runner.execute('docker rm -f launchos-step252-redis-noauth >/dev/null 2>&1 || true', {
  timeoutMs: 30_000,
});
await runner.execute(
  `docker run -d --name launchos-step252-redis-noauth -p 127.0.0.1:26380:6379 redis:7-alpine redis-server --save "" --appendonly no`,
  { timeoutMs: 60_000 },
);

await runner.disconnect();
await prisma.$disconnect();

const outPath = resolve(ROOT, '.tools/step252-e2e.remote.env');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  [
    `E2E_REDIS_HOST=host.docker.internal`,
    `E2E_REDIS_PORT=${publicPort}`,
    `E2E_REDIS_PASSWORD=${password}`,
    `E2E_REDIS_PASSWORD_SPECIAL=${password}`,
    `E2E_LOOPBACK_REDIS_HOST=127.0.0.1`,
    `E2E_LOOPBACK_REDIS_PORT=${loopPort}`,
    `E2E_NOAUTH_REDIS_HOST=127.0.0.1`,
    `E2E_NOAUTH_REDIS_PORT=26380`,
  ].join('\n') + '\n',
  { mode: 0o600 },
);
console.log(`remote-redis-ready port=${publicPort} loop=${loopPort}`);
