import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
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

const candidates = ['127.0.0.1:15432', '172.17.0.1:15432', 'host.docker.internal:15432'];
for (const target of candidates) {
  const [host, port] = target.split(':');
  const envPath = `/tmp/pgprobe-${Date.now()}.env`;
  await runner.writeTextFile(
    envPath,
    [
      `PGHOST=${host}`,
      `PGPORT=${port}`,
      `PGUSER=${envMap.E2E_PG_USER}`,
      `PGPASSWORD=${envMap.E2E_PG_PASSWORD}`,
      `PGDATABASE=${envMap.E2E_PG_DATABASE}`,
      'PGSSLMODE=disable',
      'PGCONNECT_TIMEOUT=5',
    ].join('\n'),
    0o600,
  );
  const result = await runner.execute(
    `docker run --rm --env-file ${envPath} postgres:16-alpine psql -c "SELECT 1"`,
    { timeoutMs: 30_000 },
  );
  await runner.execute(`rm -f ${envPath}`, { timeoutMs: 5_000 });
  console.log(`${target} => exit=${result.exitCode}`);
}

await runner.disconnect();
await prisma.$disconnect();
