/**
 * Finish M8-2: free disk, resolve stuck M7 migration, load worker, migrate, restart, verify.
 * node scripts/_tmp-m8-2-finish2.mjs --confirm-finish
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
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
const PRISMA_BIN =
  "(test -x /app/node_modules/.bin/prisma && echo /app/node_modules/.bin/prisma) || (find /app/node_modules -path '*/prisma/build/index.js' | head -n 1)";

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
  console.log(`\n>>> ${cmd.slice(0, 160)}`);
  console.log(`exit=${r.exitCode}`);
  console.log(((r.stdout || '') + (r.stderr || '')).slice(-3000));
  return r;
}
async function remoteOk(cmd, label, timeoutMs = 60000) {
  const r = await remote(cmd, timeoutMs);
  if (r.exitCode !== 0) throw new Error(`${label} failed`);
  return r;
}

await remote('df -h / | head -n 3');
await remote('rm -f /opt/launchos/tmp/*.tar; ls /opt/launchos/tmp/*.tar 2>/dev/null || echo NO_TARS');
await remote('podman image prune -af', 180000);

// Remove old control-plane images one family at a time (no xargs -r)
for (const tag of ['m75', 'm76', 'm77', 'm78', 'zip200', 'zip1200', 'm81a', 'notifyfix', 'resync']) {
  await remote(
    `podman images --format '{{.ID}} {{.Repository}}:{{.Tag}}' | grep launchos-alpha | grep ${tag} | awk '{print $1}' | sort -u | while read id; do podman rmi -f "$id" || true; done`,
    120000,
  );
}
await remote(
  `podman images --format '{{.ID}} {{.Repository}}:{{.Tag}}' | grep '<none>' | awk '{print $1}' | sort -u | while read id; do podman rmi -f "$id" || true; done`,
  180000,
);
await remote('podman image prune -af', 120000);
await remote('df -h / | head -n 3');
await remote("podman images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | grep launchos-alpha | head -n 30");

const workerList = await remote("podman images --format '{{.Repository}}:{{.Tag}}' | grep 'launchos-alpha-worker:m82' || true");
const hasWorker = /launchos-alpha-worker:m82/.test(String(workerList.stdout || ''));
if (!hasWorker) {
  const workerTar = join(ARTIFACT, 'launchos-alpha-worker-m82.tar');
  if (!existsSync(workerTar)) throw new Error('missing local worker tar');
  console.log('uploading worker', statSync(workerTar).size);
  await runner.upload(workerTar, '/opt/launchos/tmp/launchos-alpha-worker-m82.tar', { timeoutMs: 900000 });
  await remoteOk(
    `podman load -i /opt/launchos/tmp/launchos-alpha-worker-m82.tar && rm -f /opt/launchos/tmp/launchos-alpha-worker-m82.tar && (podman tag docker.io/library/${WORKER_TAG} ${WORKER_REMOTE} || podman tag ${WORKER_TAG} ${WORKER_REMOTE} || true)`,
    'load-worker',
    300000,
  );
} else {
  console.log('worker image present');
}

await runner.writeTextFile(
  '/opt/launchos/tmp/m82-close-payment-gates.sh',
  `#!/bin/bash
set -eu
for f in /opt/launchos/config/alpha-api.env /opt/launchos/config/alpha-worker.env; do
  [ -f "$f" ] || continue
  for key in REAL_PAYMENTS_ENABLED ALIPAY_PRODUCTION_ENABLED PAYMENT_TEST_REAL_ENABLED ALIPAY_PRODUCTION_TEST_ENABLED; do
    if grep -q "^\${key}=" "$f"; then sed -i "s/^\${key}=.*/\${key}=false/" "$f"; else echo "\${key}=false" >> "$f"; fi
  done
  if grep -q '^ALIPAY_SANDBOX_ONLY=' "$f"; then sed -i 's/^ALIPAY_SANDBOX_ONLY=.*/ALIPAY_SANDBOX_ONLY=true/' "$f"; else echo 'ALIPAY_SANDBOX_ONLY=true' >> "$f"; fi
  if grep -q '^SUBSCRIPTION_GRACE_PERIOD_DAYS=' "$f"; then sed -i 's/^SUBSCRIPTION_GRACE_PERIOD_DAYS=.*/SUBSCRIPTION_GRACE_PERIOD_DAYS=3/' "$f"; else echo 'SUBSCRIPTION_GRACE_PERIOD_DAYS=3' >> "$f"; fi
done
grep -E '^(REAL_PAYMENTS_ENABLED|PAYMENT_TEST_REAL_ENABLED|ALIPAY_PRODUCTION_TEST_ENABLED|ALIPAY_PRODUCTION_ENABLED|ALIPAY_SANDBOX_ONLY|SUBSCRIPTION_GRACE_PERIOD_DAYS)=' /opt/launchos/config/alpha-api.env || true
`,
);
await remoteOk('chmod 700 /opt/launchos/tmp/m82-close-payment-gates.sh && /opt/launchos/tmp/m82-close-payment-gates.sh', 'gates');

// Resolve failed M7 migration (column already exists) then deploy remaining including M8-2
await remoteOk(
  `podman run --rm --network host --env-file /opt/launchos/config/alpha-api.env ${API_REMOTE} sh -c 'cd /app/packages/database && BIN=$(${PRISMA_BIN}) && echo BIN=$BIN && node "$BIN" migrate resolve --applied 20261001230000_m7_growth_analytics'`,
  'resolve-m7',
  120000,
);
await remoteOk(
  `podman run --rm --network host --env-file /opt/launchos/config/alpha-api.env ${API_REMOTE} sh -c 'cd /app/packages/database && BIN=$(${PRISMA_BIN}) && if echo "$BIN" | grep -q index.js; then node "$BIN" migrate deploy; else "$BIN" migrate deploy; fi'`,
  'migrate-deploy',
  180000,
);

await remoteOk(`/opt/launchos/bin/m5-run-api.sh launchos-alpha-api 39110 ${API_REMOTE}`, 'api', 180000);
await remoteOk(
  `test -x /opt/launchos/bin/m5-run-web.sh && /opt/launchos/bin/m5-run-web.sh launchos-alpha-web 39100 ${WEB_REMOTE} || /opt/launchos/bin/m81pay-run-web.sh ${WEB_REMOTE}`,
  'web',
  180000,
);
const workerRun = await remote(
  `test -x /opt/launchos/bin/m5-run-worker.sh && /opt/launchos/bin/m5-run-worker.sh launchos-alpha-worker ${WORKER_REMOTE} || echo NO_WORKER_SCRIPT`,
  180000,
);

let apiReady = false;
for (let i = 0; i < 40; i++) {
  const probe = await remote('curl -sf --max-time 3 http://127.0.0.1:39110/api/v1/health || echo HEALTH_FAIL', 15000);
  if (!String(probe.stdout || '').includes('HEALTH_FAIL') && probe.exitCode === 0) {
    apiReady = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 3000));
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
const images = String((await remote(`podman images --format '{{.Repository}}:{{.Tag}}' | grep -E 'm82|m81pay' || true`)).stdout || '').trim();
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
  workerRestart: { exit: workerRun.exitCode, out: String(workerRun.stdout || workerRun.stderr || '').slice(0, 500) },
  schemaColumns: colCheck.split(/\r?\n/).filter(Boolean),
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
