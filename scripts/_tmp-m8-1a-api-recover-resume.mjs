/**
 * Recover notify-form API image on alpha, preserve ARM gates, reconcile PAYMENT_TEST.
 * No new orders. No forge PAID.
 * node scripts/_tmp-m8-1a-api-recover-resume.mjs --confirm-resume
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

if (!process.argv.includes('--confirm-resume')) {
  console.error('pass --confirm-resume');
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
const tarLocal = join(ARTIFACT, 'launchos-alpha-api-m81a-notifyfix.tar');
const tarRemote = '/opt/launchos/tmp/launchos-alpha-api-m81a-notifyfix.tar';

function curl(url, host, opts = {}) {
  const { method = 'GET', headers = {}, body = null, maxTime = '90' } = opts;
  const args = ['-sS', '-L', '-X', method, '-w', '\n__STATUS__:%{http_code}', '--max-time', String(maxTime)];
  args.push('--resolve', `${host}:443:${TARGET_HOST}`);
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body != null) {
    if (opts.form) {
      args.push('-H', 'content-type: application/x-www-form-urlencoded', '--data-binary', body);
    } else {
      args.push('-H', 'content-type: application/json', '--data-binary', body);
    }
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

if (!existsSync(tarLocal)) throw new Error(`missing tar: ${tarLocal}`);
console.log('local tar', statSync(tarLocal).size);

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { id: 'cmuma9i480001rij49yv4yw2q' } });
if (!server) throw new Error('server not found');
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

console.log('[0] preflight');
const pre = await remote(
  `echo ===PS===; podman ps -a --format '{{.Names}} {{.Status}} {{.Image}}' | head -n 40; echo ===HEALTH===; curl -sf --max-time 3 http://127.0.0.1:39110/api/v1/health || echo HEALTH_FAIL; echo ===IMAGES===; podman images --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.Created}}' | grep m81 | head -n 20; echo ===TAR===; ls -lh /opt/launchos/tmp/launchos-alpha-api-m81a*.tar 2>/dev/null || echo NO_TAR; echo ===GATES===; grep -E '^(REAL_PAYMENTS_ENABLED|PAYMENT_TEST_REAL_ENABLED|ALIPAY_PRODUCTION_TEST_ENABLED|ALIPAY_PRODUCTION_ENABLED|ALIPAY_SANDBOX_ONLY|ALIPAY_PRODUCTION_TEST_WORKSPACE_ID)=' /opt/launchos/config/alpha-api.env || true`,
  60000,
);
console.log(String(pre.stdout || '').slice(0, 6000));
writeFileSync(join(ARTIFACT, 'm81a-recover-preflight.txt'), String(pre.stdout || '') + '\n' + String(pre.stderr || ''));

// Preserve ARM gates: REAL=false, PAYMENT_TEST_REAL=true
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

const remoteTarCheck = await remote(`test -f ${tarRemote} && ls -lh ${tarRemote} || echo NEED_UPLOAD`);
const needUpload = String(remoteTarCheck.stdout || '').includes('NEED_UPLOAD');
if (needUpload) {
  console.log('[1] re-upload notifyform tar');
  await runner.upload(tarLocal, tarRemote, { timeoutMs: 900000 });
} else {
  console.log('[1] remote tar present, skip upload');
  console.log(String(remoteTarCheck.stdout || '').trim());
}

console.log('[2] load image');
await remoteOk(
  `podman load -i ${tarRemote} && (podman tag docker.io/library/${API_TAG} ${API_REMOTE} 2>/dev/null || podman tag ${API_TAG} ${API_REMOTE} 2>/dev/null || true) && ls -lh ${tarRemote}`,
  'podman-load',
  300000,
);

console.log('[3] restart api with m81pay image');
await remoteOk(`/opt/launchos/bin/m5-run-api.sh launchos-alpha-api 39110 ${API_REMOTE}`, 'restart-api', 180000);

console.log('[4] wait health');
let apiReady = false;
let lastHealth = '';
for (let i = 0; i < 60; i++) {
  const probe = await remote('curl -sf --max-time 3 http://127.0.0.1:39110/api/v1/health || echo HEALTH_FAIL', 15000);
  lastHealth = String(probe.stdout || '').trim();
  if (probe.exitCode === 0 && !lastHealth.includes('HEALTH_FAIL')) {
    apiReady = true;
    console.log('api ready at attempt', i + 1, lastHealth.slice(0, 200));
    break;
  }
  const logs = await remote('podman logs --tail 30 launchos-alpha-api 2>&1 || true', 20000);
  if (i % 5 === 0) {
    console.log('waiting', i, lastHealth.slice(0, 120));
    console.log(String(logs.stdout || '').slice(-800));
  }
  await new Promise((r) => setTimeout(r, 5000));
}
if (!apiReady) {
  const logs = await remote('podman logs --tail 120 launchos-alpha-api 2>&1 || true', 30000);
  writeFileSync(join(ARTIFACT, 'm81a-recover-api-logs.txt'), String(logs.stdout || '') + '\n' + String(logs.stderr || ''));
  throw new Error('api not ready: ' + lastHealth.slice(0, 500));
}

const gates = await remoteOk(
  `grep -E '^(REAL_PAYMENTS_ENABLED|PAYMENT_TEST_REAL_ENABLED|ALIPAY_PRODUCTION_TEST_ENABLED|ALIPAY_PRODUCTION_ENABLED|ALIPAY_SANDBOX_ONLY|ALIPAY_PRODUCTION_TEST_WORKSPACE_ID)=' /opt/launchos/config/alpha-api.env || true`,
  'gates',
  15000,
);
console.log('GATES', String(gates.stdout || '').trim());

// Form notify probe (should not 400 JSON validation)
console.log('[5] form notify probe');
const formProbe = curl('https://api-alpha.zsaos.com/api/v1/payments/webhooks/alipay', 'api-alpha.zsaos.com', {
  method: 'POST',
  form: true,
  body: 'out_trade_no=PROBE-FORM-ONLY&trade_status=TRADE_SUCCESS&total_amount=0.90&sign=invalid',
  maxTime: '30',
});
console.log('FORM_PROBE_STATUS', formProbe.status, formProbe.text.slice(0, 300));

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
 || '|' || COALESCE(pl.code,'')
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
const paymentLines = String(payments.stdout || '')
  .trim()
  .split(/\r?\n/)
  .filter(Boolean);
console.log('PAYMENTS');
for (const line of paymentLines) console.log(line);

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
console.log('RECONCILE', reconcile.status, JSON.stringify(parse(reconcile.text)).slice(0, 1000));

// Re-inspect payments after reconcile via SSH again
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername({ serverUsername: server.username, provider: server.provider }),
  password: decryptCredential(server.credentialEncrypted),
  readyTimeoutMs: 30000,
});
const payments2 = await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc ${JSON.stringify(paymentsSql)}`,
  'payments-after',
  20000,
);
const paymentLines2 = String(payments2.stdout || '')
  .trim()
  .split(/\r?\n/)
  .filter(Boolean);
console.log('PAYMENTS_AFTER_RECONCILE');
for (const line of paymentLines2) console.log(line);

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
} catch (e) {
  webhooks = { stdout: String(e) };
}
console.log('WEBHOOKS');
console.log(String(webhooks.stdout || '').trim());

await runner.disconnect();

const succeeded = paymentLines2.filter((l) => l.includes('|SUCCEEDED|') || l.includes('|PAID|'));
const out = {
  formProbe: { status: formProbe.status, body: formProbe.text.slice(0, 300) },
  gates: String(gates.stdout || '').trim(),
  paymentsBefore: paymentLines,
  paymentsAfter: paymentLines2,
  reconcile: { status: reconcile.status, body: parse(reconcile.text) },
  webhooks: String(webhooks.stdout || '').trim().split(/\r?\n/).filter(Boolean),
  succeededCount: succeeded.length,
};
writeFileSync(join(ARTIFACT, 'm81a-recover-resume-report.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));

if (!succeeded.length) {
  console.error('NO_SUCCEEDED_PAYMENT_YET');
  process.exitCode = 3;
} else {
  console.log('SUCCEEDED_PAYMENT_FOUND=true');
}

await prisma.$disconnect();
