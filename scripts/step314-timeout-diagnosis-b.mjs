/**
 * Step 31.4 follow-up part B: nginx block extract, clone timing, zip plan, access-log timing.
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of [resolve(root, '.env')]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const { createInstallationAccessToken } = requireApi('@launchos/github');

const TARGET_HOST = '116.62.198.184';
const LIVE_CONTAINER = 'launchos-alpha-api';
const PRIVATE_FULL = 'xiaoqiang8699-lang/launchos-multi-demo';
const PRIVATE_BRANCH = 'main';
const API_HOST = 'api-alpha.zsaos.com';
const WEB_ORIGIN = 'https://alpha.zsaos.com';
const API_ORIGIN = `https://${API_HOST}`;
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });

function redact(t) {
  return String(t || '')
    .replace(/BEGIN [^\n]+PRIVATE KEY[\s\S]*?END [^\n]+PRIVATE KEY/g, '[PEM_REDACTED]')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/ghs_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/Bearer\s+[A-Za-z0-9._\-+=/]+/gi, 'Bearer ***')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|authorization|passwordHash)[=:][^\s"']+/gi, '$1=***')
    .replace(/x-access-token:[^\s@]+/gi, 'x-access-token:***')
    .replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//***:***@');
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function curlResolve(url, host, { method = 'GET', headers = {}, body, maxTime = '120' } = {}) {
  const args = [
    '-k', '-sS', '-X', method,
    '--resolve', `${host}:443:${TARGET_HOST}`,
    '-w', '\n__STATUS__:%{http_code}\n__TIME__:%{time_total}',
    '--max-time', String(maxTime),
  ];
  for (const [k, v] of Object.entries(headers)) {
    if (v == null) continue;
    args.push('-H', `${k}: ${v}`);
  }
  if (body != null) {
    args.push('-H', 'content-type: application/json');
    args.push('--data-binary', body);
  }
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
  const out = String(r.stdout || '');
  const sm = out.match(/\n__STATUS__:(\d+)/);
  const tm = out.match(/\n__TIME__:([0-9.]+)/);
  const text = out.replace(/\n__STATUS__:\d+\s*/g, '').replace(/\n__TIME__:[0-9.]+\s*/g, '').trimEnd();
  return { status: sm ? Number(sm[1]) : 0, timeSec: tm ? Number(tm[1]) : null, text };
}

const out = {
  nginxApiAlphaBlock: null,
  nginxTimeouts: null,
  accessLogAnalyze: null,
  cloneTiming: null,
  zipPlan: null,
  conclusion: null,
};

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: TARGET_HOST } });
if (!server) throw new Error('serverInstance missing');
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});

