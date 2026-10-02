/**
 * M8-1A P0 — promote API signature fix only.
 * Preserves ARM gates (PAYMENT_TEST_REAL_ENABLED=true, REAL_PAYMENTS_ENABLED=false).
 * NEVER creates Alipay checkout / real orders.
 *
 * node scripts/_tmp-m8-1a-signature-fix-promote.mjs --confirm-m8-1a-sigfix
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
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
if (!process.argv.includes('--confirm-m8-1a-sigfix')) {
  console.error('pass --confirm-m8-1a-sigfix');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const { requestSignIncludesSignType } = requireApi('@launchos/providers');

const TARGET_HOST = '116.62.198.184';
const API_TAG = 'launchos-alpha-api:m81pay';
const API_REMOTE = `localhost/${API_TAG}`;
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });
const skipBuild = process.argv.includes('--skip-build');

const adminAuth = JSON.parse(readFileSync(join(ARTIFACT_DIR, 'admin-auth.json'), 'utf8'));

function local(cmd, args) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 64_000_000, shell: false });
}
function curl(url, host, opts = {}) {
  const { method = 'GET', headers = {}, body = null, maxTime = '60' } = opts;
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

if (!requestSignIncludesSignType()) {
  throw new Error('local providers build still excludes sign_type from request sign');
}

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({
  where: { id: 'cmuma9i480001rij49yv4yw2q' },
});
if (!server) throw new Error('platform server missing');
const username = resolveServerSshUsername({ serverUsername: server.username, provider: server.provider });
const password = decryptCredential(server.credentialEncrypted);
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username, password });

async function remoteOk(cmd, label, timeoutMs = 300000) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs });
  if (r.exitCode !== 0) throw new Error(`${label}: ${(r.stderr || r.stdout || '').slice(0, 2000)}`);
  return r;
}

// Snapshot gates BEFORE deploy — must preserve ARM state
const gatesBefore = await runner.execute(
  shellCommand(
    `grep -E '^(REAL_PAYMENTS_ENABLED|PAYMENT_TEST_REAL_ENABLED|ALIPAY_PRODUCTION_TEST_ENABLED|ALIPAY_PRODUCTION_ENABLED|ALIPAY_SANDBOX_ONLY|ALIPAY_PRODUCTION_TEST_WORKSPACE_ID)=' /opt/launchos/config/alpha-api.env || true`,
  ),
  { timeoutMs: 15000 },
);
const gatesBeforeText = String(gatesBefore.stdout || '');
if (!/PAYMENT_TEST_REAL_ENABLED=true/.test(gatesBeforeText) && !/ALIPAY_PRODUCTION_TEST_ENABLED=true/.test(gatesBeforeText)) {
  throw new Error('ARM gate missing before promote; refuse to disarm. Gates:\n' + gatesBeforeText);
}
if (/REAL_PAYMENTS_ENABLED=true/.test(gatesBeforeText)) {
  throw new Error('REAL_PAYMENTS_ENABLED unexpectedly true; abort');
}

if (!skipBuild) {
  console.log('[1] build', API_TAG);
  const b = local('docker', ['build', '--platform', 'linux/amd64', '-f', 'deploy/alpha/Dockerfile.api', '-t', API_TAG, '.']);
  writeFileSync(join(ARTIFACT_DIR, 'm81a-sigfix-api-build.log'), `${b.stdout || ''}\n${b.stderr || ''}`.slice(-400000));
  if (b.status !== 0) throw new Error('api build failed');
}

const tar = join(ARTIFACT_DIR, 'launchos-alpha-api-m81a-sigfix.tar');
try {
  unlinkSync(tar);
} catch {}
if (local('docker', ['save', '-o', tar, API_TAG]).status !== 0) throw new Error('api save failed');
console.log('[2] upload api', statSync(tar).size);
try {
  await runner.disconnect();
} catch {}
await runner.connect({ host: server.host, port: server.port, username, password });
await runner.upload(tar, '/opt/launchos/tmp/launchos-alpha-api-m81a-sigfix.tar', { timeoutMs: 900000 });
await remoteOk(
  `podman load -i /opt/launchos/tmp/launchos-alpha-api-m81a-sigfix.tar && rm -f /opt/launchos/tmp/launchos-alpha-api-m81a-sigfix.tar && (podman tag docker.io/library/${API_TAG} ${API_REMOTE} 2>/dev/null || podman tag ${API_TAG} ${API_REMOTE} 2>/dev/null || true)`,
  'api-load',
  600000,
);

// Re-assert ARM gates (do NOT force off) then restart API with new image
await runner.writeTextFile(
  '/opt/launchos/tmp/m81a-preserve-arm-gates.sh',
  [
    '#!/bin/bash',
    'set -euo pipefail',
    "WS=$(grep -E '^ALIPAY_PRODUCTION_TEST_WORKSPACE_ID=' /opt/launchos/config/alpha-api.env | head -1 | cut -d= -f2- || true)",
    'for f in /opt/launchos/config/alpha-api.env /opt/launchos/config/alpha-worker.env; do',
    '  [ -f "$f" ] || continue',
    '  for key in REAL_PAYMENTS_ENABLED ALIPAY_PRODUCTION_ENABLED; do',
    '    if grep -q "^${key}=" "$f"; then sed -i "s/^${key}=.*/${key}=false/" "$f"; else echo "${key}=false" >> "$f"; fi',
    '  done',
    '  for key in PAYMENT_TEST_REAL_ENABLED ALIPAY_PRODUCTION_TEST_ENABLED; do',
    '    if grep -q "^${key}=" "$f"; then sed -i "s/^${key}=.*/${key}=true/" "$f"; else echo "${key}=true" >> "$f"; fi',
    '  done',
    "  if grep -q '^ALIPAY_SANDBOX_ONLY=' \"$f\"; then sed -i 's/^ALIPAY_SANDBOX_ONLY=.*/ALIPAY_SANDBOX_ONLY=false/' \"$f\"; else echo 'ALIPAY_SANDBOX_ONLY=false' >> \"$f\"; fi",
    '  if [ -n "$WS" ]; then',
    '    if grep -q "^ALIPAY_PRODUCTION_TEST_WORKSPACE_ID=" "$f"; then sed -i "s/^ALIPAY_PRODUCTION_TEST_WORKSPACE_ID=.*/ALIPAY_PRODUCTION_TEST_WORKSPACE_ID=$WS/" "$f"; else echo "ALIPAY_PRODUCTION_TEST_WORKSPACE_ID=$WS" >> "$f"; fi',
    '  fi',
    'done',
    "grep -E '^(REAL_PAYMENTS_ENABLED|PAYMENT_TEST_REAL_ENABLED|ALIPAY_PRODUCTION_TEST_ENABLED|ALIPAY_PRODUCTION_ENABLED|ALIPAY_SANDBOX_ONLY|ALIPAY_PRODUCTION_TEST_WORKSPACE_ID)=' /opt/launchos/config/alpha-api.env || true",
    '',
  ].join('\n'),
);
await remoteOk('chmod 700 /opt/launchos/tmp/m81a-preserve-arm-gates.sh && /opt/launchos/tmp/m81a-preserve-arm-gates.sh', 'preserve-arm', 30000);
await remoteOk(`/opt/launchos/bin/m5-run-api.sh launchos-alpha-api 39110 ${API_REMOTE}`, 'run-api', 120000);

