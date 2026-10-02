/**
 * Inspect API image paths + reload web + fix migrate + restart.
 * node scripts/_tmp-m8-2-finish3.mjs --confirm-finish
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
  console.log(`\n>>> ${cmd.slice(0, 180)}`);
  console.log(`exit=${r.exitCode}`);
  console.log(((r.stdout || '') + (r.stderr || '')).slice(-3500));
  return r;
}
async function remoteOk(cmd, label, timeoutMs = 60000) {
  const r = await remote(cmd, timeoutMs);
  if (r.exitCode !== 0) throw new Error(`${label} failed`);
  return r;
}

async function ensureTar(localName, remotePath, tag, remoteTag) {
  const listed = await remote(`podman images --format '{{.Repository}}:{{.Tag}}' | grep ${JSON.stringify(tag)} || true`);
  if (String(listed.stdout || '').includes(tag)) {
    console.log('present', tag);
    return;
  }
  const localTar = join(ARTIFACT, localName);
  if (!existsSync(localTar)) throw new Error(`missing ${localTar}`);
  console.log('upload', localName, statSync(localTar).size);
  await runner.upload(localTar, remotePath, { timeoutMs: 900000 });
  await remoteOk(
    `podman load -i ${remotePath} && rm -f ${remotePath} && (podman tag docker.io/library/${tag} ${remoteTag} || podman tag ${tag} ${remoteTag} || true)`,
    `load-${tag}`,
    300000,
  );
}

await remote('df -h / | head -n 3');
await remote(`podman images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | head -n 40`);
await remote(`podman ps -a --format '{{.Names}} {{.Status}} {{.Image}}' | grep launchos-alpha || true`);

// Inspect api image layout for prisma
await remote(
  `podman run --rm ${API_REMOTE} sh -c 'ls -la /app | head -n 40; echo ---; ls /app/node_modules 2>/dev/null | head -n 20; echo ---; ls /app/packages/database 2>/dev/null; echo ---; find /app -name prisma -type f 2>/dev/null | head -n 20; echo ---; find /app -path "*prisma/build/index.js" 2>/dev/null | head -n 10; echo ---; ls /app/apps/api/node_modules 2>/dev/null | head -n 10'`,
  120000,
);

await ensureTar('launchos-alpha-web-m82.tar', '/opt/launchos/tmp/launchos-alpha-web-m82.tar', WEB_TAG, WEB_REMOTE);
await ensureTar('launchos-alpha-worker-m82.tar', '/opt/launchos/tmp/launchos-alpha-worker-m82.tar', WORKER_TAG, WORKER_REMOTE);

// Prefer npx from node image, or prisma from pnpm virtual store via package script
const migrateCmd = [
  `podman run --rm --network host --env-file /opt/launchos/config/alpha-api.env ${API_REMOTE} sh -c `,
  `\"cd /app && `,
  `if [ -x node_modules/.bin/prisma ]; then node_modules/.bin/prisma migrate deploy --schema packages/database/prisma/schema.prisma; `,
  `elif [ -f node_modules/prisma/build/index.js ]; then node node_modules/prisma/build/index.js migrate deploy --schema packages/database/prisma/schema.prisma; `,
  `elif command -v corepack >/dev/null; then corepack enable && corepack prepare pnpm@10.34.5 --activate && pnpm --filter @launchos/database exec prisma migrate deploy; `,
  `else echo NO_PRISMA; ls -la; exit 2; fi\"`,
].join('');

await remote(
  `podman run --rm --network host --env-file /opt/launchos/config/alpha-api.env ${API_REMOTE} sh -c "cd /app && if [ -x node_modules/.bin/prisma ]; then node_modules/.bin/prisma migrate resolve --applied 20261001230000_m7_growth_analytics --schema packages/database/prisma/schema.prisma; elif [ -f node_modules/prisma/build/index.js ]; then node node_modules/prisma/build/index.js migrate resolve --applied 20261001230000_m7_growth_analytics --schema packages/database/prisma/schema.prisma; else echo SKIP_RESOLVE_NO_BIN; fi"`,
  120000,
);
await remoteOk(migrateCmd, 'migrate', 180000);

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
const statusEnum = String(
  (
    await remote(
      `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='SubscriptionStatus' ORDER BY enumsortorder"`,
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
  workerRestart: { exit: workerRun.exitCode, out: String(workerRun.stdout || workerRun.stderr || '').slice(0, 800) },
  schemaColumns: colCheck.split(/\r?\n/).filter(Boolean),
  statusEnum: statusEnum.split(/\r?\n/).filter(Boolean),
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
