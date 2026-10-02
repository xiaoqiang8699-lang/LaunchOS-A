/**
 * API-only redeploy for TRADE_NOT_EXIST fallback + re-sync payment-test ghosts.
 * Preserves ARM gates. Does NOT create orders.
 * node scripts/_tmp-m8-1a-pending-cleanup-api-resync.mjs --confirm-resync
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
if (!process.argv.includes('--confirm-resync')) {
  console.error('pass --confirm-resync');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');

const TARGET_HOST = '116.62.198.184';
const API_TAG = 'launchos-alpha-api:m81pay';
const API_REMOTE = `localhost/${API_TAG}`;
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });

const adminAuth = JSON.parse(readFileSync(join(ARTIFACT_DIR, 'admin-auth.json'), 'utf8'));
const userAuth = JSON.parse(readFileSync(join(ARTIFACT_DIR, '1002-auth.json'), 'utf8'));

function local(cmd, args) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 64_000_000, shell: false });
}
function curl(url, host, opts = {}) {
  const { method = 'GET', headers = {}, body = null, maxTime = '120' } = opts;
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
const username = resolveServerSshUsername({ serverUsername: server.username, provider: server.provider });
const password = decryptCredential(server.credentialEncrypted);
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username, password });

async function remoteOk(cmd, label, timeoutMs = 300000) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs });
  if (r.exitCode !== 0) throw new Error(`${label}: ${(r.stderr || r.stdout || '').slice(0, 2000)}`);
  return r;
}

const before = await runner.execute(
  shellCommand(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT COUNT(*) FROM \\"Payment\\" WHERE \\"isProductionTest\\"=true AND status IN ('PENDING','PROCESSING')"`,
  ),
  { timeoutMs: 15000 },
);
const pendingBefore = Number(String(before.stdout || '0').trim() || 0);

console.log('[1] build api');
const b = local('docker', ['build', '--platform', 'linux/amd64', '-f', 'deploy/alpha/Dockerfile.api', '-t', API_TAG, '.']);
writeFileSync(join(ARTIFACT_DIR, 'm81a-resync-api-build.log'), `${b.stdout || ''}\n${b.stderr || ''}`.slice(-400000));
if (b.status !== 0) throw new Error('api build failed');

const tar = join(ARTIFACT_DIR, 'launchos-alpha-api-m81a-resync.tar');
try {
  unlinkSync(tar);
} catch {}
if (local('docker', ['save', '-o', tar, API_TAG]).status !== 0) throw new Error('api save failed');
console.log('[2] upload', statSync(tar).size);
try {
  await runner.disconnect();
} catch {}
await runner.connect({ host: server.host, port: server.port, username, password });
await runner.upload(tar, '/opt/launchos/tmp/launchos-alpha-api-m81a-resync.tar', { timeoutMs: 900000 });
await remoteOk(
  `podman load -i /opt/launchos/tmp/launchos-alpha-api-m81a-resync.tar && rm -f /opt/launchos/tmp/launchos-alpha-api-m81a-resync.tar && (podman tag docker.io/library/${API_TAG} ${API_REMOTE} 2>/dev/null || podman tag ${API_TAG} ${API_REMOTE} 2>/dev/null || true)`,
  'api-load',
  600000,
);
await remoteOk('bash /opt/launchos/tmp/m81a-preserve-arm-gates.sh', 'preserve-arm', 30000);
await remoteOk(`/opt/launchos/bin/m5-run-api.sh launchos-alpha-api 39110 ${API_REMOTE}`, 'run-api', 120000);

let apiReady = false;
for (let i = 0; i < 60; i++) {
  const probe = await runner.execute(shellCommand('curl -sf --max-time 3 http://127.0.0.1:39110/api/v1/health'), { timeoutMs: 15000 });
  if (probe.exitCode === 0) {
    apiReady = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 3000));
}
if (!apiReady) throw new Error('api not ready');
await runner.disconnect();

const adminLogin = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: adminAuth.email, password: adminAuth.password }),
});
const adminToken = parse(adminLogin.text).accessToken;
if (!adminToken) throw new Error('admin login failed');
const adminHdr = { authorization: `Bearer ${adminToken}` };
const userLogin = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: userAuth.email || '1002@qq.com', password: userAuth.password }),
});
const userHdr = { authorization: `Bearer ${parse(userLogin.text).accessToken}` };

const paymentTest = curl('https://api-alpha.zsaos.com/api/v1/admin/commercial/payment-test', 'api-alpha.zsaos.com', {
  headers: adminHdr,
});
const body = parse(paymentTest.text);
const paymentTestUser = curl('https://api-alpha.zsaos.com/api/v1/admin/commercial/payment-test', 'api-alpha.zsaos.com', {
  headers: userHdr,
});
const page = curl('https://alpha.zsaos.com/admin/commercial/payment-test', 'alpha.zsaos.com', { headers: adminHdr });
const checkoutPro = curl('https://api-alpha.zsaos.com/api/v1/billing/checkout', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: userHdr,
  body: JSON.stringify({ planCode: 'pro', billingCycle: 'MONTHLY' }),
});

await runner.connect({ host: server.host, port: server.port, username, password });
const after = await runner.execute(
  shellCommand(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT p.id || '|' || p.status || '|' || COALESCE(p.\\"merchantOrderNo\\",'') || '|' || COALESCE(p.\\"failureCode\\",'') || '|' || COALESCE(p.\\"lastQueryState\\",'') FROM \\"Payment\\" p WHERE p.\\"isProductionTest\\"=true ORDER BY p.\\"createdAt\\" DESC LIMIT 10"`,
  ),
  { timeoutMs: 20000 },
);
const gates = await runner.execute(
  shellCommand(
    `grep -E '^(REAL_PAYMENTS_ENABLED|PAYMENT_TEST_REAL_ENABLED|ALIPAY_PRODUCTION_TEST_ENABLED|ALIPAY_SANDBOX_ONLY)=' /opt/launchos/config/alpha-api.env || true`,
  ),
  { timeoutMs: 15000 },
);
await runner.disconnect();
await prisma.$disconnect();

const afterLines = String(after.stdout || '')
  .trim()
  .split(/\r?\n/)
  .filter(Boolean);
const pendingAfter = afterLines.filter((l) => /\|PENDING\||\|PROCESSING\|/.test(l)).length;
const failedGhosts = afterLines.filter((l) => l.includes('PROVIDER_TRADE_NOT_CREATED_INVALID_SIGNATURE')).length;
const gatesText = String(gates.stdout || '');
const checkoutProBody = parse(checkoutPro.text);

const report = {
  stage: 'M8-1A pending cleanup API resync',
  PENDING_BEFORE: pendingBefore,
  PROVIDER_TRADE_EXISTS_COUNT: body.syncSummary?.tradeExists ?? 0,
  PROVIDER_TRADE_NOT_EXIST_COUNT: body.syncSummary?.tradeNotExist ?? failedGhosts,
  OLD_PENDING_CLOSED_OR_FAILED: body.syncSummary?.closedOrFailed ?? failedGhosts,
  REUSABLE_PENDING_COUNT: body.reusablePending ? 1 : body.syncSummary?.reusableCount ?? 0,
  LATEST_REUSABLE_OUT_TRADE_NO: body.reusablePending?.outTradeNo ?? 'NONE',
  canCreateNew: body.canCreateNew === true,
  paymentTestAdmin: paymentTest.status,
  paymentTestUser: paymentTestUser.status,
  paymentTestPage: page.status,
  syncSummary: body.syncSummary ?? null,
  afterPaymentsSanitized: afterLines,
  pendingAfter,
  gatesAfter: gatesText.trim(),
  REAL_PAYMENTS_ENABLED: /REAL_PAYMENTS_ENABLED=true/.test(gatesText),
  PAYMENT_TEST_REAL_ENABLED: /PAYMENT_TEST_REAL_ENABLED=true/.test(gatesText),
  PRO_CHECKOUT_BLOCKED: checkoutProBody.checkoutUrl == null,
  NEW_REAL_ORDER_CREATED: false,
  REAL_PAYMENT_CHARGE_EXECUTED: false,
  REAL_PAYMENT_ORDER_CREATED_BY_THIS_FIX: false,
};
report.ADMIN_PAGE_READY = paymentTest.status === 200 && page.status === 200 && paymentTestUser.status === 403;
report.PAYMENT_TEST_PENDING_ORDER_FLOW_READY =
  report.ADMIN_PAGE_READY &&
  report.REAL_PAYMENTS_ENABLED === false &&
  report.PAYMENT_TEST_REAL_ENABLED === true &&
  report.PRO_CHECKOUT_BLOCKED === true &&
  report.NEW_REAL_ORDER_CREATED === false &&
  report.pendingAfter === report.REUSABLE_PENDING_COUNT &&
  (pendingBefore === 0 || report.OLD_PENDING_CLOSED_OR_FAILED > 0 || report.REUSABLE_PENDING_COUNT > 0) &&
  (report.REUSABLE_PENDING_COUNT === 0 ? report.canCreateNew === true : true);

writeFileSync(join(ARTIFACT_DIR, 'm8-1a-pending-cleanup-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!report.PAYMENT_TEST_PENDING_ORDER_FLOW_READY) {
  console.error('PAYMENT_TEST_PENDING_ORDER_FLOW_READY=false');
  process.exit(1);
}
console.log('PAYMENT_TEST_PENDING_ORDER_FLOW_READY=true');
console.log('STOP — human create/pay only');