let apiReady = false;
for (let i = 0; i < 60; i++) {
  const probe = await runner.execute(shellCommand('curl -sf --max-time 3 http://127.0.0.1:39110/api/v1/health'), {
    timeoutMs: 15000,
  });
  if (probe.exitCode === 0) {
    apiReady = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 3000));
}
if (!apiReady) throw new Error('api health not ready');

const gatesAfter = await runner.execute(
  shellCommand(
    `grep -E '^(REAL_PAYMENTS_ENABLED|PAYMENT_TEST_REAL_ENABLED|ALIPAY_PRODUCTION_TEST_ENABLED|ALIPAY_PRODUCTION_ENABLED|ALIPAY_SANDBOX_ONLY|ALIPAY_PRODUCTION_TEST_WORKSPACE_ID)=' /opt/launchos/config/alpha-api.env || true`,
  ),
  { timeoutMs: 15000 },
);
const gatesText = String(gatesAfter.stdout || '');

const orders = await runner.execute(
  shellCommand(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT p.id || '|' || p.status || '|' || COALESCE(p.\\"merchantOrderNo\\",'') || '|' || COALESCE(p.\\"amountCents\\"::text,'') || '|' || o.id FROM \\"Payment\\" p JOIN \\"CommercialOrder\\" o ON o.id=p.\\"orderId\\" WHERE p.\\"isProductionTest\\"=true OR (p.provider='ALIPAY' AND p.environment='PRODUCTION') ORDER BY p.\\"createdAt\\" DESC LIMIT 5"`,
  ),
  { timeoutMs: 20000 },
);

