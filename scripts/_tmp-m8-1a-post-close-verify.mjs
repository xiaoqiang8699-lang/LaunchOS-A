/**
 * Post-gate-close verification for M8-1A (no new orders).
 * node scripts/_tmp-m8-1a-post-close-verify.mjs
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

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');

const WS = 'cmunqotx500cbrl013xbhpio2';
const OUT = 'LOS-20261002-B30E293D';
const PAYMENT_ID = 'cmuqolrtp006yrl01fgsxbh1c';
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
async function remote(cmd, timeoutMs = 60000) {
  return runner.execute(shellCommand(cmd), { timeoutMs });
}
async function remoteOk(cmd, label, timeoutMs = 60000) {
  const r = await remote(cmd, timeoutMs);
  if (r.exitCode !== 0) throw new Error(`${label}: ${(r.stderr || r.stdout || '').slice(0, 2000)}`);
  return r;
}

const gates = await remoteOk(
  `grep -E '^(REAL_PAYMENTS_ENABLED|PAYMENT_TEST_REAL_ENABLED|ALIPAY_PRODUCTION_TEST_ENABLED|ALIPAY_PRODUCTION_ENABLED|ALIPAY_SANDBOX_ONLY)=' /opt/launchos/config/alpha-api.env || true`,
  'gates',
  15000,
);

const queryScript = `
const { PrismaClient } = require('@launchos/database');
const { decryptCredential } = require('@launchos/shared');
const { AlipayPaymentProvider } = require('@launchos/providers');
(async () => {
  const prisma = new PrismaClient();
  const account = await prisma.paymentProviderAccount.findUnique({
    where: { provider_environment: { provider: 'ALIPAY', environment: 'PRODUCTION' } },
  });
  const privateKey = decryptCredential(account.credentialEncrypted);
  const provider = new AlipayPaymentProvider({
    appId: account.appId,
    gatewayUrl: account.gatewayUrl,
    privateKey,
    alipayPublicKey: account.publicKey,
    notifyUrl: account.notifyUrl,
    returnUrl: account.returnUrl,
  });
  const r = await provider.getCheckoutStatus(${JSON.stringify(OUT)});
  console.log(JSON.stringify({
    outTradeNo: ${JSON.stringify(OUT)},
    state: r.state,
    amountCents: r.amountCents ?? null,
    providerTradeNoPresent: !!(r.providerTradeNo),
    merchantOrderNo: r.merchantOrderNo ?? null,
    gatewayHost: String(account.gatewayUrl || '').includes('openapi.alipay.com') ? 'PRODUCTION' : 'OTHER',
  }));
  await prisma.$disconnect();
})().catch((e) => { console.log(JSON.stringify({ error: String(e && e.message || e) })); process.exit(1); });
`;

const alipay = await remote(`podman exec launchos-alpha-api node -e ${JSON.stringify(queryScript)}`, 90000);
let alipaySafe = {};
try {
  alipaySafe = JSON.parse(String(alipay.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '{}');
} catch {
  alipaySafe = { raw: String(alipay.stdout || alipay.stderr || '').slice(0, 800) };
}

const webhookSql = `SELECT e.id || '|' || COALESCE(e.status,'') || '|' || COALESCE(e."eventType",'') || '|' || COALESCE(e."paymentId",'') || '|' || e."receivedAt"::text || '|' || COALESCE(e."errorCode",'') FROM "PaymentWebhookEvent" e WHERE e."paymentId"='${PAYMENT_ID}' OR (e.provider='ALIPAY' AND e."receivedAt" > '2026-10-02 08:00:00') ORDER BY e."receivedAt" DESC LIMIT 10`;
const webhooks = String((await remoteOk(`podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc ${JSON.stringify(webhookSql)}`, 'webhooks', 20000)).stdout || '').trim();

const auditSql = `SELECT a.action || '|' || a."createdAt"::text FROM "AuditLog" a WHERE a."workspaceId"='${WS}' AND a."createdAt" > '2026-10-02 08:00:00' ORDER BY a."createdAt" DESC LIMIT 40`;
const audits = String((await remoteOk(`podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc ${JSON.stringify(auditSql)}`, 'audits', 20000)).stdout || '').trim();

const subSql = `SELECT s.id || '|' || s.status::text || '|' || COALESCE(pl.code,'') || '|' || COALESCE(s.source,'') FROM "Subscription" s JOIN "Plan" pl ON pl.id=s."planId" WHERE s."workspaceId"='${WS}' ORDER BY s."updatedAt" DESC LIMIT 3`;
const subs = String((await remoteOk(`podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc ${JSON.stringify(subSql)}`, 'subs', 15000)).stdout || '').trim();

const eventSql = `SELECT e."eventType" || '|' || COALESCE(e.source,'') || '|' || e."effectiveAt"::text || '|' || COALESCE(e."idempotencyKey",'') FROM "SubscriptionEvent" e WHERE e."workspaceId"='${WS}' AND e."effectiveAt" > '2026-10-02 08:00:00' ORDER BY e."effectiveAt" DESC LIMIT 10`;
const events = String((await remoteOk(`podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc ${JSON.stringify(eventSql)}`, 'events', 15000)).stdout || '').trim();

const paidSql = `SELECT p.id || '|' || p.status || '|' || COALESCE(p."merchantOrderNo",'') || '|' || CASE WHEN COALESCE(p."providerTradeNo",'')<>'' THEN '1' ELSE '0' END || '|' || COALESCE(p."amountCents"::text,'') || '|' || COALESCE(p."paidAt"::text,'') || '|' || COALESCE(p."lastQueryState",'') FROM "Payment" p WHERE p.id='${PAYMENT_ID}'`;
const paid = String((await remoteOk(`podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc ${JSON.stringify(paidSql)}`, 'paid', 15000)).stdout || '').trim();

const runtime = await remote(`echo ===API===; curl -sf --max-time 3 http://127.0.0.1:39110/api/v1/health || echo FAIL; echo ===PS===; podman ps --format '{{.Names}} {{.Status}}' | grep -E 'launchos-alpha|redis|postgres' ; echo ===WORKER===; podman ps --format '{{.Names}} {{.Status}}' | grep -i worker || true`, 30000);

await runner.disconnect();

const adminLogin = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: adminAuth.email, password: adminAuth.password }),
});
const adminToken = parse(adminLogin.text).accessToken;
const adminHdr = { authorization: `Bearer ${adminToken}` };
const userLogin = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: userAuth.email || '1002@qq.com', password: userAuth.password }),
});
const userHdr = { authorization: `Bearer ${parse(userLogin.text).accessToken}` };

const paymentTest = curl('https://api-alpha.zsaos.com/api/v1/admin/commercial/payment-test', 'api-alpha.zsaos.com', { headers: adminHdr });
const paymentDetail = curl(`https://api-alpha.zsaos.com/api/v1/admin/payments/${PAYMENT_ID}`, 'api-alpha.zsaos.com', { headers: adminHdr });
const billing = curl('https://api-alpha.zsaos.com/api/v1/account/billing', 'api-alpha.zsaos.com', { headers: userHdr });
const checkoutPro = curl('https://api-alpha.zsaos.com/api/v1/billing/checkout', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: userHdr,
  body: JSON.stringify({ planCode: 'pro', billingCycle: 'MONTHLY' }),
});
const reconcile = curl('https://api-alpha.zsaos.com/api/v1/admin/payments/reconcile', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: adminHdr,
  body: '{}',
  maxTime: '120',
});

const pages = {};
for (const path of ['/overview','/projects','/projects/new','/deployments','/runtime','/domains','/resources','/usage','/plan','/billing','/profile','/admin','/admin/commercial','/admin/commercial/payment-test','/admin/commercial/payments']) {
  pages[path] = curl(`https://alpha.zsaos.com${path}`, 'alpha.zsaos.com', { headers: adminHdr, maxTime: '30' }).status;
}

const billingBody = parse(billing.text);
const detailBody = parse(paymentDetail.text);
const paymentTestBody = parse(paymentTest.text);
const checkoutBody = parse(checkoutPro.text);

const billingFound =
  JSON.stringify(billingBody).includes(OUT) ||
  JSON.stringify(billingBody).includes(PAYMENT_ID) ||
  JSON.stringify(billingBody).includes('0.9') ||
  JSON.stringify(billingBody).includes('PAYMENT_TEST') ||
  JSON.stringify(billingBody).includes('90');

const report = {
  gates: String(gates.stdout || '').trim(),
  paid,
  alipayQuery: alipaySafe,
  webhooks: webhooks.split(/\r?\n/).filter(Boolean),
  audits: audits.split(/\r?\n/).filter(Boolean),
  subscriptions: subs.split(/\r?\n/).filter(Boolean),
  events: events.split(/\r?\n/).filter(Boolean),
  runtime: String(runtime.stdout || '').trim(),
  paymentTestStatus: { status: paymentTest.status, body: paymentTestBody },
  paymentDetail: { status: paymentDetail.status, body: detailBody },
  billing: { status: billing.status, foundLikely: billingFound, body: billingBody },
  checkoutPro: { status: checkoutPro.status, body: checkoutBody },
  reconcile: { status: reconcile.status, body: parse(reconcile.text) },
  pages,
};

writeFileSync(join(ARTIFACT, 'm8-1a-post-close-verify.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await prisma.$disconnect();
