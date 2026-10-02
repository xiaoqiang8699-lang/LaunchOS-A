/**
 * Resume notify-fix deploy after SSH flake. No new order.
 * node scripts/_tmp-m8-1a-notify-fix-resume.mjs --confirm-resume
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
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

const TARGET_HOST = '116.62.198.184';
const API_TAG = 'launchos-alpha-api:m81pay';
const API_REMOTE = `localhost/${API_TAG}`;
const ARTIFACT = resolve(root, '.tools/alpha-runtime');
const tar = join(ARTIFACT, 'launchos-alpha-api-m81a-notifyfix.tar');
const adminAuth = JSON.parse(readFileSync(join(ARTIFACT, 'admin-auth.json'), 'utf8'));
const userAuth = JSON.parse(readFileSync(join(ARTIFACT, '1002-auth.json'), 'utf8'));
const WS = 'cmunqotx500cbrl013xbhpio2';

function curl(url, host, opts = {}) {
  const { method = 'GET', headers = {}, body = null, maxTime = '120', contentType } = opts;
  const args = ['-sS', '-L', '-X', method, '-w', '\n__STATUS__:%{http_code}', '--max-time', String(maxTime)];
  args.push('--resolve', `${host}:443:${TARGET_HOST}`);
  for (const [k, v] of Object.entries(headers || {})) args.push('-H', `${k}: ${v}`);
  if (body != null) {
    args.push('-H', `content-type: ${contentType || 'application/json'}`);
    args.push('--data-binary', body);
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

if (!existsSync(tar)) throw new Error('missing local tar ' + tar);
console.log('local tar', statSync(tar).size);

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { id: 'cmuma9i480001rij49yv4yw2q' } });
const username = resolveServerSshUsername({ serverUsername: server.username, provider: server.provider });
const password = decryptCredential(server.credentialEncrypted);
const runner = new RemoteRunner();

async function connect() {
  await runner.connect({ host: server.host, port: server.port, username, password, readyTimeoutMs: 45000 });
}
async function remoteOk(cmd, label, timeoutMs = 300000) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs });
  if (r.exitCode !== 0) throw new Error(`${label}: ${(r.stderr || r.stdout || '').slice(0, 2000)}`);
  return r;
}

await connect();
console.log('[1] re-upload');
await runner.upload(tar, '/opt/launchos/tmp/launchos-alpha-api-m81a-notifyfix.tar', { timeoutMs: 900000 });
await remoteOk(
  `podman load -i /opt/launchos/tmp/launchos-alpha-api-m81a-notifyfix.tar && rm -f /opt/launchos/tmp/launchos-alpha-api-m81a-notifyfix.tar && (podman tag docker.io/library/${API_TAG} ${API_REMOTE} 2>/dev/null || podman tag ${API_TAG} ${API_REMOTE} 2>/dev/null || true)`,
  'api-load',
  600000,
);
await remoteOk('bash /opt/launchos/tmp/m81a-preserve-arm-gates.sh', 'preserve-arm', 30000);
await remoteOk(`/opt/launchos/bin/m5-run-api.sh launchos-alpha-api 39110 ${API_REMOTE}`, 'run-api', 180000);

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

const formProbe = curl('https://api-alpha.zsaos.com/api/v1/payments/webhooks/alipay', 'api-alpha.zsaos.com', {
  method: 'POST',
  contentType: 'application/x-www-form-urlencoded',
  body: 'out_trade_no=probe&trade_status=TRADE_SUCCESS&sign=invalid&sign_type=RSA2',
});
console.log('formProbe', formProbe.status, formProbe.text.slice(0, 160));

const adminLogin = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: adminAuth.email, password: adminAuth.password }),
});
const adminToken = parse(adminLogin.text).accessToken;
if (!adminToken) throw new Error('admin login failed');
const adminHdr = { authorization: `Bearer ${adminToken}` };

const reconcile = curl('https://api-alpha.zsaos.com/api/v1/admin/payments/reconcile', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: adminHdr,
  body: '{}',
});
const paymentTest = curl('https://api-alpha.zsaos.com/api/v1/admin/commercial/payment-test', 'api-alpha.zsaos.com', {
  headers: adminHdr,
});

await connect();
const payments = await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT p.id || '|' || p.status || '|' || COALESCE(p.\\"merchantOrderNo\\",'') || '|' || CASE WHEN COALESCE(p.\\"providerTradeNo\\",'')<>'' THEN '1' ELSE '0' END || '|' || COALESCE(p.\\"amountCents\\"::text,'') || '|' || COALESCE(p.\\"paidAt\\"::text,'') || '|' || COALESCE(p.\\"lastQueryState\\",'') || '|' || o.status FROM \\"Payment\\" p JOIN \\"CommercialOrder\\" o ON o.id=p.\\"orderId\\" WHERE o.\\"workspaceId\\"='${WS}' AND p.\\"isProductionTest\\"=true ORDER BY p.\\"createdAt\\" DESC LIMIT 8"`,
  'payments',
  20000,
);
const webhooks = await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT e.status || '|' || e.\\"eventType\\" || '|' || COALESCE(e.\\"paymentId\\",'') || '|' || e.\\"receivedAt\\"::text FROM \\"PaymentWebhookEvent\\" e WHERE e.provider='ALIPAY' AND e.\\"receivedAt\\" > NOW() - interval '2 day' ORDER BY e.\\"receivedAt\\" DESC LIMIT 15"`,
  'webhooks',
  20000,
);
const events = await remoteOk(
  `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT \\"eventType\\" || '|' || COUNT(*)::text FROM \\"SubscriptionEvent\\" WHERE \\"workspaceId\\"='${WS}' GROUP BY 1 ORDER BY 1"`,
  'events',
  15000,
);
await runner.disconnect();

const paymentLines = String(payments.stdout || '')
  .trim()
  .split(/\r?\n/)
  .filter(Boolean);
const succeeded = paymentLines.filter((l) => l.includes('|SUCCEEDED|'));
const latest = paymentLines[0]?.split('|') ?? null;
const detail = latest?.[0]
  ? curl(`https://api-alpha.zsaos.com/api/v1/admin/payments/${latest[0]}`, 'api-alpha.zsaos.com', { headers: adminHdr })
  : { status: 0, text: '{}' };

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

const report = {
  formProbe: { status: formProbe.status, body: formProbe.text.slice(0, 200) },
  formProbeAcceptsUrlencoded: formProbe.status !== 400 || !/Unexpected token/.test(formProbe.text),
  reconcile: { status: reconcile.status, body: parse(reconcile.text) },
  paymentTestSync: parse(paymentTest.text).syncSummary ?? null,
  paymentLines,
  succeededCount: succeeded.length,
  latest: latest
    ? {
        id: latest[0],
        status: latest[1],
        outTradeNo: latest[2],
        providerTradeNoPresent: latest[3] === '1',
        amountCents: latest[4],
        paidAt: latest[5] || null,
        lastQueryState: latest[6],
        orderStatus: latest[7],
      }
    : null,
  webhooks: String(webhooks.stdout || '').trim().split(/\r?\n/).filter(Boolean),
  subscriptionEvents: String(events.stdout || '').trim().split(/\r?\n/).filter(Boolean),
  paymentDetail: parse(detail.text),
  checkoutProBlocked: parse(checkoutPro.text).checkoutUrl == null,
};

writeFileSync(join(ARTIFACT, 'm8-1a-notify-fix-resume.json'), JSON.stringify(report, null, 2));
await prisma.$disconnect();
console.log(JSON.stringify(report, null, 2));
if (succeeded.length === 0) {
  console.error('NO_SUCCEEDED_PAYMENT_YET');
  process.exit(2);
}
console.log('SUCCEEDED_PAYMENT_FOUND=true');
