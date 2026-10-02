/**
 * Rebuild notify-fix API (express MODULE_NOT_FOUND fix), deploy, reconcile.
 * Preserves ARM gates. No new orders.
 * node scripts/_tmp-m8-1a-notify-rebuild-promote.mjs --confirm-promote
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
const API_TAG = 'launchos-alpha-api:m81pay';
const API_REMOTE = `localhost/${API_TAG}`;
const ARTIFACT = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT, { recursive: true });
const tarName = 'launchos-alpha-api-m81a-notifyfix2.tar';
const tarLocal = join(ARTIFACT, tarName);
const tarRemote = `/opt/launchos/tmp/${tarName}`;

function local(cmd, args, timeoutMs = 900000) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 20_000_000, timeout: timeoutMs });
}
function curl(url, host, opts = {}) {
  const { method = 'GET', headers = {}, body = null, maxTime = '90', form = false } = opts;
  const args = ['-sS', '-L', '-X', method, '-w', '\n__STATUS__:%{http_code}', '--max-time', String(maxTime)];
  args.push('--resolve', `${host}:443:${TARGET_HOST}`);
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body != null) {
    args.push('-H', form ? 'content-type: application/x-www-form-urlencoded' : 'content-type: application/json', '--data-binary', body);
  }
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

console.log('[1] build', API_TAG);
const b = local('docker', ['build', '--platform', 'linux/amd64', '-f', 'deploy/alpha/Dockerfile.api', '-t', API_TAG, '.']);
writeFileSync(join(ARTIFACT, 'm81a-notify-fix2-api-build.log'), `${b.stdout || ''}\n${b.stderr || ''}`.slice(-400000));
if (b.status !== 0) throw new Error('api build failed: ' + String(b.stderr || b.stdout || '').slice(-2000));

console.log('[2] save');
if (local('docker', ['save', '-o', tarLocal, API_TAG]).status !== 0) throw new Error('api save failed');
console.log('tar', statSync(tarLocal).size);

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
  if (r.exitCode !== 0) throw new Error(`${label}: ${(r.stderr || r.stdout || '').slice(0, 3000)}`);
  return r;
}
async function remote(cmd, timeoutMs = 60000) {
  return runner.execute(shellCommand(cmd), { timeoutMs });
}

await runner.writeTextFile(
  '/opt/launchos/tmp/m81a-preserve-arm-gates.sh',
  [
    '#!/bin/bash',
    'set -euo pipefail',
    'for f in /opt/launchos/config/alpha-api.env /opt/launchos/config/alpha-worker.env; do',
    '  [ -f "$f" ] || continue',
    '  if grep -q "^REAL_PAYMENTS_ENABLED=" "$f"; then sed -i "s/^REAL_PAYMENTS_ENABLED=.*/REAL_PAYMENTS_ENABLED=false/" "$f"; else echo "REAL_PAYMENTS_ENABLED=false" >> "$f"; fi',
    '  if grep -q "^ALIPAY_PRODUCTION_ENABLED=" "$f"; then sed -i "s/^ALIPAY_PRODUCTION_ENABLED=.*/ALIPAY_PRODUCTION_ENABLED=false/" "$f"; else echo "ALIPAY_PRODUCTION_ENABLED=false" >> "$f"; fi',
    '  if grep -q "^PAYMENT_TEST_REAL_ENABLED=" "$f"; then sed -i "s/^PAYMENT_TEST_REAL_ENABLED=.*/PAYMENT_TEST_REAL_ENABLED=true/" "$f"; else echo "PAYMENT_TEST_REAL_ENABLED=true" >> "$f"; fi',
    '  if grep -q "^ALIPAY_PRODUCTION_TEST_ENABLED=" "$f"; then sed -i "s/^ALIPAY_PRODUCTION_TEST_ENABLED=.*/ALIPAY_PRODUCTION_TEST_ENABLED=true/" "$f"; else echo "ALIPAY_PRODUCTION_TEST_ENABLED=true" >> "$f"; fi',
    '  if grep -q "^ALIPAY_SANDBOX_ONLY=" "$f"; then sed -i "s/^ALIPAY_SANDBOX_ONLY=.*/ALIPAY_SANDBOX_ONLY=false/" "$f"; else echo "ALIPAY_SANDBOX_ONLY=false" >> "$f"; fi',
    `  if grep -q "^ALIPAY_PRODUCTION_TEST_WORKSPACE_ID=" "$f"; then sed -i "s/^ALIPAY_PRODUCTION_TEST_WORKSPACE_ID=.*/ALIPAY_PRODUCTION_TEST_WORKSPACE_ID=${WS}/" "$f"; else echo "ALIPAY_PRODUCTION_TEST_WORKSPACE_ID=${WS}" >> "$f"; fi`,
    'done',
    "grep -E '^(REAL_PAYMENTS_ENABLED|PAYMENT_TEST_REAL_ENABLED|ALIPAY_PRODUCTION_TEST_ENABLED|ALIPAY_PRODUCTION_ENABLED|ALIPAY_SANDBOX_ONLY|ALIPAY_PRODUCTION_TEST_WORKSPACE_ID)=' /opt/launchos/config/alpha-api.env || true",
    '',
  ].join('\n'),
);
await remoteOk('chmod 700 /opt/launchos/tmp/m81a-preserve-arm-gates.sh && /opt/launchos/tmp/m81a-preserve-arm-gates.sh', 'preserve-gates', 30000);

