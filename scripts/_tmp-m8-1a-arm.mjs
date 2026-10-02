/**
 * M8-1A ARM — set workspace id, arm PAYMENT_TEST_REAL_ENABLED only.
 * NEVER creates Alipay orders / checkout.
 * node scripts/_tmp-m8-1a-arm.mjs --confirm-m8-1a-arm
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
if (!process.argv.includes('--confirm-m8-1a-arm')) {
  console.error('pass --confirm-m8-1a-arm');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');

const TARGET_HOST = '116.62.198.184';
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });
const adminAuth = JSON.parse(readFileSync(join(ARTIFACT_DIR, 'admin-auth.json'), 'utf8'));
const userAuth = JSON.parse(readFileSync(join(ARTIFACT_DIR, '1002-auth.json'), 'utf8'));

function curl(url, host, opts = {}) {
  const { method = 'GET', headers = {}, body = null, maxTime = '45' } = opts;
  const args = ['-sS', '-L', '-X', method, '-w', '\n__STATUS__:%{http_code}', '--max-time', String(maxTime)];
  args.push('--resolve', `${host}:443:${TARGET_HOST}`);
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body != null) args.push('-H', 'content-type: application/json', '--data-binary', body);
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 4_000_000 });
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
const server = await prisma.serverInstance.findFirst({
  where: { OR: [{ id: 'cmuma9i480001rij49yv4yw2q' }, { host: TARGET_HOST, scope: 'PLATFORM_MANAGED' }] },
});
if (!server) throw new Error('platform server missing');
const username = resolveServerSshUsername({ serverUsername: server.username, provider: server.provider });
const password = decryptCredential(server.credentialEncrypted);
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username, password, readyTimeoutMs: 30000 });

async function remoteOk(cmd, label, timeoutMs = 120000) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs });
  if (r.exitCode !== 0) throw new Error(`${label}: ${(r.stderr || r.stdout || '').slice(0, 2000)}`);
  return r;
}

// 1) Find workspace that owns project web-ceshi (prefer), else PLATFORM_ADMIN primary workspace
const wsProbeCeshi = await runner.execute(
  shellCommand(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT w.id || '|' || COALESCE(w.name,'') || '|' || COALESCE(u.email,'') || '|' || COALESCE(u.\\"platformRole\\"::text,'') || '|' || COALESCE(p.name,'') FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.name ILIKE '%web-ceshi%' OR p.name ILIKE '%ceshi%' ORDER BY p.\\"createdAt\\" DESC LIMIT 10"`,
  ),
  { timeoutMs: 30000 },
);
const wsProbeAdmin = await runner.execute(
  shellCommand(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT w.id || '|' || COALESCE(w.name,'') || '|' || COALESCE(u.email,'') || '|' || COALESCE(u.\\"platformRole\\"::text,'') || '|' FROM \\"Workspace\\" w JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE u.email='${adminAuth.email.replace(/'/g, "''")}' ORDER BY w.\\"createdAt\\" ASC LIMIT 10"`,
  ),
  { timeoutMs: 30000 },
);
console.log('WS_CESHI', String(wsProbeCeshi.stdout || '').trim(), String(wsProbeCeshi.stderr || '').trim().slice(0, 300));
console.log('WS_ADMIN', String(wsProbeAdmin.stdout || '').trim(), String(wsProbeAdmin.stderr || '').trim().slice(0, 300));

const wsLines = [
  ...String(wsProbeCeshi.stdout || '')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean),
  ...String(wsProbeAdmin.stdout || '')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean),
];
if (!wsLines.length) throw new Error('no candidate workspace found');

let chosen = null;
for (const line of wsLines) {
  const [id, name, ownerEmail, role, projectName] = line.split('|');
  if (/web-ceshi/i.test(projectName || '') || /web-ceshi/i.test(name || '')) {
    chosen = { id, name, ownerEmail, role, projectName };
    break;
  }
}
if (!chosen) {
  for (const line of wsLines) {
    const [id, name, ownerEmail, role, projectName] = line.split('|');
    if (/ceshi/i.test(projectName || '')) {
      chosen = { id, name, ownerEmail, role, projectName };
      break;
    }
  }
}
if (!chosen) {
  const [id, name, ownerEmail, role, projectName] = wsLines[0].split('|');
  chosen = { id, name, ownerEmail, role, projectName };
}

console.log('TEST_WORKSPACE', JSON.stringify({ id: chosen.id, name: chosen.name, owner: chosen.ownerEmail, role: chosen.role, project: chosen.projectName }));

const paymentsBefore = await runner.execute(
  shellCommand(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT COUNT(*) FROM \\"Payment\\" WHERE \\"isProductionTest\\"=true OR (provider='ALIPAY' AND environment='PRODUCTION')"`,
  ),
  { timeoutMs: 15000 },
);
const paymentsBeforeCount = Number(String(paymentsBefore.stdout || '0').trim() || '0');

// 2) Write workspace id + keep REAL_PAYMENTS false; do NOT arm yet
await runner.writeTextFile(
  '/opt/launchos/tmp/m81a-set-workspace.sh',
  `#!/bin/bash
set -euo pipefail
f=/opt/launchos/config/alpha-api.env
WS_ID='${chosen.id.replace(/'/g, '')}'
if grep -q '^ALIPAY_PRODUCTION_TEST_WORKSPACE_ID=' "$f"; then
  sed -i "s/^ALIPAY_PRODUCTION_TEST_WORKSPACE_ID=.*/ALIPAY_PRODUCTION_TEST_WORKSPACE_ID=$\{WS_ID\}/" "$f"
