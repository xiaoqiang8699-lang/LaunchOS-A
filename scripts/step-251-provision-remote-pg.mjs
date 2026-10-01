/**
 * Provision a disposable Postgres on the remote E2E server (localhost-only + optional public port).
 * Does not print passwords.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const { PrismaClient } = require(resolve(ROOT, 'packages/database/generated/client'));
const { decryptCredential } = require(resolve(ROOT, 'packages/shared/dist/index.js'));
const { RemoteRunner } = require(resolve(ROOT, 'packages/remote-runner/dist/index.js'));

const SERVER_ID = process.env.E2E_SERVER_ID || 'cmu22cqo80007ri6wkt4krfsq';
const envPath = resolve(ROOT, '.tools/step251-e2e.env');
const envMap = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf('=');
      return [line.slice(0, i), line.slice(i + 1)];
    }),
);

const password = envMap.E2E_PG_PASSWORD_SPECIAL || envMap.E2E_PG_PASSWORD;
const db = envMap.E2E_PG_DATABASE || 'launchos_step251';
const user = envMap.E2E_PG_USER || 'launchos_step251';
const publicPort = Number(process.env.E2E_REMOTE_PG_PORT || 15432);

async function main() {
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

  const name = 'launchos-step251-pg';
  await runner.execute(`docker rm -f ${name} >/dev/null 2>&1 || true`, { timeoutMs: 30_000 });
  const envFile = `/tmp/launchos-step251-pg.env`;
  await runner.writeTextFile(
    envFile,
    [`POSTGRES_USER=${user}`, `POSTGRES_PASSWORD=${password}`, `POSTGRES_DB=${db}`].join('\n'),
    0o600,
  );
  const run = [
    `docker run -d --name ${name}`,
    `--env-file ${envFile}`,
    `-p 0.0.0.0:${publicPort}:5432`,
    'postgres:16-alpine',
  ].join(' ');
  const started = await runner.execute(run, { timeoutMs: 120_000 });
  await runner.execute(`rm -f ${envFile}`, { timeoutMs: 5_000 });
  if (started.exitCode !== 0) {
    throw new Error('failed to start remote postgres');
  }
  // wait ready
  for (let i = 0; i < 30; i++) {
    const ready = await runner.execute(
      `docker exec ${name} pg_isready -U ${user} -d ${db}`,
      { timeoutMs: 10_000 },
    );
    if (ready.exitCode === 0) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  await runner.disconnect();
  await prisma.$disconnect();

  const out = [
    `E2E_PG_HOST=${server.host}`,
    `E2E_PG_PORT=${publicPort}`,
    `E2E_PG_DATABASE=${db}`,
    `E2E_PG_USER=${user}`,
    `E2E_PG_PASSWORD=${password}`,
    `E2E_PG_PASSWORD_SPECIAL=${password}`,
    `E2E_REMOTE_PG_LOOPBACK_HOST=127.0.0.1`,
    `E2E_REMOTE_PG_LOOPBACK_PORT=5432`,
  ].join('\n');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(resolve(ROOT, '.tools/step251-e2e.remote.env'), out, { mode: 0o600 });
  console.log(`remote-pg-ready host=${server.host} port=${publicPort}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
