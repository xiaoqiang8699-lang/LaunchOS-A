/**
 * M8-1A final verification — inspect latest PAYMENT_TEST order (no secrets, no new checkout).
 * node scripts/_tmp-m8-1a-final-verify.mjs [--close-gate]
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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

const closeGate = process.argv.includes('--close-gate');
const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');

const WS = 'cmunqotx500cbrl013xbhpio2';
const TARGET_HOST = '116.62.198.184';
const ARTIFACT = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT, { recursive: true });
const adminAuth = JSON.parse(readFileSync(join(ARTIFACT, 'admin-auth.json'), 'utf8'));
const userAuth = JSON.parse(readFileSync(join(ARTIFACT, '1002-auth.json'), 'utf8'));

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
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername({ serverUsername: server.username, provider: server.provider }),
  password: decryptCredential(server.credentialEncrypted),
  readyTimeoutMs: 30000,
});

async function remoteOk(cmd, label, timeoutMs = 60000) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs });
  if (r.exitCode !== 0) throw new Error(`${label}: ${(r.stderr || r.stdout || '').slice(0, 2000)}`);
  return r;
}

const paymentsSql = `
SELECT p.id
 || '|' || p.status
 || '|' || COALESCE(p."merchantOrderNo",'')
 || '|' || CASE WHEN COALESCE(p."providerTradeNo",'')<>'' THEN '1' ELSE '0' END
 || '|' || COALESCE(p."amountCents"::text,'')
 || '|' || p."createdAt"::text
 || '|' || COALESCE(p."paidAt"::text,'')
 || '|' || COALESCE(p.environment,'')
 || '|' || COALESCE(p."isProductionTest"::text,'')
 || '|' || COALESCE(p."lastQueryState",'')
 || '|' || COALESCE(p."failureCode",'')
 || '|' || o.id
 || '|' || o.status
 || '|' || COALESCE(o."orderNumber",'')
 || '|' || COALESCE(pl.code,'')
 || '|' || COALESCE(o."fulfilledAt"::text,'')
FROM "Payment" p
JOIN "CommercialOrder" o ON o.id=p."orderId"
JOIN "Plan" pl ON pl.id=o."planId"
WHERE o."workspaceId"='${WS}'
  AND (pl.code='PAYMENT_TEST' OR p."isProductionTest"=true)
ORDER BY p."createdAt" DESC
LIMIT 10
`.replace(/\n/g, ' ');

const payments = await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc ${JSON.stringify(paymentsSql)}`,
  'payments',
  20000,
);

const webhookSql = `
SELECT e.id
 || '|' || COALESCE(e.status,'')
 || '|' || COALESCE(e."eventType",'')
 || '|' || COALESCE(e."externalEventId",'')
 || '|' || e."receivedAt"::text
 || '|' || COALESCE(e."processedAt"::text,'')
 || '|' || COALESCE(e."paymentId",'')
 || '|' || COALESCE(e."errorCode",'')
FROM "PaymentWebhookEvent" e
WHERE e.provider='ALIPAY'
ORDER BY e."receivedAt" DESC
LIMIT 20
`.replace(/\n/g, ' ');

let webhooks = { stdout: '' };
try {
  webhooks = await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc ${JSON.stringify(webhookSql)}`,
    'webhooks',
    20000,
  );
} catch (error) {
  webhooks = { stdout: `WEBHOOK_QUERY_FAILED:${error instanceof Error ? error.message : String(error)}` };
}

const auditSql = `
SELECT a."action"
 || '|' || a."createdAt"::text
 || '|' || COALESCE(a."userId",'')
 || '|' || COALESCE(a."workspaceId",'')
FROM "AuditLog" a
WHERE a."workspaceId"='${WS}'
  AND (
    a."action" ILIKE '%PAYMENT%'
    OR a."action" ILIKE '%ALIPAY%'
    OR a."action" ILIKE '%FULFILL%'
    OR a."action" ILIKE '%ORDER%'
  )
ORDER BY a."createdAt" DESC
LIMIT 50
`.replace(/\n/g, ' ');

let audits = { stdout: '' };
try {
  audits = await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc ${JSON.stringify(auditSql)}`,
    'audits',
    20000,
  );
} catch (error) {
  audits = { stdout: `AUDIT_QUERY_FAILED:${error instanceof Error ? error.message : String(error)}` };
}

const planSql = `
SELECT code || '|' || COALESCE("priceMonthly"::text,'') || '|' || COALESCE("priceYearly"::text,'') || '|' || COALESCE("priceMonthlyCents"::text,'') || '|' || status
FROM "Plan"
WHERE code IN ('free','pro','team','PAYMENT_TEST')
ORDER BY code
`.replace(/\n/g, ' ');
const plans = await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc ${JSON.stringify(planSql)}`,
  'plans',
  15000,
);

const subSql = `
SELECT s.id || '|' || COALESCE(s.status,'') || '|' || COALESCE(pl.code,'') || '|' || s."updatedAt"::text
FROM "WorkspaceSubscription" s
JOIN "Plan" pl ON pl.id=s."planId"
WHERE s."workspaceId"='${WS}'
ORDER BY s."updatedAt" DESC
LIMIT 5
`.replace(/\n/g, ' ');
let subs = { stdout: '' };
try {
  subs = await remoteOk(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc ${JSON.stringify(subSql)}`,
    'subs',
    15000,
  );
} catch (error) {
  // schema may differ
  const alt = `
SELECT s.id || '|' || COALESCE(s.status,'') || '|' || COALESCE(s."planCode",'') || '|' || s."updatedAt"::text
FROM "Subscription" s
WHERE s."workspaceId"='${WS}'
ORDER BY s."updatedAt" DESC
LIMIT 5
`.replace(/\n/g, ' ');
  try {
    subs = await remoteOk(
      `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc ${JSON.stringify(alt)}`,
      'subs-alt',
      15000,
    );
  } catch (e2) {
    subs = { stdout: `SUB_QUERY_FAILED:${e2 instanceof Error ? e2.message : String(e2)}` };
  }
}

const gatesBefore = await remoteOk(
  `grep -E '^(REAL_PAYMENTS_ENABLED|PAYMENT_TEST_REAL_ENABLED|ALIPAY_PRODUCTION_TEST_ENABLED|ALIPAY_PRODUCTION_ENABLED|ALIPAY_SANDBOX_ONLY|ALIPAY_PRODUCTION_TEST_WORKSPACE_ID)=' /opt/launchos/config/alpha-api.env || true`,
  'gates-before',
  15000,
);

await runner.disconnect();

const paymentLines = String(payments.stdout || '')
  .trim()
  .split(/\r?\n/)
  .filter(Boolean);
const latest = paymentLines[0] ? paymentLines[0].split('|') : null;

const adminLogin = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: adminAuth.email, password: adminAuth.password }),
});
const adminToken = parse(adminLogin.text).accessToken;
if (!adminToken) throw new Error('admin login failed: ' + adminLogin.text.slice(0, 300));
const adminHdr = { authorization: `Bearer ${adminToken}` };

const userLogin = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: userAuth.email || '1002@qq.com', password: userAuth.password }),
});
const userToken = parse(userLogin.text).accessToken;
const userHdr = { authorization: `Bearer ${userToken}` };

// Trigger reconcile (no new order)
const reconcile = curl('https://api-alpha.zsaos.com/api/v1/admin/payments/reconcile', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: adminHdr,
  body: '{}',
  maxTime: '120',
});

const paymentDetail = latest?.[0]
  ? curl(`https://api-alpha.zsaos.com/api/v1/admin/payments/${latest[0]}`, 'api-alpha.zsaos.com', { headers: adminHdr })
  : { status: 0, text: '{}' };

const paymentTestStatus = curl('https://api-alpha.zsaos.com/api/v1/admin/commercial/payment-test', 'api-alpha.zsaos.com', {
  headers: adminHdr,
  maxTime: '120',
});

const checkoutPro = curl('https://api-alpha.zsaos.com/api/v1/billing/checkout', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: userHdr,
  body: JSON.stringify({ planCode: 'pro', billingCycle: 'MONTHLY' }),
});

const billing = curl('https://api-alpha.zsaos.com/api/v1/account/billing', 'api-alpha.zsaos.com', { headers: userHdr });
const adminPayments = curl('https://api-alpha.zsaos.com/api/v1/admin/payments', 'api-alpha.zsaos.com', { headers: adminHdr });

const pages = {};
for (const path of [
  '/overview',
  '/projects',
  '/projects/new',
  '/deployments',
  '/runtime',
  '/domains',
  '/resources',
  '/usage',
  '/plan',
  '/billing',
  '/profile',
  '/admin',
  '/admin/commercial',
  '/admin/commercial/payment-test',
  '/admin/commercial/payments',
]) {
  const host = path.startsWith('/admin') || path === '/billing' || path === '/plan' || path === '/profile' || path === '/overview' || path.startsWith('/projects') || path.startsWith('/deploy') || path.startsWith('/runtime') || path.startsWith('/domains') || path.startsWith('/resources') || path.startsWith('/usage')
    ? 'alpha.zsaos.com'
    : 'alpha.zsaos.com';
  pages[path] = curl(`https://alpha.zsaos.com${path}`, host, { headers: adminHdr, maxTime: '30' }).status;
}

let gateClose = null;
if (closeGate) {
  await runner.connect({
    host: server.host,
    port: server.port,
    username: resolveServerSshUsername({ serverUsername: server.username, provider: server.provider }),
    password: decryptCredential(server.credentialEncrypted),
    readyTimeoutMs: 30000,
  });
  await runner.writeTextFile(
    '/opt/launchos/tmp/m81a-close-test-gate.sh',
    [
      '#!/bin/bash',
      'set -euo pipefail',
      'for f in /opt/launchos/config/alpha-api.env /opt/launchos/config/alpha-worker.env; do',
      '  [ -f "$f" ] || continue',
      '  for key in REAL_PAYMENTS_ENABLED ALIPAY_PRODUCTION_ENABLED; do',
      '    if grep -q "^${key}=" "$f"; then sed -i "s/^${key}=.*/${key}=false/" "$f"; else echo "${key}=false" >> "$f"; fi',
      '  done',
      '  for key in PAYMENT_TEST_REAL_ENABLED ALIPAY_PRODUCTION_TEST_ENABLED; do',
      '    if grep -q "^${key}=" "$f"; then sed -i "s/^${key}=.*/${key}=false/" "$f"; else echo "${key}=false" >> "$f"; fi',
      '  done',
      "  if grep -q '^ALIPAY_SANDBOX_ONLY=' \"$f\"; then sed -i 's/^ALIPAY_SANDBOX_ONLY=.*/ALIPAY_SANDBOX_ONLY=true/' \"$f\"; else echo 'ALIPAY_SANDBOX_ONLY=true' >> \"$f\"; fi",
      'done',
      "grep -E '^(REAL_PAYMENTS_ENABLED|PAYMENT_TEST_REAL_ENABLED|ALIPAY_PRODUCTION_TEST_ENABLED|ALIPAY_PRODUCTION_ENABLED|ALIPAY_SANDBOX_ONLY|ALIPAY_PRODUCTION_TEST_WORKSPACE_ID)=' /opt/launchos/config/alpha-api.env || true",
      '',
    ].join('\n'),
  );
  await remoteOk('chmod 700 /opt/launchos/tmp/m81a-close-test-gate.sh && /opt/launchos/tmp/m81a-close-test-gate.sh', 'close-gate', 30000);
  const image = await runner.execute(shellCommand(`podman inspect -f '{{.Config.Image}}' launchos-alpha-api`), { timeoutMs: 15000 });
  const imageName = String(image.stdout || '').trim() || 'localhost/launchos-alpha-api:m81pay';
  await remoteOk(`/opt/launchos/bin/m5-run-api.sh launchos-alpha-api 39110 ${imageName}`, 'restart-api', 180000);
  let ready = false;
  for (let i = 0; i < 40; i++) {
    const probe = await runner.execute(shellCommand('curl -sf --max-time 3 http://127.0.0.1:39110/api/v1/health'), { timeoutMs: 15000 });
    if (probe.exitCode === 0) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!ready) throw new Error('api not ready after gate close');
  const gatesAfter = await remoteOk(
    `grep -E '^(REAL_PAYMENTS_ENABLED|PAYMENT_TEST_REAL_ENABLED|ALIPAY_PRODUCTION_TEST_ENABLED|ALIPAY_PRODUCTION_ENABLED|ALIPAY_SANDBOX_ONLY)=' /opt/launchos/config/alpha-api.env || true`,
    'gates-after',
    15000,
  );
  await runner.disconnect();
  gateClose = String(gatesAfter.stdout || '').trim();
}

