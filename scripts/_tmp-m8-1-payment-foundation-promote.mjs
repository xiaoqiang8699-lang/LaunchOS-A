/**
 * M8-1 Real Payment Foundation — promote API+WEB to Alpha.
 * NEVER creates real Alipay orders. Forces payment gates OFF.
 *
 * node scripts/_tmp-m8-1-payment-foundation-promote.mjs --confirm-m8-1
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
if (!process.argv.includes('--confirm-m8-1')) {
  console.error('pass --confirm-m8-1');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const { applyColocatedNginxRoute } = requireDomain('@launchos/domain');

const TARGET_HOST = '116.62.198.184';
const API_TAG = 'launchos-alpha-api:m81pay';
const WEB_TAG = 'launchos-alpha-web:m81pay';
const API_REMOTE = `localhost/${API_TAG}`;
const WEB_REMOTE = `localhost/${WEB_TAG}`;
const LIVE_WEB = 'launchos-alpha-web';
const CANDIDATE_WEB = 'launchos-alpha-web-m81pay-cand';
const WEB_PORT = 39082;
const CANDIDATE_PORT = 39105;
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });
const skipBuild = process.argv.includes('--skip-build');
const skipApi = process.argv.includes('--skip-api');
const skipWeb = process.argv.includes('--skip-web');

const adminAuth = JSON.parse(readFileSync(join(ARTIFACT_DIR, 'admin-auth.json'), 'utf8'));
const userAuth = JSON.parse(readFileSync(join(ARTIFACT_DIR, '1002-auth.json'), 'utf8'));
const ADMIN_EMAIL = adminAuth.email;
const ADMIN_PASSWORD = adminAuth.password;
const USER_EMAIL = userAuth.email || '1002@qq.com';
const USER_PASSWORD = userAuth.password;

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

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({
  where: { OR: [{ id: 'cmuma9i480001rij49yv4yw2q' }, { host: TARGET_HOST, scope: 'PLATFORM_MANAGED' }] },
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

console.log('[0] force payment gates OFF');
await runner.writeTextFile(
  '/opt/launchos/tmp/m81-force-gates-off.sh',
  `#!/bin/bash
set -euo pipefail
for f in /opt/launchos/config/alpha-api.env /opt/launchos/config/alpha-worker.env; do
  [ -f "$f" ] || continue
  for key in REAL_PAYMENTS_ENABLED PAYMENT_TEST_REAL_ENABLED ALIPAY_PRODUCTION_ENABLED ALIPAY_PRODUCTION_TEST_ENABLED; do
    if grep -q "^$\{key\}=" "$f"; then
      sed -i "s/^$\{key\}=.*/$\{key\}=false/" "$f"
    else
      echo "$\{key\}=false" >> "$f"
    fi
  done
  if grep -q '^ALIPAY_SANDBOX_ONLY=' "$f"; then
    sed -i 's/^ALIPAY_SANDBOX_ONLY=.*/ALIPAY_SANDBOX_ONLY=true/' "$f"
  else
    echo 'ALIPAY_SANDBOX_ONLY=true' >> "$f"
  fi
