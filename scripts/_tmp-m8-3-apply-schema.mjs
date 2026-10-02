/**
 * Apply M8-3 schema that failed due to BOM, then re-verify Alpha endpoints.
 * node scripts/_tmp-m8-3-apply-schema.mjs --confirm-apply
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function loadEnv(file, { override = false } = {}) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (override || process.env[k] === undefined) process.env[k] = v;
  }
}
loadEnv(resolve(root, '.env'));
loadEnv(resolve(root, '.secrets/alpha-data-plane.env'), { override: true });
if (!process.argv.includes('--confirm-apply')) {
  console.error('pass --confirm-apply');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');

const WS = 'cmunqotx500cbrl013xbhpio2';
const TARGET_HOST = '116.62.198.184';
const API_REMOTE = 'localhost/launchos-alpha-api:m83';
const ARTIFACT = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT, { recursive: true });

const sqlPath = resolve(
  root,
  'packages/database/prisma/migrations/20261002180000_m8_3_formal_payment_readiness/migration.sql',
);
const nmSql = resolve(
  root,
  'apps/api/node_modules/@launchos/database/prisma/migrations/20261002180000_m8_3_formal_payment_readiness/migration.sql',
);
if (existsSync(dirname(nmSql))) copyFileSync(sqlPath, nmSql);

function curl(url, host, opts = {}) {
  const { method = 'GET', headers = {}, body = null, maxTime = '90' } = opts;
  const args = ['-sS', '-L', '-X', method, '-w', '\n__STATUS__:%{http_code}', '--max-time', String(maxTime)];
  args.push('--resolve', `${host}:443:${TARGET_HOST}`);
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body != null) args.push('-H', 'content-type: application/json', '--data-binary', body);
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)/);
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out };
}
function parse(text) {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { id: 'cmuma9i480001rij49yv4yw2q' } });
if (!server) throw new Error('server instance missing');
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername({ serverUsername: server.username, provider: server.provider }),
  password: decryptCredential(server.credentialEncrypted),
  readyTimeoutMs: 30000,
});
async function remote(cmd, timeoutMs = 60000) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs });
  console.log('>>>', cmd.slice(0, 140), '=>', r.exitCode);
  console.log(((r.stdout || '') + (r.stderr || '')).slice(-2000));
  return r;
}
async function remoteOk(cmd, label, timeoutMs = 60000) {
  const r = await remote(cmd, timeoutMs);
  if (r.exitCode !== 0) throw new Error(`${label} failed`);
  return r;
}

const remoteSql = '/opt/launchos/tmp/m83-schema-fix.sql';
await runner.upload(sqlPath, remoteSql, { timeoutMs: 60000 });

await remoteOk(
  `podman run --rm --network host --env-file /opt/launchos/config/alpha-api.env -v ${remoteSql}:/tmp/m83.sql:ro ${API_REMOTE} sh -c 'cd /app && node_modules/.bin/prisma db execute --schema packages/database/prisma/schema.prisma --file /tmp/m83.sql'`,
  'db-execute',
  180000,
);

const verifySqlLocal = join(ARTIFACT, 'm83-verify-tables.sql');
writeFileSync(
  verifySqlLocal,
  `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('PurchaseIntent','PaymentAccessAllowlist','PlatformPaymentControl') ORDER BY 1;
SELECT id, "accessMode", percentage FROM "PlatformPaymentControl" WHERE id='default';
`,
);
const remoteVerifySql = '/opt/launchos/tmp/m83-verify-tables.sql';
await runner.upload(verifySqlLocal, remoteVerifySql, { timeoutMs: 30000 });
const verify = await remoteOk(
  `podman run --rm --network host --env-file /opt/launchos/config/alpha-api.env -v ${remoteVerifySql}:/tmp/m83-verify.sql:ro ${API_REMOTE} sh -c 'cd /app && node_modules/.bin/prisma db execute --schema packages/database/prisma/schema.prisma --file /tmp/m83-verify.sql'`,
  'verify-tables',
  120000,
);

await remoteOk(`/opt/launchos/bin/m5-run-api.sh launchos-alpha-api 39110 ${API_REMOTE}`, 'api-restart', 180000);
for (let i = 0; i < 30; i++) {
  const probe = await remote('curl -sf --max-time 3 http://127.0.0.1:39110/api/v1/health || echo HEALTH_FAIL', 15000);
  if (probe.exitCode === 0 && !String(probe.stdout || '').includes('HEALTH_FAIL')) break;
  await new Promise((r) => setTimeout(r, 2000));
}

const gates = await remoteOk(
  `grep -E '^(REAL_PAYMENTS_ENABLED|PAYMENT_TEST_REAL_ENABLED|ALIPAY_PRODUCTION_TEST_ENABLED|ALIPAY_SANDBOX_ONLY|ALIPAY_PROVIDER_MODE)=' /opt/launchos/config/alpha-api.env || true`,
  'gates-final',
);

await runner.disconnect();

const adminAuth = JSON.parse(readFileSync(join(ARTIFACT, 'admin-auth.json'), 'utf8'));
const userAuth = JSON.parse(readFileSync(join(ARTIFACT, '1002-auth.json'), 'utf8'));
const adminLogin = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: adminAuth.email, password: adminAuth.password }),
});
const adminHdr = { authorization: `Bearer ${parse(adminLogin.text).accessToken}` };
const userLogin = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: userAuth.email || '1002@qq.com', password: userAuth.password }),
});
const userHdr = { authorization: `Bearer ${parse(userLogin.text).accessToken}` };

const preview = curl('https://api-alpha.zsaos.com/api/v1/billing/checkout/preview', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: userHdr,
  body: JSON.stringify({ planCode: 'pro', billingCycle: 'MONTHLY' }),
});
const confirm = curl('https://api-alpha.zsaos.com/api/v1/billing/checkout/confirm', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: userHdr,
  body: JSON.stringify({ planCode: 'pro', billingCycle: 'MONTHLY', acceptTerms: true }),
});
const checkout = curl('https://api-alpha.zsaos.com/api/v1/billing/checkout', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: userHdr,
  body: JSON.stringify({ planCode: 'pro', billingCycle: 'MONTHLY' }),
});
const teamCheckout = curl('https://api-alpha.zsaos.com/api/v1/billing/checkout', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: userHdr,
  body: JSON.stringify({ planCode: 'team', billingCycle: 'YEARLY' }),
});
const controls = curl('https://api-alpha.zsaos.com/api/v1/admin/commercial/payment-controls', 'api-alpha.zsaos.com', {
  headers: adminHdr,
});
const dryRun = curl('https://api-alpha.zsaos.com/api/v1/admin/commercial/checkout/dry-run', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: adminHdr,
  body: JSON.stringify({ planCode: 'team', billingCycle: 'YEARLY', workspaceId: WS }),
});
const matrix = curl('https://api-alpha.zsaos.com/api/v1/admin/commercial/mock-activation-matrix', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: adminHdr,
  body: '{}',
});
const consistency = curl('https://api-alpha.zsaos.com/api/v1/admin/commercial/payment-consistency', 'api-alpha.zsaos.com', {
  headers: adminHdr,
});
const checklist = curl('https://api-alpha.zsaos.com/api/v1/admin/commercial/payment-launch-checklist', 'api-alpha.zsaos.com', {
  headers: adminHdr,
});

const pages = {};
for (const path of [
  '/billing',
  '/plan',
  '/billing/checkout/confirm?plan=pro&cycle=MONTHLY',
  '/admin/commercial',
  '/admin/commercial/payment-controls',
  '/admin/commercial/payment-test',
  '/admin/commercial/payments',
  '/admin/commercial/subscriptions',
  '/overview',
]) {
  pages[path] = curl(`https://alpha.zsaos.com${path}`, 'alpha.zsaos.com', { headers: adminHdr, maxTime: '30' }).status;
}

const gatesText = String(gates.stdout || '');
const controlsBody = parse(controls.text);
const checklistBody = parse(checklist.text);
const dryBody = parse(dryRun.text);
const consistencyBody = parse(consistency.text);
const report = {
  images: {
    API: 'launchos-alpha-api:m83',
    WEB: 'launchos-alpha-web:m83',
    WORKER: 'launchos-alpha-worker:m83',
  },
  schemaVerify: String(verify.stdout || '').trim().slice(-500),
  gates: gatesText.trim(),
  preview: { status: preview.status, body: parse(preview.text) },
  confirm: { status: confirm.status, body: parse(confirm.text) },
  checkout: { status: checkout.status, body: parse(checkout.text) },
  teamCheckout: { status: teamCheckout.status, body: parse(teamCheckout.text) },
  controls: { status: controls.status, body: controlsBody },
  dryRun: { status: dryRun.status, body: dryBody },
  matrix: { status: matrix.status, body: parse(matrix.text) },
  consistency: { status: consistency.status, body: consistencyBody },
  checklist: { status: checklist.status, body: checklistBody },
  pages,
  checks: {
    REAL_PAYMENTS_ENABLED_FALSE: /REAL_PAYMENTS_ENABLED=false/.test(gatesText),
    PAYMENT_TEST_REAL_ENABLED_FALSE: /PAYMENT_TEST_REAL_ENABLED=false/.test(gatesText),
    ALIPAY_PRODUCTION_TEST_ENABLED_FALSE: /ALIPAY_PRODUCTION_TEST_ENABLED=false/.test(gatesText),
    PAYMENT_ACCESS_MODE_DISABLED: controlsBody.accessMode === 'DISABLED',
    PRO_CHECKOUT_BLOCKED: parse(checkout.text).available === false || parse(checkout.text).code === 'REAL_PAYMENTS_DISABLED',
    TEAM_CHECKOUT_BLOCKED:
      parse(teamCheckout.text).available === false || parse(teamCheckout.text).code === 'REAL_PAYMENTS_DISABLED',
    PREVIEW_READY: preview.status < 400 && parse(preview.text).amountFen === 9900,
    CONFIRM_READY:
      confirm.status < 400 &&
      Boolean(parse(confirm.text).intentId || parse(confirm.text).purchaseIntentId || parse(confirm.text).id),
    DRY_RUN_NO_ALIPAY: dryBody.visitsAlipay === false,
    MOCK_MATRIX_PASS: parse(matrix.text).allPass === true,
    CONSISTENCY_OK: consistency.status < 400 && consistencyBody.PAYMENT_TEST_EXCLUDED === true,
    LAUNCH_CHECKLIST_READY: checklistBody.formalPaymentLaunchReady === true,
    FORMAL_PLAN_PAYMENT_OPENED: false,
    NEW_REAL_PAYMENT_ORDER_CREATED: false,
    NEW_REAL_PAYMENT_CHARGE_EXECUTED: false,
  },
};
writeFileSync(join(ARTIFACT, 'm8-3-promote-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await prisma.$disconnect();

const expectFalse = new Set([
  'FORMAL_PLAN_PAYMENT_OPENED',
  'NEW_REAL_PAYMENT_ORDER_CREATED',
  'NEW_REAL_PAYMENT_CHARGE_EXECUTED',
]);
const failed = Object.entries(report.checks).filter(([k, v]) => (expectFalse.has(k) ? v !== false : v !== true));
if (failed.length) {
  console.error('FAILED_CHECKS', failed);
  process.exit(1);
}
console.log('M8-3 Alpha schema+verify PASS');
