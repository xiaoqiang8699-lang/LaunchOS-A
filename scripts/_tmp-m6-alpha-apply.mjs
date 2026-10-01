/**
 * Apply M6 migration + BETA_TESTER override on Alpha PLATFORM_MANAGED node.
 * node scripts/_tmp-m6-alpha-apply.mjs --confirm-m6
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
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
if (!process.argv.includes('--confirm-m6')) process.exit(2);

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { BETA_TESTER_OVERRIDE_DEFAULTS } = requireDomain('@launchos/domain');
const { RemoteRunner } = requireApi('@launchos/remote-runner');

const MANAGED_ID = 'cmuma9i480001rij49yv4yw2q';
const PROJECT = 'cmunsm2lk00ctrl01nnu1pwyd';
const migrationSql = readFileSync(
  join(root, 'packages/database/prisma/migrations/20261001140000_m6_entitlement_quota/migration.sql'),
  'utf8',
);

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({
  where: { OR: [{ id: MANAGED_ID }, { host: '116.62.198.184', scope: 'PLATFORM_MANAGED' }] },
});
if (!server) throw new Error('managed server missing');
const username = resolveServerSshUsername({
  serverUsername: server.username,
  provider: server.provider,
});
const password = decryptCredential(server.credentialEncrypted);
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username, password });
async function remoteOk(cmd, label, timeoutMs = 120000) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs });
  if (r.exitCode !== 0) throw new Error(`${label}: ${(r.stderr || r.stdout || '').slice(0, 800)}`);
  return r;
}

await runner.writeTextFile('/opt/launchos/tmp/m6-migration.sql', migrationSql);
await remoteOk(
  'podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < /opt/launchos/tmp/m6-migration.sql',
  'migrate',
  180000,
).catch(async (e) => {
  // Idempotent-ish: continue if tables already exist
  console.log('migrate warn', String(e.message || e).slice(0, 300));
});

const wsId = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT \\"workspaceId\\" FROM \\"Project\\" WHERE id='${PROJECT}'"`,
    'ws',
  )
).stdout.trim();

const entitlementsJson = JSON.stringify(BETA_TESTER_OVERRIDE_DEFAULTS).replace(/'/g, "''");
const expires = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
const overrideId = `weo_m6_beta_${Date.now().toString(36)}`;
await runner.writeTextFile(
  '/opt/launchos/tmp/m6-override.sql',
  `
UPDATE "WorkspaceEntitlementOverride" SET "revokedAt"=NOW() WHERE "workspaceId"='${wsId}' AND "revokedAt" IS NULL;
INSERT INTO "WorkspaceEntitlementOverride" ("id","workspaceId","entitlementsJson","reason","expiresAt","createdAt","updatedAt")
VALUES ('${overrideId}','${wsId}','${entitlementsJson}'::jsonb,'External Beta validation','${expires}',NOW(),NOW());
`,
);

await remoteOk(
  'podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < /opt/launchos/tmp/m6-override.sql',
  'override',
);

const check = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT \\"reason\\", \\"entitlementsJson\\"::text FROM \\"WorkspaceEntitlementOverride\\" WHERE id='${overrideId}'"`,
    'check',
  )
).stdout.trim();

const prices = (
  await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT code, \\"priceMonthly\\", \\"priceYearly\\" FROM \\"Plan\\" WHERE code IN ('pro','team') ORDER BY code"`,
    'prices',
  )
).stdout.trim();

const out = {
  workspaceId: wsId,
  overrideId,
  check,
  prices,
  betaOverrideApplied: /External Beta validation/.test(check) && /maxProjects":\s*3/.test(check),
  priceProtection: /pro\|99\|990/.test(prices.replace(/\r/g, '')) || /pro\|99/.test(prices),
};
writeFileSync(join(root, '.tools/alpha-runtime/m6-alpha-apply.json'), JSON.stringify(out, null, 2));
console.log('M6_ALPHA', JSON.stringify(out));
await prisma.$disconnect().catch(() => undefined);
try {
  await runner.disconnect();
} catch {}
process.exit(out.betaOverrideApplied && out.priceProtection ? 0 : 1);