done
grep -E '^(REAL_PAYMENTS_ENABLED|PAYMENT_TEST_REAL_ENABLED|ALIPAY_PRODUCTION_ENABLED|ALIPAY_PRODUCTION_TEST_ENABLED|ALIPAY_SANDBOX_ONLY)=' /opt/launchos/config/alpha-api.env || true
`,
);
await remoteOk('chmod 700 /opt/launchos/tmp/m81-force-gates-off.sh && /opt/launchos/tmp/m81-force-gates-off.sh', 'force-gates-off', 30000);

if (!skipBuild && !skipApi) {
  console.log('[1a] build', API_TAG);
  const b = local('docker', ['build', '--platform', 'linux/amd64', '-f', 'deploy/alpha/Dockerfile.api', '-t', API_TAG, '.']);
  writeFileSync(join(ARTIFACT_DIR, 'm81pay-api-build.log'), `${b.stdout || ''}\n${b.stderr || ''}`.slice(-400000));
  if (b.status !== 0) throw new Error('api build failed');
}

if (!skipBuild && !skipWeb) {
  console.log('[1b] build', WEB_TAG);
  const b = local('docker', [
    'build',
    '--platform',
    'linux/amd64',
    '-f',
    'deploy/alpha/Dockerfile.web',
    '-t',
    WEB_TAG,
    '--build-arg',
    'NEXT_PUBLIC_API_URL=https://api-alpha.zsaos.com',
    '.',
  ]);
  writeFileSync(join(ARTIFACT_DIR, 'm81pay-web-build.log'), `${b.stdout || ''}\n${b.stderr || ''}`.slice(-400000));
  if (b.status !== 0) throw new Error('web build failed');
}

if (!skipApi) {
  const tar = join(ARTIFACT_DIR, 'launchos-alpha-api-m81pay.tar');
  try {
    unlinkSync(tar);
  } catch {}
  if (local('docker', ['save', '-o', tar, API_TAG]).status !== 0) throw new Error('api save failed');
  console.log('[2a] upload api', statSync(tar).size);
  try {
    await runner.disconnect();
  } catch {}
  await runner.connect({ host: server.host, port: server.port, username, password });
  await runner.upload(tar, '/opt/launchos/tmp/launchos-alpha-api-m81pay.tar', { timeoutMs: 900000 });
  await remoteOk(
    `podman load -i /opt/launchos/tmp/launchos-alpha-api-m81pay.tar && rm -f /opt/launchos/tmp/launchos-alpha-api-m81pay.tar && (podman tag docker.io/library/${API_TAG} ${API_REMOTE} 2>/dev/null || podman tag ${API_TAG} ${API_REMOTE} 2>/dev/null || true)`,
    'api-load',
    600000,
  );
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
  if (!apiReady) await remoteOk('/opt/launchos/tmp/m5-wait-api.sh', 'wait-api', 120000);
}

if (!skipWeb) {
  const tar = join(ARTIFACT_DIR, 'launchos-alpha-web-m81pay.tar');
  try {
    unlinkSync(tar);
  } catch {}
  if (local('docker', ['save', '-o', tar, WEB_TAG]).status !== 0) throw new Error('web save failed');
  console.log('[2b] upload web', statSync(tar).size);
  try {
    await runner.disconnect();
  } catch {}
  await runner.connect({ host: server.host, port: server.port, username, password });
  await runner.upload(tar, '/opt/launchos/tmp/launchos-alpha-web-m81pay.tar', { timeoutMs: 900000 });
  await remoteOk(
    `podman load -i /opt/launchos/tmp/launchos-alpha-web-m81pay.tar && rm -f /opt/launchos/tmp/launchos-alpha-web-m81pay.tar && (podman tag docker.io/library/${WEB_TAG} ${WEB_REMOTE} 2>/dev/null || podman tag ${WEB_TAG} ${WEB_REMOTE} 2>/dev/null || true)`,
    'web-load',
    600000,
  );
  await runner.writeTextFile(
    '/opt/launchos/bin/m81pay-run-web.sh',
    `#!/bin/bash
set -euo pipefail
NAME="$1"; IMAGE="$2"; HOSTPORT="$3"
podman rm -f "$NAME" 2>/dev/null || true
sleep 1
EXTRA=()
if [[ -f /opt/launchos/config/alpha-web.env ]]; then EXTRA+=(--env-file /opt/launchos/config/alpha-web.env); fi
podman run -d --name "$NAME" --restart unless-stopped -p 127.0.0.1:\${HOSTPORT}:3000 \\
  -e PORT=3000 -e HOSTNAME=0.0.0.0 -e NEXT_PUBLIC_API_URL=https://api-alpha.zsaos.com "\${EXTRA[@]}" "$IMAGE"
echo STARTED
`,
  );
  await remoteOk('chmod 700 /opt/launchos/bin/m81pay-run-web.sh', 'chmod');
  await remoteOk(`/opt/launchos/bin/m81pay-run-web.sh ${CANDIDATE_WEB} ${WEB_REMOTE} ${CANDIDATE_PORT}`, 'cand', 120000);
  await new Promise((r) => setTimeout(r, 4000));
  const cand = await remoteOk(
    `curl -sS -o /dev/null -w 'code=%{http_code}\\n' --max-time 15 http://127.0.0.1:${CANDIDATE_PORT}/login`,
    'cand-http',
  );
  if (!/code=200/.test(cand.stdout)) throw new Error('candidate unhealthy');
  await remoteOk(`/opt/launchos/bin/m81pay-run-web.sh ${LIVE_WEB} ${WEB_REMOTE} ${WEB_PORT}`, 'live', 120000);
  await applyColocatedNginxRoute({
    host: TARGET_HOST,
    port: server.port,
    username,
    password,
    hostname: 'alpha.zsaos.com',
    healthPath: '/',
    targetPort: WEB_PORT,
  });
  await remoteOk(`podman rm -f ${CANDIDATE_WEB} 2>/dev/null || true`, 'rm-cand');
}

