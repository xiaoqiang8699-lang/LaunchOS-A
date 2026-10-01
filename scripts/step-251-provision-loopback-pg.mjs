import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('../packages/database/generated/client');
const { decryptCredential } = require('../packages/shared/dist/index.js');
const { RemoteRunner } = require('../packages/remote-runner/dist/index.js');

const envMap = Object.fromEntries(
  readFileSync(resolve('../.tools/step251-e2e.remote.env'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf('=');
      return [line.slice(0, i), line.slice(i + 1)];
    }),
);

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findUnique({
  where: { id: 'cmu22cqo80007ri6wkt4krfsq' },
});
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: server.username,
  password: decryptCredential(server.credentialEncrypted),
});
const name = 'launchos-step251-pg-loop';
await runner.execute(`docker rm -f ${name} >/dev/null 2>&1 || true`, { timeoutMs: 30_000 });
const envFile = '/tmp/launchos-step251-pg-loop.env';
await runner.writeTextFile(
  envFile,
  [
    `POSTGRES_USER=${envMap.E2E_PG_USER}`,
    `POSTGRES_PASSWORD=${envMap.E2E_PG_PASSWORD}`,
    `POSTGRES_DB=${envMap.E2E_PG_DATABASE}`,
  ].join('\n'),
  0o600,
);
const started = await runner.execute(
  [
    `docker run -d --name ${name}`,
    `--env-file ${envFile}`,
    '-p 127.0.0.1:25432:5432',
    'postgres:16-alpine',
  ].join(' '),
  { timeoutMs: 120_000 },
);
await runner.execute(`rm -f ${envFile}`, { timeoutMs: 5_000 });
if (started.exitCode !== 0) {
  throw new Error('loopback pg failed');
}
for (let i = 0; i < 30; i++) {
  const ready = await runner.execute(
    `docker exec ${name} pg_isready -U ${envMap.E2E_PG_USER}`,
    { timeoutMs: 10_000 },
  );
  if (ready.exitCode === 0) break;
  await new Promise((r) => setTimeout(r, 2000));
}
await runner.disconnect();
await prisma.$disconnect();
writeFileSync(
  resolve('../.tools/step251-e2e.remote.env'),
  `${readFileSync(resolve('../.tools/step251-e2e.remote.env'), 'utf8').trim()}
E2E_LOOPBACK_PG_HOST=127.0.0.1
E2E_LOOPBACK_PG_PORT=25432
`,
);
console.log('loopback-pg-ready');
