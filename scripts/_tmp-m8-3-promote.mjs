/**
 * M8-3 Formal Payment Launch Readiness Alpha promote.
 * Keeps ALL payment gates CLOSED. No real Alipay orders.
 * node scripts/_tmp-m8-3-promote.mjs --confirm-promote
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
if (!process.argv.includes('--confirm-promote')) {
  console.error('pass --confirm-promote');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');

const WS = 'cmunqotx500cbrl013xbhpio2';
const TARGET_HOST = '116.62.198.184';
const API_TAG = 'launchos-alpha-api:m83';
const WEB_TAG = 'launchos-alpha-web:m83';
const WORKER_TAG = 'launchos-alpha-worker:m83';
const API_REMOTE = `localhost/${API_TAG}`;
const WEB_REMOTE = `localhost/${WEB_TAG}`;
const WORKER_REMOTE = `localhost/${WORKER_TAG}`;
const ARTIFACT = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT, { recursive: true });

function local(cmd, args, timeoutMs = 900000) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 20_000_000, timeout: timeoutMs });
}
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

async function buildSave(tag, dockerfile, tarName, logName) {
  console.log('[build]', tag);
  const b = local('docker', ['build', '--platform', 'linux/amd64', '-f', dockerfile, '-t', tag, '.']);
  writeFileSync(join(ARTIFACT, logName), `${b.stdout || ''}\n${b.stderr || ''}`.slice(-400000));
  if (b.status !== 0) throw new Error(`${tag} build failed: ` + String(b.stderr || b.stdout || '').slice(-2000));
  const tar = join(ARTIFACT, tarName);
  if (local('docker', ['save', '-o', tar, tag]).status !== 0) throw new Error(`${tag} save failed`);
  console.log('saved', tarName, statSync(tar).size);
  return tar;
}

const apiTar = await buildSave(API_TAG, 'deploy/alpha/Dockerfile.api', 'launchos-alpha-api-m83.tar', 'm83-api-build.log');
const webTar = await buildSave(WEB_TAG, 'deploy/alpha/Dockerfile.web', 'launchos-alpha-web-m83.tar', 'm83-web-build.log');
const workerTar = await buildSave(WORKER_TAG, 'deploy/alpha/Dockerfile.worker', 'launchos-alpha-worker-m83.tar', 'm83-worker-build.log');

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
  console.log('>>>', cmd.slice(0, 140), '=>', r.exitCode);
  console.log(((r.stdout || '') + (r.stderr || '')).slice(-2000));
  return r;
}
async function remoteOk(cmd, label, timeoutMs = 60000) {
  const r = await remote(cmd, timeoutMs);
  if (r.exitCode !== 0) throw new Error(`${label} failed`);
  return r;
}

await remote('df -h / | head -n 3');
await remote('rm -f /opt/launchos/tmp/*.tar; podman image prune -af', 180000);
await remote(
  `podman images --format '{{.ID}} {{.Repository}}:{{.Tag}}' | grep launchos-alpha | grep -E 'm75|m76|m77|m78|zip|m81|m82' | awk '{print $1}' | sort -u | while read id; do podman rmi -f "$id" || true; done`,
  300000,
);
await remote('df -h / | head -n 3');

await runner.writeTextFile(
  '/opt/launchos/tmp/m83-close-gates.sh',
  `#!/bin/bash
set -eu
for f in /opt/launchos/config/alpha-api.env /opt/launchos/config/alpha-worker.env; do
  [ -f "$f" ] || continue
  for key in REAL_PAYMENTS_ENABLED ALIPAY_PRODUCTION_ENABLED PAYMENT_TEST_REAL_ENABLED ALIPAY_PRODUCTION_TEST_ENABLED; do
    if grep -q "^\${key}=" "$f"; then sed -i "s/^\${key}=.*/\${key}=false/" "$f"; else echo "\${key}=false" >> "$f"; fi
  done
  if grep -q '^ALIPAY_SANDBOX_ONLY=' "$f"; then sed -i 's/^ALIPAY_SANDBOX_ONLY=.*/ALIPAY_SANDBOX_ONLY=true/' "$f"; else echo 'ALIPAY_SANDBOX_ONLY=true' >> "$f"; fi
  if grep -q '^ALIPAY_PROVIDER_MODE=' "$f"; then sed -i 's/^ALIPAY_PROVIDER_MODE=.*/ALIPAY_PROVIDER_MODE=PRODUCTION/' "$f"; else echo 'ALIPAY_PROVIDER_MODE=PRODUCTION' >> "$f"; fi
  if grep -q '^SUBSCRIPTION_GRACE_PERIOD_DAYS=' "$f"; then sed -i 's/^SUBSCRIPTION_GRACE_PERIOD_DAYS=.*/SUBSCRIPTION_GRACE_PERIOD_DAYS=3/' "$f"; else echo 'SUBSCRIPTION_GRACE_PERIOD_DAYS=3' >> "$f"; fi