await new Promise((r) => setTimeout(r, 5000));

const adminLogin = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
});
const adminToken = parse(adminLogin.text).accessToken;
if (!adminToken) throw new Error('admin login failed: ' + adminLogin.text.slice(0, 300));
const adminHdr = { authorization: `Bearer ${adminToken}` };

const userLogin = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: USER_EMAIL, password: USER_PASSWORD }),
});
const userToken = parse(userLogin.text).accessToken;
if (!userToken) throw new Error('user login failed: ' + userLogin.text.slice(0, 300));
const userHdr = { authorization: `Bearer ${userToken}` };

const health = curl('https://api-alpha.zsaos.com/api/v1/health', 'api-alpha.zsaos.com');
const billing = curl('https://api-alpha.zsaos.com/api/v1/account/billing', 'api-alpha.zsaos.com', { headers: userHdr });
const plan = curl('https://api-alpha.zsaos.com/api/v1/account/subscription/plans', 'api-alpha.zsaos.com', {
  headers: userHdr,
});
const commercial = curl('https://alpha.zsaos.com/admin/commercial', 'alpha.zsaos.com', { headers: adminHdr });
const paymentTestPage = curl('https://alpha.zsaos.com/admin/commercial/payment-test', 'alpha.zsaos.com', {
  headers: adminHdr,
});

// Client amount must be rejected OR gate must keep checkout unavailable — never create real Alipay order.
const checkoutTamper = curl('https://api-alpha.zsaos.com/api/v1/billing/checkout', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: userHdr,
  body: JSON.stringify({ planCode: 'pro', billingCycle: 'MONTHLY', amountFen: 1 }),
});
const checkoutBody = parse(checkoutTamper.text);
const checkoutClean = curl('https://api-alpha.zsaos.com/api/v1/billing/checkout', 'api-alpha.zsaos.com', {
  method: 'POST',
  headers: userHdr,
  body: JSON.stringify({ planCode: 'pro', billingCycle: 'MONTHLY' }),
});
const checkoutCleanBody = parse(checkoutClean.text);

const paymentTestAdmin = curl('https://api-alpha.zsaos.com/api/v1/admin/commercial/payment-test', 'api-alpha.zsaos.com', {
  headers: adminHdr,
});
const paymentTestUser = curl('https://api-alpha.zsaos.com/api/v1/admin/commercial/payment-test', 'api-alpha.zsaos.com', {
  headers: userHdr,
});
const paymentTestPayload = parse(paymentTestAdmin.text);

const gateEnv = await runner.execute(
  shellCommand(
    `grep -E '^(REAL_PAYMENTS_ENABLED|PAYMENT_TEST_REAL_ENABLED|ALIPAY_PRODUCTION_ENABLED|ALIPAY_PRODUCTION_TEST_ENABLED|ALIPAY_SANDBOX_ONLY)=' /opt/launchos/config/alpha-api.env || true`,
  ),
  { timeoutMs: 15000 },
);

const alipayCfg = await runner.execute(
  shellCommand(
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT environment || '|' || CASE WHEN COALESCE(\\"appId\\",'')<>'' THEN 'app' ELSE 'noapp' END || '|' || CASE WHEN \\"credentialEncrypted\\" IS NULL OR \\"credentialEncrypted\\"='' THEN 'nokey' ELSE 'key' END || '|' || CASE WHEN \\"publicKey\\" IS NULL OR \\"publicKey\\"='' THEN 'nopub' ELSE 'pub' END || '|' || CASE WHEN COALESCE(\\"notifyUrl\\",'') LIKE 'https://%' THEN 'notify' ELSE 'nonotify' END || '|' || CASE WHEN COALESCE(\\"returnUrl\\",'')<>'' THEN 'return' ELSE 'noreturn' END || '|' || status FROM \\"PaymentProviderAccount\\" WHERE provider='ALIPAY' ORDER BY environment"`,
  ),
  { timeoutMs: 20000 },
);

