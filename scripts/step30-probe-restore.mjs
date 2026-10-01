/**
 * Diagnose Step 30 restore / table presence (no secrets printed).
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(resolve(root, '.env'), 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i <= 0) continue;
  const k = t.slice(0, i).trim();
  let v = t.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (process.env[k] === undefined) process.env[k] = v;
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');

const PG_NAME = 'launchos-alpha-postgres';
const PG_USER = 'launchos_alpha';
const PG_DB = 'launchos';

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: '116.62.198.184' } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});

async function run(label, cmd) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs: 120000 });
  console.log(`\n=== ${label} exit=${r.exitCode} ===`);
  const out = String(r.stdout || '').trim();
  const err = String(r.stderr || '').trim();
  if (out) console.log(out.slice(0, 4000));
  if (err) console.log('STDERR:', err.slice(0, 2000));
  return r;
}

await run('containers', `podman ps -a --format '{{.Names}} {{.Status}} {{.Ports}}'`);
await run('dumps', `ls -lah /opt/launchos/backups/postgres/ | head -n 30`);
await run('dbs', `podman exec ${PG_NAME} psql -U ${PG_USER} -d postgres -Atc "SELECT datname FROM pg_database ORDER BY 1;"`);
await run(
  'tables',
  `podman exec ${PG_NAME} psql -U ${PG_USER} -d ${PG_DB} -Atc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public';"`,
);
await run(
  'mig',
  `podman exec ${PG_NAME} psql -U ${PG_USER} -d ${PG_DB} -Atc "SELECT COUNT(*) FROM information_schema.tables WHERE table_name='_prisma_migrations';"`,
);
await run(
  'list_tables',
  `podman exec ${PG_NAME} psql -U ${PG_USER} -d ${PG_DB} -Atc "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1 LIMIT 40;"`,
);
await run(
  'pg_restore_list',
  `DUMP=$(ls -1t /opt/launchos/backups/postgres/migration-*.dump 2>/dev/null | head -n1); echo DUMP=$DUMP; podman cp "$DUMP" ${PG_NAME}:/tmp/probe.dump; podman exec ${PG_NAME} pg_restore -l /tmp/probe.dump | head -n 40; podman exec ${PG_NAME} rm -f /tmp/probe.dump`,
);

await runner.disconnect();
await prisma.$disconnect();
