/**
 * Restart web+worker on m82, verify gates/APIs, write report.
 * Assumes migrate already applied and API already on m82.
 * node scripts/_tmp-m8-2-finish5.mjs --confirm-finish
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
if (!process.argv.includes('--confirm-finish')) {
  console.error('pass --confirm-finish');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');

const WS = 'cmunqotx500cbrl013xbhpio2';
const TARGET_HOST = '116.62.198.184';
const API_TAG = 'launchos-alpha-api:m82';
const WEB_TAG = 'launchos-alpha-web:m82';
const WORKER_TAG = 'launchos-alpha-worker:m82';
const API_REMOTE = `localhost/${API_TAG}`;
const WEB_REMOTE = `localhost/${WEB_TAG}`;
const WORKER_REMOTE = `localhost/${WORKER_TAG}`;
const ARTIFACT = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT, { recursive: true });

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
  const r = await runner.execute(shellCommand(cmd), { timeoutMs });
  console.log(`\n>>> ${cmd.slice(0, 200)}`);
  console.log(`exit=${r.exitCode}`);
  console.log(((r.stdout || '') + (r.stderr || '')).slice(-3500));
  return r;
}
async function remoteOk(cmd, label, timeoutMs = 60000) {
  const r = await remote(cmd, timeoutMs);
  if (r.exitCode !== 0) throw new Error(`${label} failed`);
  return r;
}

await remote('head -n 40 /opt/launchos/bin/m5-run-web.sh 2>/dev/null; echo ---; head -n 40 /opt/launchos/bin/m81pay-run-web.sh 2>/dev/null; echo ---; head -n 40 /opt/launchos/bin/m5-run-worker.sh 2>/dev/null; ls -la /opt/launchos/bin/*web* /opt/launchos/bin/*worker* 2>/dev/null');

// Discover correct web runner signature
const webHelp = await remote('grep -n ".*" /opt/launchos/bin/m5-run-web.sh 2>/dev/null | head -n 60');
const webBody = String(webHelp.stdout || '');

let webCmd;
if (/m5-run-web\.sh/.test(webBody) || webBody.includes('IMAGE')) {
  // try common patterns
}
// Probe scripts
await remote('sed -n "1,80p" /opt/launchos/bin/m5-run-web.sh 2>/dev/null || true');
await remote('sed -n "1,80p" /opt/launchos/bin/m81pay-run-web.sh 2>/dev/null || true');
await remote('sed -n "1,80p" /opt/launchos/bin/m5-run-worker.sh 2>/dev/null || true');
await remote('sed -n "1,80p" /opt/launchos/bin/m5-run-api.sh 2>/dev/null || true');

// Keep gates closed
await remote(
  `for f in /opt/launchos/config/alpha-api.env /opt/launchos/config/alpha-worker.env; do [ -f "$f" ] || continue; for key in REAL_PAYMENTS_ENABLED ALIPAY_PRODUCTION_ENABLED PAYMENT_TEST_REAL_ENABLED ALIPAY_PRODUCTION_TEST_ENABLED; do grep -q "^$key=" "$f" && sed -i "s/^$key=.*/$key=false/" "$f" || echo "$key=false" >> "$f"; done; grep -q '^ALIPAY_SANDBOX_ONLY=' "$f" && sed -i 's/^ALIPAY_SANDBOX_ONLY=.*/ALIPAY_SANDBOX_ONLY=true/' "$f" || echo 'ALIPAY_SANDBOX_ONLY=true' >> "$f"; grep -q '^SUBSCRIPTION_GRACE_PERIOD_DAYS=' "$f" && sed -i 's/^SUBSCRIPTION_GRACE_PERIOD_DAYS=.*/SUBSCRIPTION_GRACE_PERIOD_DAYS=3/' "$f" || echo 'SUBSCRIPTION_GRACE_PERIOD_DAYS=3' >> "$f"; done; true`,
);