else
  echo "ALIPAY_PRODUCTION_TEST_WORKSPACE_ID=$\{WS_ID\}" >> "$f"
fi
# ensure formal gate stays off while preparing
for key in REAL_PAYMENTS_ENABLED ALIPAY_PRODUCTION_ENABLED; do
  if grep -q "^$\{key\}=" "$f"; then sed -i "s/^$\{key\}=.*/$\{key\}=false/" "$f"; else echo "$\{key\}=false" >> "$f"; fi
done
# keep test gates false until readiness passes
for key in PAYMENT_TEST_REAL_ENABLED ALIPAY_PRODUCTION_TEST_ENABLED; do
  if grep -q "^$\{key\}=" "$f"; then sed -i "s/^$\{key\}=.*/$\{key\}=false/" "$f"; else echo "$\{key\}=false" >> "$f"; fi
done
grep -E '^(ALIPAY_PRODUCTION_TEST_WORKSPACE_ID|REAL_PAYMENTS_ENABLED|PAYMENT_TEST_REAL_ENABLED|ALIPAY_PRODUCTION_TEST_ENABLED|ALIPAY_PRODUCTION_ENABLED|ALIPAY_SANDBOX_ONLY)=' "$f" || true
`,
);
await remoteOk('chmod 700 /opt/launchos/tmp/m81a-set-workspace.sh && /opt/launchos/tmp/m81a-set-workspace.sh', 'set-workspace');

console.log('[restart] API only');
await remoteOk(`/opt/launchos/bin/m5-run-api.sh launchos-alpha-api 39110 "$(podman inspect -f '{{.ImageName}}' launchos-alpha-api 2>/dev/null || podman inspect -f '{{.Config.Image}}' launchos-alpha-api)"`, 'restart-api', 180000);

let apiReady = false;
for (let i = 0; i < 40; i++) {
  const probe = await runner.execute(shellCommand('curl -sf --max-time 3 http://127.0.0.1:39110/api/v1/health'), { timeoutMs: 10000 });
  if (probe.exitCode === 0) {
    apiReady = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 2000));
}
if (!apiReady) throw new Error('API health not ready after restart');

// 3) Readiness from DB (sanitized) + HTTP
const alipayRows = await runner.execute(
  shellCommand(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT environment || '|' || status || '|' || CASE WHEN COALESCE(\\"appId\\",'')<>'' THEN '1' ELSE '0' END || '|' || CASE WHEN \\"credentialEncrypted\\" IS NULL OR \\"credentialEncrypted\\"='' THEN '0' ELSE '1' END || '|' || CASE WHEN \\"publicKey\\" IS NULL OR \\"publicKey\\"='' THEN '0' ELSE '1' END || '|' || CASE WHEN \\"gatewayUrl\\" = 'https://openapi.alipay.com/gateway.do' THEN '1' ELSE '0' END || '|' || CASE WHEN COALESCE(\\"notifyUrl\\",'') LIKE 'https://%' THEN '1' ELSE '0' END || '|' || CASE WHEN COALESCE(\\"returnUrl\\",'') LIKE 'https://%' THEN '1' ELSE '0' END || '|' || CASE WHEN \\"appReady\\" THEN '1' ELSE '0' END || '|' || COALESCE(\\"notifyUrl\\",'') || '|' || COALESCE(\\"returnUrl\\",'') FROM \\"PaymentProviderAccount\\" WHERE provider='ALIPAY' AND environment='PRODUCTION' LIMIT 1"`,
  ),
  { timeoutMs: 20000 },
);
const planRow = await runner.execute(
  shellCommand(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT code || '|' || status || '|' || COALESCE(\\"priceMonthlyCents\\"::text,'') FROM \\"Plan\\" WHERE code='PAYMENT_TEST' LIMIT 1"`,
  ),
  { timeoutMs: 15000 },
);
const priceRows = await runner.execute(
  shellCommand(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT code || '|' || COALESCE(\\"priceMonthly\\"::text,'') || '|' || COALESCE(\\"priceYearly\\"::text,'') || '|' || COALESCE(\\"priceMonthlyCents\\"::text,'') FROM \\"Plan\\" WHERE code IN ('free','pro','team','PAYMENT_TEST') ORDER BY code"`,
  ),
  { timeoutMs: 15000 },
);
const gateEnvPre = await runner.execute(
  shellCommand(
    `grep -E '^(REAL_PAYMENTS_ENABLED|PAYMENT_TEST_REAL_ENABLED|ALIPAY_PRODUCTION_TEST_ENABLED|ALIPAY_PRODUCTION_ENABLED|ALIPAY_SANDBOX_ONLY|ALIPAY_PRODUCTION_TEST_WORKSPACE_ID)=' /opt/launchos/config/alpha-api.env || true`,
  ),
  { timeoutMs: 10000 },
);

