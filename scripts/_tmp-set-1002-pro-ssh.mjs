/**
 * Set 1002@qq.com subscription plan to pro on Alpha DB via SSH.
 * node scripts/_tmp-set-1002-pro-ssh.mjs
 */
import { createRequire } from 'node:module';
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

const TARGET_HOST = '116.62.198.184';
const EMAIL = '1002@qq.com';

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({
  where: { OR: [{ id: 'cmuma9i480001rij49yv4yw2q' }, { host: TARGET_HOST, scope: 'PLATFORM_MANAGED' }] },
});
if (!server) throw new Error('platform server missing');
const username = resolveServerSshUsername({ serverUsername: server.username, provider: server.provider });
const password = decryptCredential(server.credentialEncrypted);
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username, password, readyTimeoutMs: 30000 });

const sql = `
DO $$
DECLARE
  v_user_id text;
  v_ws_id text;
  v_pro_id text;
  v_ver_id text;
  v_sub_id text;
BEGIN
  SELECT id INTO v_user_id FROM "User" WHERE lower(email)=lower('${EMAIL}') LIMIT 1;
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'user missing'; END IF;
  SELECT "workspaceId" INTO v_ws_id FROM "WorkspaceMember" WHERE "userId"=v_user_id ORDER BY "createdAt" ASC LIMIT 1;
  IF v_ws_id IS NULL THEN RAISE EXCEPTION 'workspace missing'; END IF;
  SELECT id INTO v_pro_id FROM "Plan" WHERE lower(code)='pro' LIMIT 1;
  IF v_pro_id IS NULL THEN RAISE EXCEPTION 'pro plan missing'; END IF;
  SELECT id INTO v_ver_id FROM "PlanVersion" WHERE "planId"=v_pro_id AND "effectiveTo" IS NULL ORDER BY version DESC LIMIT 1;
  SELECT id INTO v_sub_id FROM "Subscription" WHERE "workspaceId"=v_ws_id LIMIT 1;
  IF v_sub_id IS NULL THEN RAISE EXCEPTION 'subscription missing'; END IF;
  UPDATE "Subscription"
  SET "planId"=v_pro_id,
      "planVersionId"=v_ver_id,
      "pendingPlanId"=NULL,
      "planChangeEffectiveAt"=NULL,
      status='ACTIVE',
      source='COMPLIMENTARY',
      "complimentaryReason"=COALESCE("complimentaryReason",'Admin set plan to pro'),
      "updatedAt"=NOW()
  WHERE id=v_sub_id;
END $$;
`;

const remoteSql = '/opt/launchos/tmp/set-1002-pro.sql';
await runner.writeTextFile(remoteSql, sql);
const apply = await runner.execute(
  shellCommand(
    `podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < ${remoteSql}`,
  ),
  { timeoutMs: 30000 },
);
console.log('APPLY_EXIT', apply.exitCode);
console.log('APPLY_OUT', (apply.stdout || '').slice(0, 500));
console.log('APPLY_ERR', (apply.stderr || '').slice(0, 500));
if (apply.exitCode !== 0) {
  await runner.disconnect();
  await prisma.$disconnect();
  process.exit(1);
}

const verify = await runner.execute(
  shellCommand(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email || '|' || pl.code || '|' || s.status || '|' || s.source FROM \\"User\\" u JOIN \\"WorkspaceMember\\" wm ON wm.\\"userId\\"=u.id JOIN \\"Subscription\\" s ON s.\\"workspaceId\\"=wm.\\"workspaceId\\" JOIN \\"Plan\\" pl ON pl.id=s.\\"planId\\" WHERE lower(u.email)=lower('${EMAIL}') LIMIT 1"`,
  ),
  { timeoutMs: 20000 },
);
console.log('VERIFY', String(verify.stdout || '').trim());

await runner.disconnect();
await prisma.$disconnect();
if (!/\\|pro\\|/i.test(String(verify.stdout || '')) && !/\|pro\|/i.test(String(verify.stdout || ''))) {
  process.exit(1);
}
console.log('PLAN_SET=pro');