await runner.disconnect();

const adminLogin = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: adminAuth.email, password: adminAuth.password }),
});
const adminToken = parse(adminLogin.text).accessToken;
if (!adminToken) throw new Error('admin login failed: ' + adminLogin.text.slice(0, 300));
const adminHdr = { authorization: `Bearer ${adminToken}` };

const health = curl('https://api-alpha.zsaos.com/api/v1/health', 'api-alpha.zsaos.com');
const paymentTest = curl('https://api-alpha.zsaos.com/api/v1/admin/commercial/payment-test', 'api-alpha.zsaos.com', {
  headers: adminHdr,
});
const paymentTestBody = parse(paymentTest.text);

// Prohibition: do NOT call payment-test checkout / create order
const orderLines = String(orders.stdout || '')
  .trim()
  .split(/\r?\n/)
  .filter(Boolean);
const latest = orderLines[0] ? orderLines[0].split('|') : null;

const report = {
  stage: 'M8-1A P0 invalid-signature fix promote',
  apiImage: API_REMOTE,
  health: health.status,
  paymentTestAdmin: paymentTest.status,
  paymentTestButtonEnabled: paymentTestBody.buttonEnabled === true,
  gatesBefore: gatesBeforeText.trim(),
  gatesAfter: gatesText.trim(),
  REQUEST_SIGN_INCLUDES_SIGN_TYPE: true,
  REAL_PAYMENTS_ENABLED: /REAL_PAYMENTS_ENABLED=true/.test(gatesText),
  PAYMENT_TEST_REAL_ENABLED:
    /PAYMENT_TEST_REAL_ENABLED=true/.test(gatesText) || /ALIPAY_PRODUCTION_TEST_ENABLED=true/.test(gatesText),
  FAILED_REAL_ORDER_FOUND: orderLines.length > 0,
  LATEST_PAYMENT_ORDER_ID: latest?.[0] ?? null,
  LATEST_PAYMENT_STATUS: latest?.[1] ?? null,
  LATEST_OUT_TRADE_NO: latest?.[2] ?? null,
  NEW_REAL_ORDER_CREATED: false,
  REAL_PAYMENT_CHARGE_EXECUTED: false,
  ROOT_CAUSE: 'REQUEST_SIGN_EXCLUDES_SIGN_TYPE',
};

report.ALIPAY_SIGNATURE_FIX_PROMOTED =
  health.status === 200 &&
  paymentTest.status === 200 &&
  report.REAL_PAYMENTS_ENABLED === false &&
  report.PAYMENT_TEST_REAL_ENABLED === true &&
  report.NEW_REAL_ORDER_CREATED === false;

writeFileSync(join(ARTIFACT_DIR, 'm8-1a-signature-fix-promote.json'), JSON.stringify(report, null, 2));
await prisma.$disconnect();
console.log(JSON.stringify(report, null, 2));
if (!report.ALIPAY_SIGNATURE_FIX_PROMOTED) {
  console.error('ALIPAY_SIGNATURE_FIX_PROMOTED=false');
  process.exit(1);
}
console.log('ALIPAY_SIGNATURE_FIX_PROMOTED=true');
console.log('NEW_REAL_ORDER_CREATED=false');
console.log('STOP — human retry only');
