/**
 * Apply Pro plan member limit = 2 (local DB + Alpha via SSH).
 * node scripts/_tmp-pro-plan-two-members.mjs
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
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

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');

const SQL = readFileSync(
  join(root, 'packages/database/prisma/migrations/20261002130000_pro_plan_two_members/migration.sql'),
  'utf8',
);

function sqlStatements(sql) {
  return sql
    .split(';')
    .map((s) => s.replace(/^\s*--[^\n]*\n?/gm, '').trim())
    .filter((s) => s.length > 0);
}

async function applySql(prisma, sql) {
  for (const statement of sqlStatements(sql)) {
    await prisma.$executeRawUnsafe(statement);
  }
}

async function verify(prisma) {
  const row = await prisma.plan.findFirst({
    where: { code: 'pro' },
    include: {
      versions: { where: { effectiveTo: null }, orderBy: { version: 'desc' }, take: 1 },
    },
  });
  const limits = row?.versions[0]?.limitsJson;
  const limitsObj =
    limits && typeof limits === 'object' && !Array.isArray(limits) ? limits : {};
  console.log('VERIFY', {
    plan: row?.code,
    maxMembers: row?.maxMembers,
    limitsMaxMembers: limitsObj.maxMembers,
    limitsMaxWorkspaceMembers: limitsObj.maxWorkspaceMembers,
  });
  return row?.maxMembers === 2 && Number(limitsObj.maxWorkspaceMembers) === 2;
}

const prisma = new PrismaClient();
await applySql(prisma, SQL);
const localOk = await verify(prisma);

const server = await prisma.serverInstance.findFirst({
  where: { OR: [{ id: 'cmuma9i480001rij49yv4yw2q' }, { host: '116.62.198.184', scope: 'PLATFORM_MANAGED' }] },
});
if (!server) throw new Error('server missing');
const username = resolveServerSshUsername({ serverUsername: server.username, provider: server.provider });
const password = decryptCredential(server.credentialEncrypted);
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username,
  password,
  readyTimeoutMs: 30000,
});
const remoteSql = '/opt/launchos/tmp/pro-plan-two-members.sql';
await runner.writeTextFile(remoteSql, SQL);
const apply = await runner.execute(
  shellCommand(
    `podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < ${remoteSql}`,
  ),
  { timeoutMs: 30000 },
);
console.log('ALPHA_APPLY', apply.exitCode, (apply.stdout || '').trim(), (apply.stderr || '').trim());
const alphaVerify = await runner.execute(
  shellCommand(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT p.code || '|' || p.\\"maxMembers\\"::text || '|' || COALESCE((SELECT pv.\\"limitsJson\\"->>'maxWorkspaceMembers' FROM \\"PlanVersion\\" pv WHERE pv.\\"planId\\"=p.id ORDER BY pv.version DESC LIMIT 1), 'none') FROM \\"Plan\\" p WHERE p.code='pro' LIMIT 1"`,
  ),
  { timeoutMs: 20000 },
);
const alphaLine = String(alphaVerify.stdout || '').trim();
console.log('ALPHA_VERIFY', alphaLine);
await runner.disconnect();
await prisma.$disconnect();

const alphaPlanOk = /^pro\|2\|/.test(alphaLine);
const alphaLimitsOk = /^pro\|2\|2/.test(alphaLine) || /^pro\|2\|none/.test(alphaLine);
if (!localOk || apply.exitCode !== 0 || !alphaPlanOk) {
  process.exit(1);
}
if (!alphaLimitsOk) {
  console.warn('ALPHA_WARN PlanVersion limits not updated; UI uses Plan.maxMembers=2');
}
console.log('PRO_PLAN_MEMBERS=2');