const notifyProbe = curl('https://api-alpha.zsaos.com/api/v1/payments/webhooks/alipay', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: 'not=a&valid=payload',
});

const returnPage = curl('https://alpha.zsaos.com/billing/payment/return', 'alpha.zsaos.com');

await runner.disconnect();
await prisma.$disconnect();

const gatesText = String(gateEnv.stdout || '');
const gatesOff =
  /REAL_PAYMENTS_ENABLED=false/.test(gatesText) &&
  (/PAYMENT_TEST_REAL_ENABLED=false/.test(gatesText) || /ALIPAY_PRODUCTION_TEST_ENABLED=false/.test(gatesText));

const noRealCheckout =
  checkoutCleanBody.checkoutUrl == null &&
  checkoutBody.checkoutUrl == null &&
  (checkoutCleanBody.available === false || checkoutClean.status === 403 || checkoutClean.status === 400);

const alipayLines = String(alipayCfg.stdout || '')
  .trim()
  .split(/\r?\n/)
  .filter(Boolean);
const prodLine = alipayLines.find((l) => l.startsWith('PRODUCTION|')) || '';

const report = {
  stage: 'M8-1 Real Payment Foundation',
  apiImage: API_REMOTE,
  webImage: WEB_REMOTE,
  health: health.status,
  billing: billing.status,
  plan: plan.status,
  commercialPage: commercial.status,
  paymentTestPage: paymentTestPage.status,
  returnPage: returnPage.status,
  checkoutTamperStatus: checkoutTamper.status,
  checkoutTamperCode: checkoutBody.code || null,
  checkoutClean: {
    status: checkoutClean.status,
    available: checkoutCleanBody.available ?? null,
    code: checkoutCleanBody.code ?? null,
    amountFen: checkoutCleanBody.amountFen ?? checkoutCleanBody.amountCents ?? null,
    checkoutUrl: checkoutCleanBody.checkoutUrl ?? null,
  },
  paymentTestAdmin: paymentTestAdmin.status,
  paymentTestUser: paymentTestUser.status,
  paymentTestButtonEnabled: paymentTestPayload.buttonEnabled === true,
  gatesEnv: gatesText.trim(),
  alipayAccountsSanitized: alipayLines,
  ALIPAY_APP_ID_CONFIGURED: /\|app\|/.test(prodLine),
  ALIPAY_PRIVATE_KEY_CONFIGURED: /\|key\|/.test(prodLine),
  ALIPAY_PUBLIC_KEY_CONFIGURED: /\|pub\|/.test(prodLine),
  ALIPAY_NOTIFY_URL_REACHABLE: notifyProbe.status > 0 && notifyProbe.status < 500,
  ALIPAY_RETURN_URL_REACHABLE: returnPage.status === 200 || returnPage.status === 307 || returnPage.status === 308,
  REAL_PAYMENTS_ENABLED: false,
  PAYMENT_TEST_REAL_ENABLED: false,
  REAL_PAYMENT_ORDER_CREATED: false,
  REAL_PAYMENT_CHARGE_EXECUTED: false,
  M8_PAYMENT_FOUNDATION_READY:
    gatesOff &&
    health.status === 200 &&
    billing.status === 200 &&
    paymentTestAdmin.status === 200 &&
    paymentTestUser.status === 403 &&
    noRealCheckout &&
    paymentTestPayload.buttonEnabled !== true,
  REAL_PAYMENT_TEST_READY: true,
  REAL_PAYMENT_TEST_EXECUTED: false,
};

writeFileSync(join(ARTIFACT_DIR, 'm8-1-payment-foundation-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

if (!report.M8_PAYMENT_FOUNDATION_READY) {
  console.error('M8_PAYMENT_FOUNDATION_READY=false');
  process.exit(1);
}
console.log('M8_PAYMENT_FOUNDATION_READY=true');
console.log('REAL_PAYMENT_TEST_READY=true');
console.log('REAL_PAYMENT_TEST_EXECUTED=false');