const report = {
  closeGateRequested: closeGate,
  gatesBefore: String(gatesBefore.stdout || '').trim(),
  gatesAfterClose: gateClose,
  paymentLines,
  latest: latest
    ? {
        PAYMENT_ORDER_ID: latest[0],
        LOCAL_STATUS: latest[1],
        OUT_TRADE_NO: latest[2],
        PROVIDER_TRADE_NO_PRESENT: latest[3] === '1',
        AMOUNT_CENTS: latest[4],
        CREATED_AT: latest[5],
        PAID_AT: latest[6] || null,
        ENVIRONMENT: latest[7],
        IS_PRODUCTION_TEST: latest[8],
        LAST_QUERY_STATE: latest[9],
        FAILURE_CODE: latest[10] || null,
        COMMERCIAL_ORDER_ID: latest[11],
        ORDER_STATUS: latest[12],
        ORDER_NUMBER: latest[13],
        PLAN_CODE: latest[14],
        FULFILLED_AT: latest[15] || null,
      }
    : null,
  webhooks: String(webhooks.stdout || '').trim().split(/\r?\n/).filter(Boolean),
  audits: String(audits.stdout || '').trim().split(/\r?\n/).filter(Boolean),
  plans: String(plans.stdout || '').trim().split(/\r?\n/).filter(Boolean),
  subscriptions: String(subs.stdout || '').trim().split(/\r?\n/).filter(Boolean),
  reconcile: { status: reconcile.status, body: parse(reconcile.text) },
  paymentDetail: { status: paymentDetail.status, body: parse(paymentDetail.text) },
  paymentTestStatus: { status: paymentTestStatus.status, body: parse(paymentTestStatus.text) },
  checkoutPro: { status: checkoutPro.status, body: parse(checkoutPro.text) },
  billing: { status: billing.status, body: parse(billing.text) },
  adminPayments: { status: adminPayments.status, body: parse(adminPayments.text) },
  pages,
};

writeFileSync(join(ARTIFACT, 'm8-1a-final-verify-raw.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await prisma.$disconnect();