console.log('[3] upload');
await runner.upload(tarLocal, tarRemote, { timeoutMs: 900000 });

console.log('[4] load + restart');
await remoteOk(
  `podman load -i ${tarRemote} && (podman tag docker.io/library/${API_TAG} ${API_REMOTE} 2>/dev/null || podman tag ${API_TAG} ${API_REMOTE} 2>/dev/null || true)`,
  'podman-load',
  300000,
);
await remoteOk(`/opt/launchos/bin/m5-run-api.sh launchos-alpha-api 39110 ${API_REMOTE}`, 'restart-api', 180000);

console.log('[5] wait health');
let apiReady = false;
for (let i = 0; i < 60; i++) {
  const probe = await remote('curl -sf --max-time 3 http://127.0.0.1:39110/api/v1/health || echo HEALTH_FAIL', 15000);
  const out = String(probe.stdout || '');
  if (probe.exitCode === 0 && !out.includes('HEALTH_FAIL')) {
    apiReady = true;
    console.log('api ready', i + 1, out.slice(0, 200));
    break;
  }
  if (i % 5 === 0) {
    const logs = await remote('podman logs --tail 25 launchos-alpha-api 2>&1 || true', 20000);
    console.log('waiting', i, out.slice(0, 80));
    console.log(String(logs.stdout || '').slice(-600));
  }
  await new Promise((r) => setTimeout(r, 5000));
}
if (!apiReady) {
  const logs = await remote('podman logs --tail 150 launchos-alpha-api 2>&1 || true', 30000);
  writeFileSync(join(ARTIFACT, 'm81a-notifyfix2-api-logs.txt'), String(logs.stdout || ''));
  throw new Error('api not ready');
}

const gates = await remoteOk(
  `grep -E '^(REAL_PAYMENTS_ENABLED|PAYMENT_TEST_REAL_ENABLED|ALIPAY_PRODUCTION_TEST_ENABLED|ALIPAY_PRODUCTION_ENABLED|ALIPAY_SANDBOX_ONLY|ALIPAY_PRODUCTION_TEST_WORKSPACE_ID)=' /opt/launchos/config/alpha-api.env || true`,
  'gates',
  15000,
);
console.log('GATES', String(gates.stdout || '').trim());

const formProbe = curl('https://api-alpha.zsaos.com/api/v1/payments/webhooks/alipay', 'api-alpha.zsaos.com', {
  method: 'POST',
  form: true,
  body: 'out_trade_no=PROBE-FORM-ONLY&trade_status=TRADE_SUCCESS&total_amount=0.90&sign=invalid',
  maxTime: '30',
});
console.log('FORM_PROBE', formProbe.status, formProbe.text.slice(0, 200));