// Try web restart variants — m5/m81pay: NAME IMAGE PORT
let webOk = false;
for (const cmd of [
  `/opt/launchos/bin/m5-run-web.sh launchos-alpha-web ${WEB_REMOTE} 39100`,
  `/opt/launchos/bin/m81pay-run-web.sh launchos-alpha-web ${WEB_REMOTE} 39100`,
  `/opt/launchos/bin/m5-run-web.sh ${WEB_REMOTE}`,
  `/opt/launchos/bin/m81pay-run-web.sh ${WEB_REMOTE}`,
]) {
  const r = await remote(`test -x $(echo ${cmd} | awk '{print $1}') && ${cmd}`, 180000);
  if (r.exitCode === 0) {
    webOk = true;
    webCmd = cmd;
    break;
  }
}
if (!webOk) {
  // Manual podman run mirroring api pattern — inspect current web container
  await remote('podman inspect launchos-alpha-web --format "{{.Config.Image}} {{range .Config.Env}}{{println .}}{{end}}" 2>/dev/null | head -n 40 || true');
  await remote('podman inspect launchos-alpha-web --format "{{json .HostConfig.PortBindings}} {{json .HostConfig.Binds}}" 2>/dev/null || true');
  throw new Error('web restart variants failed — see logs');
}

let workerOk = false;
for (const cmd of [
  `/opt/launchos/bin/m5-run-worker.sh ${WORKER_REMOTE}`,
  `/opt/launchos/bin/m5-run-worker.sh launchos-alpha-worker ${WORKER_REMOTE}`,
  `test -x /opt/launchos/bin/m5-run-worker.sh && /opt/launchos/bin/m5-run-worker.sh launchos-alpha-worker ${WORKER_REMOTE}`,
]) {
  const r = await remote(cmd, 180000);
  if (r.exitCode === 0 && !/NO_WORKER/.test(String(r.stdout || ''))) {
    workerOk = true;
    break;
  }
}
console.log({ webCmd, webOk, workerOk });

let apiReady = false;
for (let i = 0; i < 30; i++) {
  const probe = await remote('curl -sf --max-time 3 http://127.0.0.1:39110/api/v1/health || echo HEALTH_FAIL', 15000);
  if (!String(probe.stdout || '').includes('HEALTH_FAIL') && probe.exitCode === 0) {
    apiReady = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 2000));
}
if (!apiReady) throw new Error('api not ready');

const gates = await remote(
  `grep -E '^(REAL_PAYMENTS_ENABLED|PAYMENT_TEST_REAL_ENABLED|ALIPAY_PRODUCTION_TEST_ENABLED|ALIPAY_PRODUCTION_ENABLED|ALIPAY_SANDBOX_ONLY|SUBSCRIPTION_GRACE_PERIOD_DAYS)=' /opt/launchos/config/alpha-api.env || true`,
);
const paymentSql = `SELECT p.id || '|' || p.status || '|' || COALESCE(p."isProductionTest"::text,'') || '|' || COALESCE(p."amountCents"::text,'') FROM "Payment" p JOIN "CommercialOrder" o ON o.id=p."orderId" WHERE o."workspaceId"='${WS}' AND p."isProductionTest"=true AND p.status='SUCCEEDED' ORDER BY p."paidAt" DESC LIMIT 3`;
const payments = String((await remote(`podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc ${JSON.stringify(paymentSql)}`, 20000)).stdout || '').trim();
const subSql = `SELECT s.id || '|' || s.status || '|' || s.source || '|' || pl.code || '|' || COALESCE(s."billingCycle",'') || '|' || COALESCE(s."latestPaymentId",'') FROM "Subscription" s JOIN "Plan" pl ON pl.id=s."planId" WHERE s."workspaceId"='${WS}' ORDER BY s."updatedAt" DESC LIMIT 3`;
const subs = String((await remote(`podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc ${JSON.stringify(subSql)}`, 20000)).stdout || '').trim();
const colCheck = String(
  (
    await remote(
      `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT column_name FROM information_schema.columns WHERE table_name='Subscription' AND column_name IN ('billingCycle','gracePeriodEnd','latestPaymentId','expiredAt','activatedAt') ORDER BY 1"`,
      20000,
    )
  ).stdout || '',
).trim();
const statusEnum = String(
  (
    await remote(
      `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='SubscriptionStatus' ORDER BY enumsortorder"`,
      20000,
    )
  ).stdout || '',
).trim();
const changeReq = String(
  (
    await remote(
      `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT to_regclass('public.SubscriptionChangeRequest')"`,
      20000,
    )
  ).stdout || '',
).trim();
const images = String((await remote(`podman images --format '{{.Repository}}:{{.Tag}}' | grep m82 || true`)).stdout || '').trim();
const running = String((await remote(`podman ps --format '{{.Names}} {{.Image}}' | grep launchos-alpha || true`)).stdout || '').trim();

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