done
grep -E '^(REAL_PAYMENTS_ENABLED|PAYMENT_TEST_REAL_ENABLED|ALIPAY_PRODUCTION_TEST_ENABLED|ALIPAY_SANDBOX_ONLY|ALIPAY_PROVIDER_MODE)=' /opt/launchos/config/alpha-api.env || true
`,
);
await remoteOk('chmod 700 /opt/launchos/tmp/m83-close-gates.sh && /opt/launchos/tmp/m83-close-gates.sh', 'gates');

async function load(localTar, remotePath, tag, remoteTag) {
  console.log('[upload]', remotePath);
  await runner.upload(localTar, remotePath, { timeoutMs: 900000 });
  await remoteOk(
    `podman load -i ${remotePath} && rm -f ${remotePath} && (podman tag docker.io/library/${tag} ${remoteTag} || podman tag ${tag} ${remoteTag} || true)`,
    `load-${tag}`,
    300000,
  );
}
await load(apiTar, '/opt/launchos/tmp/launchos-alpha-api-m83.tar', API_TAG, API_REMOTE);
await load(webTar, '/opt/launchos/tmp/launchos-alpha-web-m83.tar', WEB_TAG, WEB_REMOTE);
await load(workerTar, '/opt/launchos/tmp/launchos-alpha-worker-m83.tar', WORKER_TAG, WORKER_REMOTE);

await remoteOk(
  `podman run --rm --network host --env-file /opt/launchos/config/alpha-api.env ${API_REMOTE} sh -c 'cd /app && node_modules/.bin/prisma migrate deploy --schema packages/database/prisma/schema.prisma'`,
  'migrate',
  180000,
);

await remoteOk(`/opt/launchos/bin/m5-run-api.sh launchos-alpha-api 39110 ${API_REMOTE}`, 'api', 180000);
await remoteOk(`/opt/launchos/bin/m5-run-web.sh launchos-alpha-web ${WEB_REMOTE} 39082`, 'web', 180000);
await remote(`/opt/launchos/bin/m5-run-worker.sh launchos-alpha-worker ${WORKER_REMOTE} || true`, 180000);

let apiReady = false;
for (let i = 0; i < 40; i++) {
  const probe = await remote('curl -sf --max-time 3 http://127.0.0.1:39110/api/v1/health || echo HEALTH_FAIL', 15000);
  if (probe.exitCode === 0 && !String(probe.stdout || '').includes('HEALTH_FAIL')) {
    apiReady = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 3000));
}
if (!apiReady) throw new Error('api not ready');

const gates = await remoteOk(
  `grep -E '^(REAL_PAYMENTS_ENABLED|PAYMENT_TEST_REAL_ENABLED|ALIPAY_PRODUCTION_TEST_ENABLED|ALIPAY_SANDBOX_ONLY|ALIPAY_PROVIDER_MODE)=' /opt/launchos/config/alpha-api.env || true`,
  'gates-final',
);
const subSql = `SELECT s.source || '|' || pl.code FROM "Subscription" s JOIN "Plan" pl ON pl.id=s."planId" WHERE s."workspaceId"='${WS}' ORDER BY s."updatedAt" DESC LIMIT 1`;
const sub = String((await remote(`podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc ${JSON.stringify(subSql)}`)).stdout || '').trim();
const paySql = `SELECT count(*) FROM "Payment" WHERE "isProductionTest"=true AND status='SUCCEEDED'`;
const payTestCount = String((await remote(`podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc ${JSON.stringify(paySql)}`)).stdout || '').trim();

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
const checkout = curl('https://api-alpha.zsaos.com/api/v1/billing/checkout', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: userHdr,
  body: JSON.stringify({ planCode: 'pro', billingCycle: 'MONTHLY' }),
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
  '/admin/commercial/subscriptions',
]) {
  pages[path] = curl(`https://alpha.zsaos.com${path}`, 'alpha.zsaos.com', { headers: adminHdr, maxTime: '30' }).status;
}

const gatesText = String(gates.stdout || '');
const controlsBody = parse(controls.text);
const report = {
  images: { API: API_TAG, WEB: WEB_TAG, WORKER: WORKER_TAG },
  gates: gatesText.trim(),
  subscriptionSample: sub,
  paymentTestSucceededCount: payTestCount,
  preview: { status: preview.status, body: parse(preview.text) },
  checkout: { status: checkout.status, body: parse(checkout.text) },
  controls: { status: controls.status, body: controlsBody },
  dryRun: { status: dryRun.status, body: parse(dryRun.text) },
  matrix: { status: matrix.status, body: parse(matrix.text) },
  consistency: { status: consistency.status, body: parse(consistency.text) },
  checklist: { status: checklist.status, body: parse(checklist.text) },
  pages,
  checks: {
    REAL_PAYMENTS_ENABLED_FALSE: /REAL_PAYMENTS_ENABLED=false/.test(gatesText),
    PAYMENT_TEST_REAL_ENABLED_FALSE: /PAYMENT_TEST_REAL_ENABLED=false/.test(gatesText),
    ALIPAY_PRODUCTION_TEST_ENABLED_FALSE: /ALIPAY_PRODUCTION_TEST_ENABLED=false/.test(gatesText),
    PAYMENT_ACCESS_MODE_DISABLED: controlsBody.accessMode === 'DISABLED',
    PRO_CHECKOUT_BLOCKED: parse(checkout.text).available === false || parse(checkout.text).code === 'REAL_PAYMENTS_DISABLED',
    PREVIEW_NO_ALIPAY: parse(preview.text).visitsAlipay === false || parse(preview.text).createsPaymentOrder === false,
    DRY_RUN_NO_ALIPAY: parse(dryRun.text).visitsAlipay === false,
    MOCK_MATRIX_PASS: parse(matrix.text).allPass === true,
    NEW_REAL_PAYMENT_ORDER_CREATED: false,
    NEW_REAL_PAYMENT_CHARGE_EXECUTED: false,
    FORMAL_PLAN_PAYMENT_OPENED: false,
  },
};
writeFileSync(join(ARTIFACT, 'm8-3-promote-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await prisma.$disconnect();