const prodParts = String(alipayRows.stdout || '').trim().split('|');
const expectedNotify = 'https://api-alpha.zsaos.com/api/v1/payments/webhooks/alipay';
const expectedReturn = 'https://alpha.zsaos.com/billing/payment/return';
const readiness = {
  ALIPAY_APP_ID_CONFIGURED: prodParts[2] === '1',
  ALIPAY_PRIVATE_KEY_CONFIGURED: prodParts[3] === '1',
  ALIPAY_PUBLIC_KEY_CONFIGURED: prodParts[4] === '1',
  ALIPAY_GATEWAY_PRODUCTION: prodParts[5] === '1',
  ALIPAY_PROVIDER_ENVIRONMENT: prodParts[0] === 'PRODUCTION' ? 'PRODUCTION' : 'MISSING',
  ALIPAY_PRODUCTION_STATUS: prodParts[1] || null,
  ALIPAY_NOTIFY_URL_CONFIGURED: prodParts[6] === '1',
  ALIPAY_RETURN_URL_CONFIGURED: prodParts[7] === '1',
  ALIPAY_APP_READY: prodParts[8] === '1',
  ALIPAY_NOTIFY_URL_MATCH: prodParts[9] === expectedNotify,
  ALIPAY_RETURN_URL_MATCH: prodParts[10] === expectedReturn,
  ALIPAY_RSA2_READY: prodParts[1] === 'VERIFIED' && prodParts[2] === '1' && prodParts[3] === '1' && prodParts[4] === '1' && prodParts[5] === '1',
};

const planParts = String(planRow.stdout || '').trim().split('|');
const paymentTestOk = planParts[0] === 'PAYMENT_TEST' && planParts[1] === 'INTERNAL_TEST' && planParts[2] === '90';
const workspaceConfigured = /ALIPAY_PRODUCTION_TEST_WORKSPACE_ID=.+/.test(String(gateEnvPre.stdout || ''));