const checkoutPro = curl('https://api-alpha.zsaos.com/api/v1/billing/checkout', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: userHdr,
  body: JSON.stringify({ planCode: 'pro', billingCycle: 'MONTHLY' }),
});
const changePlan = curl('https://api-alpha.zsaos.com/api/v1/billing/subscription/change-plan', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: userHdr,
  body: JSON.stringify({ planCode: 'pro' }),
});
const billingSub = curl('https://api-alpha.zsaos.com/api/v1/billing/subscription', 'api-alpha.zsaos.com', { headers: userHdr });
const reconcile = curl('https://api-alpha.zsaos.com/api/v1/admin/subscriptions/reconcile', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: adminHdr,
  body: '{}',
});
const paymentTest = curl('https://api-alpha.zsaos.com/api/v1/admin/commercial/payment-test', 'api-alpha.zsaos.com', { headers: adminHdr });

const pages = {};
for (const path of [
  '/overview',
  '/billing',
  '/plan',
  '/admin/commercial',
  '/admin/commercial/subscriptions',
  '/admin/subscriptions',
  '/admin/commercial/payment-test',
]) {
  pages[path] = curl(`https://alpha.zsaos.com${path}`, 'alpha.zsaos.com', { headers: adminHdr, maxTime: '30' }).status;
}

const changeBody = parse(changePlan.text);
const gatesText = String(gates.stdout || '');
const report = {
  images: { API: API_TAG, WEB: WEB_TAG, WORKER: WORKER_TAG, loaded: images.split(/\r?\n/).filter(Boolean), running: running.split(/\r?\n/).filter(Boolean) },
  webCmd,
  workerOk,
  schemaColumns: colCheck.split(/\r?\n/).filter(Boolean),
  statusEnum: statusEnum.split(/\r?\n/).filter(Boolean),
  changeRequestTable: changeReq,
  gates: gatesText.trim(),
  paymentsTestWorkspace: payments.split(/\r?\n/).filter(Boolean),
  subscriptionsWorkspace: subs.split(/\r?\n/).filter(Boolean),
  checkoutPro: { status: checkoutPro.status, body: parse(checkoutPro.text) },
  changePlan: { status: changePlan.status, body: changeBody },
  billingSubscription: { status: billingSub.status, body: parse(billingSub.text) },
  reconcile: { status: reconcile.status, body: parse(reconcile.text) },
  paymentTest: { status: paymentTest.status, body: parse(paymentTest.text) },
  pages,
  checks: {
    REAL_PAYMENTS_ENABLED_FALSE: /REAL_PAYMENTS_ENABLED=false/.test(gatesText),
    PAYMENT_TEST_REAL_ENABLED_FALSE: /PAYMENT_TEST_REAL_ENABLED=false/.test(gatesText),
    ALIPAY_PRODUCTION_TEST_ENABLED_FALSE: /ALIPAY_PRODUCTION_TEST_ENABLED=false/.test(gatesText),
    SUBSCRIPTION_GRACE_PERIOD_DAYS_3: /SUBSCRIPTION_GRACE_PERIOD_DAYS=3/.test(gatesText),
    SCHEMA_M82_COLUMNS: /billingCycle/.test(colCheck) && /gracePeriodEnd/.test(colCheck),
    GRACE_PERIOD_ENUM: /GRACE_PERIOD/.test(statusEnum),
    CHANGE_REQUEST_TABLE: /SubscriptionChangeRequest/.test(changeReq),
    PRO_CHECKOUT_BLOCKED: parse(checkoutPro.text).available === false || parse(checkoutPro.text).code === 'REAL_PAYMENTS_DISABLED',
    FREE_TO_PAID_WITHOUT_PAYMENT_BLOCKED:
      changePlan.status >= 400 ||
      changeBody.code === 'FREE_TO_PAID_WITHOUT_PAYMENT_BLOCKED' ||
      /FREE_TO_PAID|付款|支付/.test(JSON.stringify(changeBody)),
    PAYMENT_TEST_DID_NOT_CREATE_PAID_SUBSCRIPTION: !/\|PAYMENT\|pro\|/i.test(subs) && /\|free\|/i.test(subs),
    AUTO_RENEW_FALSE: parse(billingSub.text).autoRenew === false,
  },
};
writeFileSync(join(ARTIFACT, 'm8-2-promote-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await prisma.$disconnect();