const paymentsSql = `
SELECT p.id
 || '|' || p.status
 || '|' || COALESCE(p."merchantOrderNo",'')
 || '|' || CASE WHEN COALESCE(p."providerTradeNo",'')<>'' THEN '1' ELSE '0' END
 || '|' || COALESCE(p."amountCents"::text,'')
 || '|' || p."createdAt"::text
 || '|' || COALESCE(p."paidAt"::text,'')
 || '|' || COALESCE(p."lastQueryState",'')
 || '|' || COALESCE(p."failureCode",'')
FROM "Payment" p
JOIN "CommercialOrder" o ON o.id=p."orderId"
JOIN "Plan" pl ON pl.id=o."planId"
WHERE o."workspaceId"='${WS}'
  AND (pl.code='PAYMENT_TEST' OR p."isProductionTest"=true)
ORDER BY p."createdAt" DESC
LIMIT 10
`.replace(/\n/g, ' ');

const paymentsBefore = await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc ${JSON.stringify(paymentsSql)}`,
  'payments-before',
  20000,
);
console.log('PAYMENTS_BEFORE\n' + String(paymentsBefore.stdout || '').trim());

await runner.disconnect();

const adminAuth = JSON.parse(readFileSync(join(ARTIFACT, 'admin-auth.json'), 'utf8'));
const adminLogin = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: adminAuth.email, password: adminAuth.password }),
});
const adminToken = parse(adminLogin.text).accessToken;
if (!adminToken) throw new Error('admin login failed: ' + adminLogin.text.slice(0, 400));
const adminHdr = { authorization: `Bearer ${adminToken}` };

console.log('[6] reconcile');
const reconcile = curl('https://api-alpha.zsaos.com/api/v1/admin/payments/reconcile', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: adminHdr,
  body: '{}',
  maxTime: '180',
});
console.log('RECONCILE', reconcile.status, JSON.stringify(parse(reconcile.text)).slice(0, 1500));

// also try payment-test status sync endpoint if present
const paymentTestStatus = curl('https://api-alpha.zsaos.com/api/v1/admin/commercial/payment-test', 'api-alpha.zsaos.com', {
  headers: adminHdr,
  maxTime: '120',
});
console.log('PAYMENT_TEST_STATUS', paymentTestStatus.status, JSON.stringify(parse(paymentTestStatus.text)).slice(0, 1000));

await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername({ serverUsername: server.username, provider: server.provider }),
  password: decryptCredential(server.credentialEncrypted),
  readyTimeoutMs: 30000,
});
const paymentsAfter = await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc ${JSON.stringify(paymentsSql)}`,
  'payments-after',
  20000,
);
const lines = String(paymentsAfter.stdout || '')
  .trim()
  .split(/\r?\n/)
  .filter(Boolean);
console.log('PAYMENTS_AFTER');
for (const l of lines) console.log(l);

const webhookSql = `
SELECT e.id || '|' || COALESCE(e.status,'') || '|' || COALESCE(e."eventType",'') || '|' || COALESCE(e."errorCode",'') || '|' || e."receivedAt"::text
FROM "PaymentWebhookEvent" e
WHERE e.provider='ALIPAY'
ORDER BY e."receivedAt" DESC
LIMIT 15
`.replace(/\n/g, ' ');
let webhooks = '';
try {
  webhooks = String(
    (
      await remoteOk(
        `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc ${JSON.stringify(webhookSql)}`,
        'webhooks',
        20000,
      )
    ).stdout || '',
  ).trim();
} catch (e) {
  webhooks = String(e);
}
console.log('WEBHOOKS\n' + webhooks);

await runner.disconnect();

const succeeded = lines.filter((l) => l.includes('|SUCCEEDED|'));
const report = {
  gates: String(gates.stdout || '').trim(),
  formProbe: { status: formProbe.status, body: formProbe.text.slice(0, 200) },
  reconcile: { status: reconcile.status, body: parse(reconcile.text) },
  paymentTestStatus: { status: paymentTestStatus.status, body: parse(paymentTestStatus.text) },
  paymentsBefore: String(paymentsBefore.stdout || '').trim().split(/\r?\n/).filter(Boolean),
  paymentsAfter: lines,
  webhooks: webhooks.split(/\r?\n/).filter(Boolean),
  succeededCount: succeeded.length,
};
writeFileSync(join(ARTIFACT, 'm81a-notifyfix2-promote-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!succeeded.length) {
  console.error('NO_SUCCEEDED_PAYMENT_YET');
  process.exitCode = 3;
} else {
  console.log('SUCCEEDED_PAYMENT_FOUND=true');
}
await prisma.$disconnect();