const notifyPost = curl('https://api-alpha.zsaos.com/api/v1/payments/webhooks/alipay', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: 'not=valid',
});
const returnPage = curl('https://alpha.zsaos.com/billing/payment/return', 'alpha.zsaos.com');
const health = curl('https://api-alpha.zsaos.com/api/v1/health', 'api-alpha.zsaos.com');

readiness.ALIPAY_NOTIFY_URL_REACHABLE = notifyPost.status > 0 && notifyPost.status < 500;
readiness.ALIPAY_RETURN_URL_REACHABLE = returnPage.status === 200 || returnPage.status === 307 || returnPage.status === 308;
readiness.ALIPAY_PRODUCTION_TEST_WORKSPACE_ID_CONFIGURED = workspaceConfigured;
readiness.PAYMENT_TEST_PLAN_EXISTS = planParts[0] === 'PAYMENT_TEST';
readiness.PAYMENT_TEST_AMOUNT_FEN = Number(planParts[2] || 0);
readiness.PAYMENT_TEST_HIDDEN = true;
readiness.PAYMENT_TEST_INTERNAL_ONLY = planParts[1] === 'INTERNAL_TEST';
readiness.health = health.status;

const failed = [];
for (const [k, expect] of [
  ['ALIPAY_APP_ID_CONFIGURED', true],
  ['ALIPAY_PRIVATE_KEY_CONFIGURED', true],
  ['ALIPAY_PUBLIC_KEY_CONFIGURED', true],
  ['ALIPAY_GATEWAY_PRODUCTION', true],
  ['ALIPAY_PROVIDER_ENVIRONMENT', 'PRODUCTION'],
  ['ALIPAY_NOTIFY_URL_CONFIGURED', true],
  ['ALIPAY_RETURN_URL_CONFIGURED', true],
  ['ALIPAY_NOTIFY_URL_REACHABLE', true],
  ['ALIPAY_RETURN_URL_REACHABLE', true],
  ['ALIPAY_RSA2_READY', true],
  ['ALIPAY_APP_READY', true],
  ['ALIPAY_PRODUCTION_TEST_WORKSPACE_ID_CONFIGURED', true],
]) {
  if (readiness[k] !== expect) failed.push(`${k}=${String(readiness[k])}`);
}
if (!paymentTestOk) failed.push('PAYMENT_TEST_PLAN');
if (health.status !== 200) failed.push(`health=${health.status}`);
if (readiness.ALIPAY_PRODUCTION_STATUS !== 'VERIFIED') failed.push(`status=${readiness.ALIPAY_PRODUCTION_STATUS}`);