try {
  console.log('[2b] extract api-alpha nginx block + defaults');
  await runner.writeTextFile(
    '/opt/launchos/bin/step314-nginx-block.sh',
    `#!/bin/bash
set -u
ACTIVE=/opt/launchos/gateway/active/launchos-routes.conf
INC=$(cat /etc/nginx/conf.d/launchos-include.conf 2>/dev/null || true)
echo "INCLUDE_LINE=$INC"
echo '===ACTIVE_API_ALPHA_BLOCKS==='
awk '
  /server_name[[:space:]]+api-alpha\\.zsaos\\.com/ {grab=1}
  grab {print}
  grab && /^[[:space:]]*}/ {grab=0; print "----END_BLOCK----"}
' "$ACTIVE" 2>/dev/null | head -n 200
echo '===TIMEOUT_DIRECTIVES_NEAR_API_ALPHA==='
grep -nE 'proxy_read_timeout|proxy_send_timeout|proxy_connect_timeout|send_timeout|keepalive_timeout|proxy_pass|listen|server_name' "$ACTIVE" | head -n 120
echo '===GLOBAL_TIMEOUT_GREP==='
grep -RniE 'proxy_read_timeout|proxy_send_timeout|proxy_connect_timeout' /etc/nginx /opt/launchos/gateway 2>/dev/null | head -n 80
echo '===NGINX_DEFAULTS==='
nginx -T 2>/dev/null | grep -nE 'proxy_read_timeout|proxy_send_timeout|proxy_connect_timeout|send_timeout' | head -n 40
echo '===ACCESS_ANALYZE==='
for f in /var/log/nginx/access.log /var/log/nginx/access.log.1 /opt/launchos/gateway/logs/access.log; do
  [ -f "$f" ] || continue
  echo "---- $f ----"
  grep -E 'api-alpha|/onboarding/analyze|/onboarding/plan|/onboarding/source' "$f" 2>/dev/null | tail -n 40
done
echo '===ERROR_TIMEOUT==='
for f in /var/log/nginx/error.log /var/log/nginx/error.log.1 /opt/launchos/gateway/logs/error.log; do
  [ -f "$f" ] || continue
  echo "---- $f ----"
  grep -Ei 'upstream timed out|api-alpha|39110|504|onboarding' "$f" 2>/dev/null | tail -n 40
done
`,
  );
  const ngx = await runner.execute(
    shellCommand('chmod 700 /opt/launchos/bin/step314-nginx-block.sh && /opt/launchos/bin/step314-nginx-block.sh'),
    { timeoutMs: 120000 },
  );
  const ngxOut = redact(`${ngx.stdout || ''}\n${ngx.stderr || ''}`);
  writeFileSync(join(ARTIFACT_DIR, 'step314-nginx-block.txt'), ngxOut);
  const blockMatch = ngxOut.match(/===ACTIVE_API_ALPHA_BLOCKS===([\s\S]*?)===TIMEOUT_DIRECTIVES/);
  out.nginxApiAlphaBlock = (blockMatch?.[1] || '').trim().slice(0, 2500);
  const timeoutLines = ngxOut.split(/\r?\n/).filter((l) => /proxy_(read|send|connect)_timeout|send_timeout|upstream timed out/i.test(l));
  out.nginxTimeouts = {
    lines: timeoutLines.slice(0, 40),
    hasExplicitProxyRead: timeoutLines.some((l) => /proxy_read_timeout/i.test(l) && !/grep -/.test(l)),
  };
  const access = ngxOut.split('===ACCESS_ANALYZE===')[1]?.split('===ERROR_TIMEOUT===')[0] || '';
  const errors = ngxOut.split('===ERROR_TIMEOUT===')[1] || '';
  out.accessLogAnalyze = {
    accessSnippet: redact(access).trim().slice(0, 2500),
    errorSnippet: redact(errors).trim().slice(0, 2500),
  };
  console.log('NGINX_BLOCK\n' + (out.nginxApiAlphaBlock || '(empty)').slice(0, 1200));
  console.log('TIMEOUT_LINES', JSON.stringify(out.nginxTimeouts));
  console.log('ACCESS_SNIP\n' + out.accessLogAnalyze.accessSnippet.slice(0, 1000));
  console.log('ERR_SNIP\n' + out.accessLogAnalyze.errorSnippet.slice(0, 1000));

  console.log('[3] timed clone');
  await runner.writeTextFile(
    '/opt/launchos/tmp/step314-conn.sql',
    `SELECT c.id, c."installationId", c."workspaceId", c.status, c.login
FROM "GitProviderConnection" c
WHERE c.status = 'ACTIVE' AND c.provider = 'GITHUB' AND c.login = 'xiaoqiang8699-lang'
ORDER BY c."updatedAt" DESC
LIMIT 1;
`,
  );
  const sqlOut = await runner.execute(
    shellCommand(
      'podman cp /opt/launchos/tmp/step314-conn.sql launchos-alpha-postgres:/tmp/step314-conn.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF "|" -f /tmp/step314-conn.sql',
    ),
    { timeoutMs: 60000 },
  );
  const connLine = String(sqlOut.stdout || '').trim().split(/\r?\n/).filter(Boolean)[0];
  if (!connLine) throw new Error('No ACTIVE GitHub connection for xiaoqiang8699-lang');
  const parts = connLine.split('|');
  const installationId = parts[1];
  console.log('INSTALL_SUFFIX=' + String(installationId).slice(-4));
  const issued = await createInstallationAccessToken(installationId);
  const probeEnvLocal = join(ARTIFACT_DIR, '.step314-clone-probe.env');
  writeFileSync(probeEnvLocal, `INSTALL_TOKEN=${issued.token}\n`, { mode: 0o600 });
  await runner.upload(probeEnvLocal, '/opt/launchos/tmp/step314-clone-probe.env');
  try {
    writeFileSync(probeEnvLocal, 'INSTALL_TOKEN=\n');
    unlinkSync(probeEnvLocal);
  } catch {}

  await runner.writeTextFile(
    '/opt/launchos/tmp/step314-inner-clone.sh',
    `#!/bin/sh
set -e
TOK=$(sed -n 's/^INSTALL_TOKEN=//p' /tmp/step314-clone-probe.env | head -1)
rm -f /tmp/step314-clone-probe.env
test -n "$TOK"
export T="$TOK"
BASIC=$(node -e 'process.stdout.write(Buffer.from("x-access-token:"+process.env.T).toString("base64"))')
unset TOK
unset T
DEST=/tmp/step314-clone-$$
rm -rf "$DEST"
START=$(date +%s)
set +e
git -c http.version=HTTP/1.1 -c http.extraHeader="AUTHORIZATION: basic $BASIC" clone --depth 1 --branch ${PRIVATE_BRANCH} "https://github.com/${PRIVATE_FULL}.git" "$DEST" >/tmp/step314-clone.out 2>/tmp/step314-clone.err
EC=$?
END=$(date +%s)
set -e
unset BASIC
DUR=$((END-START))
echo CLONE_EXIT=$EC
echo CLONE_DURATION_SEC=$DUR
echo CLONE_ERR=$(tr '\\n' ' ' </tmp/step314-clone.err 2>/dev/null | head -c 220 | sed -E 's/(gh[pousr]_[A-Za-z0-9_]+|ghs_[A-Za-z0-9_]+|x-access-token:[^ ]+|Bearer [^ ]+)/***/gi')
rm -rf "$DEST" /tmp/step314-clone.out /tmp/step314-clone.err
`,
  );
  await runner.writeTextFile(
    '/opt/launchos/bin/step314-clone-time.sh',
    `#!/bin/sh
set -e
podman cp /opt/launchos/tmp/step314-clone-probe.env ${LIVE_CONTAINER}:/tmp/step314-clone-probe.env
rm -f /opt/launchos/tmp/step314-clone-probe.env
podman cp /opt/launchos/tmp/step314-inner-clone.sh ${LIVE_CONTAINER}:/tmp/step314-inner-clone.sh
podman exec ${LIVE_CONTAINER} sh /tmp/step314-inner-clone.sh
`,
  );
  const cloneRun = await runner.execute(
    shellCommand('chmod 700 /opt/launchos/bin/step314-clone-time.sh && /opt/launchos/bin/step314-clone-time.sh'),
    { timeoutMs: 300000 },
  );
  const cloneOut = redact(String(cloneRun.stdout || '') + '\n' + String(cloneRun.stderr || ''));
  const ecM = cloneOut.match(/CLONE_EXIT=(\d+)/);
  const durM = cloneOut.match(/CLONE_DURATION_SEC=(\d+)/);
  const errM = cloneOut.match(/CLONE_ERR=(.*)/);
  out.cloneTiming = {
    exitCode: ecM ? Number(ecM[1]) : cloneRun.exitCode,
    durationSec: durM ? Number(durM[1]) : null,
    errorRedacted: errM ? errM[1].slice(0, 220) : null,
    under60s: durM ? Number(durM[1]) < 60 : false,
    ok: ecM ? Number(ecM[1]) === 0 : false,
  };
  console.log('CLONE', JSON.stringify(out.cloneTiming));

  console.log('[4] zip analyze + plan');
  const zipPath = join(ARTIFACT_DIR, 'step31-smoke.zip');
  const zipEmail = `alpha-s314-zipdiag-${Date.now()}@zsaos.test`;
  const zipPass = `Alpha${randomBytes(5).toString('hex')}!aA1`;
  curlResolve(`${API_ORIGIN}/api/v1/auth/register`, API_HOST, {
    method: 'POST',
    headers: { origin: WEB_ORIGIN },
    body: JSON.stringify({ email: zipEmail, password: zipPass, name: 'S314ZipDiag' }),
    maxTime: '60',
  });
  const zipLogin = curlResolve(`${API_ORIGIN}/api/v1/auth/login`, API_HOST, {
    method: 'POST',
    headers: { origin: WEB_ORIGIN },
    body: JSON.stringify({ email: zipEmail, password: zipPass }),
    maxTime: '60',
  });
  const zipToken = parseJson(zipLogin.text)?.accessToken;
  if (!zipToken) {
    out.zipPlan = { ok: false, reason: 'login failed', loginStatus: zipLogin.status, snippet: redact(zipLogin.text).slice(0, 200) };
  } else {
    const zr = spawnSync(
      'curl.exe',
      [
        '-k', '-sS', '-X', 'POST',
        '--resolve', `${API_HOST}:443:${TARGET_HOST}`,
        '-H', `authorization: Bearer ${zipToken}`,
        '-H', `origin: ${WEB_ORIGIN}`,
        '-F', `file=@${zipPath}`,
        '-w', '\n__STATUS__:%{http_code}\n__TIME__:%{time_total}',
        '--max-time', '180',
        `${API_ORIGIN}/api/v1/onboarding/source/zip`,
      ],
      { encoding: 'utf8', maxBuffer: 8_000_000 },
    );
    const zout = String(zr.stdout || '');
    const zm = zout.match(/\n__STATUS__:(\d+)/);
    const zt = zout.match(/\n__TIME__:([0-9.]+)/);
    const uploadStatus = zm ? Number(zm[1]) : 0;
    const zipAnalyze = curlResolve(`${API_ORIGIN}/api/v1/onboarding/analyze`, API_HOST, {
      method: 'POST',
      headers: { authorization: `Bearer ${zipToken}`, origin: WEB_ORIGIN },
      maxTime: '180',
    });
    const analyzeJson = parseJson(zipAnalyze.text);
    let rootStatus = null;
    let rootSnippet = null;
    let stage = analyzeJson?.stage || null;
    if (zipAnalyze.status >= 200 && zipAnalyze.status < 300 && stage === 'ANALYZE') {
      const roots = analyzeJson?.uncertainWebRoots || [];
      const rootPath = typeof roots[0] === 'string' ? roots[0] : roots[0]?.rootPath || '.';
      const rootPick = curlResolve(`${API_ORIGIN}/api/v1/onboarding/root`, API_HOST, {
        method: 'POST',
        headers: { authorization: `Bearer ${zipToken}`, origin: WEB_ORIGIN },
        body: JSON.stringify({ rootPath }),
        maxTime: '60',
      });
      rootStatus = rootPick.status;
      rootSnippet = redact(rootPick.text).slice(0, 300);
      stage = parseJson(rootPick.text)?.stage || stage;
    }
    const zipPlan = curlResolve(`${API_ORIGIN}/api/v1/onboarding/plan`, API_HOST, {
      method: 'POST',
      headers: { authorization: `Bearer ${zipToken}`, origin: WEB_ORIGIN },
      maxTime: '120',
    });
    const planJson = parseJson(zipPlan.text);
    out.zipPlan = {
      uploadStatus,
      uploadTimeSec: zt ? Number(zt[1]) : null,
      analyzeStatus: zipAnalyze.status,
      analyzeTimeSec: zipAnalyze.timeSec,
      analyzeStage: analyzeJson?.stage || null,
      analyzeSnippet: redact(zipAnalyze.text).slice(0, 400),
      rootStatus,
      rootSnippet,
      planStatus: zipPlan.status,
      planTimeSec: zipPlan.timeSec,
      planSnippet: redact(zipPlan.text).slice(0, 400),
      planHasLaunchRunId: Boolean(planJson?.launchRunId),
      planHasPrimaryLabel: Boolean(planJson?.primaryLabel),
      planOk:
        zipPlan.status >= 200 &&
        zipPlan.status < 300 &&
        Boolean(planJson?.launchRunId || planJson?.primaryLabel),
      planMessage: planJson?.message || planJson?.error || null,
      planKeys: planJson && typeof planJson === 'object' ? Object.keys(planJson).slice(0, 25) : [],
    };
  }
  console.log('ZIP_PLAN', JSON.stringify(out.zipPlan));

  if (out.cloneTiming?.ok && out.cloneTiming?.under60s) {
    out.conclusion =
      'HTTP/1.1+auth shallow clone succeeds <60s. Post-patch API logs lack GitError (hang/timeout not fail-fast). ANALYZE 504 aligns with nginx cutting long requests; check whether api-alpha has low/default proxy_read_timeout. Minimal fix: set proxy_read_timeout/proxy_send_timeout 300s on api-alpha only.';
  } else if (out.cloneTiming?.ok) {
    out.conclusion =
      'Clone OK but slow (>=60s). Raise api-alpha proxy timeouts; keep shallow HTTP/1.1.';
  } else {
    out.conclusion =
      'Authenticated HTTP/1.1 clone still failing inside container; fix clone/auth before blaming nginx. See cloneTiming.errorRedacted.';
  }

  writeFileSync(join(ARTIFACT_DIR, 'step314-timeout-diagnosis.json'), JSON.stringify(out, null, 2));
  console.log('\n========== DIAGNOSIS ==========');
  console.log(JSON.stringify(out, null, 2).slice(0, 12000));
} finally {
  await runner.disconnect().catch(() => {});
  await prisma.$disconnect().catch(() => {});
}