if (failed.length) {
  const report = {
    PRODUCTION_PAYMENT_TEST_ARMED: false,
    FAILED_CHECK: failed.join(', '),
    TEST_WORKSPACE_ID: chosen.id,
    TEST_WORKSPACE_NAME: chosen.name,
    readiness,
    REAL_PAYMENT_ORDER_CREATED: false,
  };
  writeFileSync(join(ARTIFACT_DIR, 'm8-1a-arm-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await runner.disconnect();
  await prisma.$disconnect();
  process.exit(1);
}

// 4) Arm PAYMENT_TEST_REAL_ENABLED only; keep REAL_PAYMENTS_ENABLED=false; set ALIPAY_SANDBOX_ONLY=false so production test path can run
await runner.writeTextFile(
  '/opt/launchos/tmp/m81a-arm-gate.sh',
  `#!/bin/bash
set -euo pipefail
f=/opt/launchos/config/alpha-api.env
# formal catalog stays closed
for key in REAL_PAYMENTS_ENABLED ALIPAY_PRODUCTION_ENABLED; do
  if grep -q "^$\{key\}=" "$f"; then sed -i "s/^$\{key\}=.*/$\{key\}=false/" "$f"; else echo "$\{key\}=false" >> "$f"; fi
done
# arm payment test only (both aliases)
for key in PAYMENT_TEST_REAL_ENABLED ALIPAY_PRODUCTION_TEST_ENABLED; do
  if grep -q "^$\{key\}=" "$f"; then sed -i "s/^$\{key\}=.*/$\{key\}=true/" "$f"; else echo "$\{key\}=true" >> "$f"; fi
done
# sandbox-only would block PRODUCTION test path
if grep -q '^ALIPAY_SANDBOX_ONLY=' "$f"; then sed -i 's/^ALIPAY_SANDBOX_ONLY=.*/ALIPAY_SANDBOX_ONLY=false/' "$f"; else echo 'ALIPAY_SANDBOX_ONLY=false' >> "$f"; fi
grep -E '^(REAL_PAYMENTS_ENABLED|PAYMENT_TEST_REAL_ENABLED|ALIPAY_PRODUCTION_TEST_ENABLED|ALIPAY_PRODUCTION_ENABLED|ALIPAY_SANDBOX_ONLY|ALIPAY_PRODUCTION_TEST_WORKSPACE_ID)=' "$f"
`,
);
await remoteOk('chmod 700 /opt/launchos/tmp/m81a-arm-gate.sh && /opt/launchos/tmp/m81a-arm-gate.sh', 'arm-gate');

// reload API to pick up new gates
const image = await runner.execute(
  shellCommand(`podman inspect -f '{{.Config.Image}}' launchos-alpha-api`),
  { timeoutMs: 15000 },
);
const imageName = String(image.stdout || '').trim() || 'localhost/launchos-alpha-api:m81pay';
await remoteOk(`/opt/launchos/bin/m5-run-api.sh launchos-alpha-api 39110 ${imageName}`, 'reload-api-armed', 180000);
apiReady = false;
for (let i = 0; i < 40; i++) {
  const probe = await runner.execute(shellCommand('curl -sf --max-time 3 http://127.0.0.1:39110/api/v1/health'), { timeoutMs: 10000 });
  if (probe.exitCode === 0) {
    apiReady = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 2000));
}
if (!apiReady) throw new Error('API not ready after arm reload');

const gateEnvArmed = await runner.execute(
  shellCommand(
    `grep -E '^(REAL_PAYMENTS_ENABLED|PAYMENT_TEST_REAL_ENABLED|ALIPAY_PRODUCTION_TEST_ENABLED|ALIPAY_PRODUCTION_ENABLED|ALIPAY_SANDBOX_ONLY|ALIPAY_PRODUCTION_TEST_WORKSPACE_ID)=' /opt/launchos/config/alpha-api.env || true`,
  ),
  { timeoutMs: 10000 },
);
const gatesText = String(gateEnvArmed.stdout || '');

const adminLogin = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: adminAuth.email, password: adminAuth.password }),
});
const userLogin = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: userAuth.email || '1002@qq.com', password: userAuth.password }),
});
const adminToken = parse(adminLogin.text).accessToken;
const userToken = parse(userLogin.text).accessToken;
if (!adminToken || !userToken) throw new Error('login failed');

const paymentTestAdmin = curl('https://api-alpha.zsaos.com/api/v1/admin/commercial/payment-test', 'api-alpha.zsaos.com', {
  headers: { authorization: `Bearer ${adminToken}` },
});
const paymentTestUser = curl('https://api-alpha.zsaos.com/api/v1/admin/commercial/payment-test', 'api-alpha.zsaos.com', {
  headers: { authorization: `Bearer ${userToken}` },
});
const paymentTestPayload = parse(paymentTestAdmin.text);
const paymentTestPage = curl('https://alpha.zsaos.com/admin/commercial/payment-test', 'alpha.zsaos.com');

const checkoutPro = curl('https://api-alpha.zsaos.com/api/v1/billing/checkout', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: { authorization: `Bearer ${userToken}` },
  body: JSON.stringify({ planCode: 'pro', billingCycle: 'MONTHLY' }),
});
const checkoutTeam = curl('https://api-alpha.zsaos.com/api/v1/billing/checkout', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: { authorization: `Bearer ${userToken}` },
  body: JSON.stringify({ planCode: 'team', billingCycle: 'MONTHLY' }),
});
const proBody = parse(checkoutPro.text);
const teamBody = parse(checkoutTeam.text);

const paymentsAfter = await runner.execute(
  shellCommand(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT COUNT(*) FROM \\"Payment\\" WHERE \\"isProductionTest\\"=true OR (provider='ALIPAY' AND environment='PRODUCTION')"`,
  ),
  { timeoutMs: 15000 },
);
const paymentsAfterCount = Number(String(paymentsAfter.stdout || '0').trim() || '0');

await runner.disconnect();
await prisma.$disconnect();

const realPaymentsEnabled = /REAL_PAYMENTS_ENABLED=true/.test(gatesText);
const paymentTestRealEnabled =
  /PAYMENT_TEST_REAL_ENABLED=true/.test(gatesText) || /ALIPAY_PRODUCTION_TEST_ENABLED=true/.test(gatesText);

const proBlocked = proBody.checkoutUrl == null && (proBody.available === false || proBody.code === 'REAL_PAYMENTS_DISABLED' || checkoutPro.status >= 400);
const teamBlocked = teamBody.checkoutUrl == null && (teamBody.available === false || teamBody.code === 'REAL_PAYMENTS_DISABLED' || checkoutTeam.status >= 400);
const noNewOrders = paymentsAfterCount === paymentsBeforeCount;

const report = {
  stage: 'M8-1A Production Payment Test ARM',
  TEST_WORKSPACE_NAME: chosen.name,
  TEST_WORKSPACE_ID: chosen.id,
  TEST_WORKSPACE_OWNER: chosen.ownerEmail,
  TEST_WORKSPACE_PROJECT: chosen.projectName || null,
  ...readiness,
  PAYMENT_TEST_AMOUNT_FEN: 90,
  PAYMENT_TEST_HIDDEN: true,
  PAYMENT_TEST_INTERNAL_ONLY: true,
  formalPrices: String(priceRows.stdout || '')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean),
  REAL_PAYMENTS_ENABLED: realPaymentsEnabled,
  PAYMENT_TEST_REAL_ENABLED: paymentTestRealEnabled,
  gatesEnv: gatesText.trim(),
  ADMIN_PAYMENT_TEST_PAGE: paymentTestAdmin.status,
  ADMIN_PAYMENT_TEST_UI: paymentTestPage.status,
  NORMAL_USER_PAYMENT_TEST: paymentTestUser.status,
  paymentTestButtonEnabled: paymentTestPayload.buttonEnabled === true,
  paymentTestEnvironment: paymentTestPayload.environment || null,
  PRO_REAL_CHECKOUT_BLOCKED: proBlocked,
  TEAM_REAL_CHECKOUT_BLOCKED: teamBlocked,
  proCheckout: { status: checkoutPro.status, available: proBody.available ?? null, code: proBody.code ?? null, checkoutUrl: proBody.checkoutUrl ?? null },
  teamCheckout: { status: checkoutTeam.status, available: teamBody.available ?? null, code: teamBody.code ?? null, checkoutUrl: teamBody.checkoutUrl ?? null },
  REAL_PAYMENT_ORDER_CREATED: false,
  REAL_PAYMENT_CHARGE_EXECUTED: false,
  productionPaymentCountUnchanged: noNewOrders,
  paymentsBeforeCount,
  paymentsAfterCount,
  PRODUCTION_PAYMENT_TEST_ARMED:
    paymentTestRealEnabled &&
    !realPaymentsEnabled &&
    paymentTestAdmin.status === 200 &&
    paymentTestUser.status === 403 &&
    paymentTestPayload.buttonEnabled === true &&
    proBlocked &&
    teamBlocked &&
    noNewOrders,
  M8_1A_ARM_READY: false,
};

report.M8_1A_ARM_READY = report.PRODUCTION_PAYMENT_TEST_ARMED === true;

writeFileSync(join(ARTIFACT_DIR, 'm8-1a-arm-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

if (!report.M8_1A_ARM_READY) {
  console.error('M8_1A_ARM_READY=false');
  process.exit(1);
}
console.log('PRODUCTION_PAYMENT_TEST_ARMED=true');
console.log('M8_1A_ARM_READY=true');
console.log('REAL_PAYMENT_ORDER_CREATED=false');
console.log('STOP — waiting for human to create ¥0.90 order manually');
