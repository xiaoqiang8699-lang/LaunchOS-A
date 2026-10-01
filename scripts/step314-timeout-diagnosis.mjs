/**
 * Step 31.4 follow-up: logs, nginx timeouts, timed clone, zip plan.
 * Never print tokens/passwords/PEM.
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
    .replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//***:***@')
    .replace(/\$2[aby]\$\d+\$[./A-Za-z0-9]{50,}/g, '[BCRYPT_REDACTED]');
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
  const sm = out.match(/\n__STATUS__:(\d+)\s*$/m);
  const tm = out.match(/\n__TIME__:([0-9.]+)/);
  const text = out.replace(/\n__STATUS__:\d+\s*$/m, '').replace(/\n__TIME__:[0-9.]+\s*/g, '').trimEnd();
  return {
    status: sm ? Number(sm[1]) : 0,
    timeSec: tm ? Number(tm[1]) : null,
    text,
    err: redact(String(r.stderr || '')).slice(0, 300),
  };
}

async function remoteOk(runner, cmd, label, opts = {}) {
  const res = await runner.execute(shellCommand(cmd), { timeoutMs: opts.timeoutMs || 180000 });
  if (res.exitCode && res.exitCode !== 0) {
    const msg = redact(`${res.stdout || ''}\n${res.stderr || ''}`).slice(0, 800);
    throw new Error(`${label} failed ec=${res.exitCode}: ${msg}`);
  }
  return res;
}

const diagnosis = {
  logsPath: join(ARTIFACT_DIR, 'step314-after-patch-logs.txt'),
  logHits: {},
  nginxTimeouts: null,
  cloneTiming: null,
  analyzeTimingInference: null,
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
  console.log('[1] pull last 30m logs');
  await runner.writeTextFile(
    '/opt/launchos/bin/step314-after-logs.sh',
    `#!/bin/bash
set -u
CTR=${LIVE_CONTAINER}
REDACT="sed -E 's/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer|authorization)[=:][^ ]+/\\1=***/gi; s/gh[pousr]_[A-Za-z0-9_]{20,}/***/g; s/ghs_[A-Za-z0-9_]{20,}/***/g; s#x-access-token:[^[:space:]@]+#x-access-token:***#gi'"
echo '===SINCE_30M_FILTERED==='
podman logs --since 30m "$CTR" 2>&1 | eval "$REDACT" | grep -Ei 'ERROR|Exception|analyze|GitError|GitHub|clone|HTTP/1\\.1|resolveAuth|installation|multi-demo|Gateway|timeout|fail|stack|onboarding' | tail -n 400
echo '===SINCE_30M_TAIL==='
podman logs --since 30m "$CTR" 2>&1 | eval "$REDACT" | tail -n 250
echo '===TIMING_HINTS==='
podman logs --since 30m "$CTR" 2>&1 | eval "$REDACT" | grep -Ei 'POST.*/onboarding/analyze|analyzeCode|clone|GitError|took|duration|ms\\)|timeout|504' | tail -n 120
`,
  );
  const logsRun = await runner.execute(
    shellCommand('chmod 700 /opt/launchos/bin/step314-after-logs.sh && /opt/launchos/bin/step314-after-logs.sh'),
    { timeoutMs: 180000 },
  );
  const logsOut = redact(`${logsRun.stdout || ''}\n${logsRun.stderr || ''}`);
  writeFileSync(diagnosis.logsPath, logsOut);
  const needles = ['analyze', 'GitError', 'clone', 'HTTP/1.1', 'resolveAuth', 'ERROR', 'Exception', 'timeout', '504'];
  for (const n of needles) {
    const re = new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const lines = logsOut.split(/\r?\n/).filter((l) => re.test(l));
    diagnosis.logHits[n] = { count: lines.length, samples: lines.slice(0, 8).map((l) => l.slice(0, 240)) };
  }
  console.log('LOG_HITS', JSON.stringify(Object.fromEntries(Object.entries(diagnosis.logHits).map(([k, v]) => [k, v.count]))));

  console.log('[2] nginx timeouts for api-alpha');
  await runner.writeTextFile(
    '/opt/launchos/bin/step314-nginx-timeouts.sh',
    `#!/bin/bash
set -u
echo '===CONF_FILES==='
ls -la /etc/nginx/conf.d /etc/nginx/sites-enabled 2>/dev/null || true
find /etc/nginx -type f \\( -name '*alpha*' -o -name '*api-alpha*' -o -name '*zsaos*' \\) 2>/dev/null | head -n 40
echo '===GREP_TIMEOUTS==='
grep -RniE 'api-alpha|proxy_read_timeout|proxy_send_timeout|proxy_connect_timeout|send_timeout|client_body_timeout|fastcgi_read_timeout|uwsgi_read_timeout|proxy_pass' /etc/nginx 2>/dev/null | head -n 200
echo '===SITE_BLOCKS==='
for f in $(grep -Rl 'api-alpha.zsaos.com' /etc/nginx 2>/dev/null | head -n 20); do
  echo "---- $f ----"
  awk '/server_name[[:space:]]+api-alpha\\.zsaos\\.com/,/^[[:space:]]*}/' "$f" 2>/dev/null | head -n 120
  grep -nE 'proxy_|timeout|listen|server_name|location' "$f" | head -n 80
done
echo '===LAUNCHOS_NGINX==='
ls -la /opt/launchos/nginx /opt/launchos/etc/nginx 2>/dev/null || true
grep -RniE 'api-alpha|proxy_read_timeout|proxy_send_timeout|proxy_connect_timeout' /opt/launchos --include='*.conf' 2>/dev/null | head -n 120
`,
  );
  const ngx = await runner.execute(
    shellCommand('chmod 700 /opt/launchos/bin/step314-nginx-timeouts.sh && /opt/launchos/bin/step314-nginx-timeouts.sh'),
    { timeoutMs: 120000 },
  );
  const ngxOut = redact(`${ngx.stdout || ''}\n${ngx.stderr || ''}`);
  writeFileSync(join(ARTIFACT_DIR, 'step314-nginx-timeouts.txt'), ngxOut);
  const timeoutLines = ngxOut.split(/\r?\n/).filter((l) => /proxy_(read|send|connect)_timeout|send_timeout|api-alpha/i.test(l)).slice(0, 60);
  diagnosis.nginxTimeouts = {
    snippet: timeoutLines.join('\n').slice(0, 2500),
    hasProxyRead: /proxy_read_timeout/i.test(ngxOut),
  };
  console.log('NGINX_SNIPPET\n' + diagnosis.nginxTimeouts.snippet.slice(0, 1500));

  console.log('[3] timed private clone inside container');
  const connRows = await runner.execute(
    shellCommand(`podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -tAc "SELECT c.\\"installationId\\" FROM \\"GitHubConnection\\" c WHERE c.status='ACTIVE' AND c.login='xiaoqiang8699-lang' ORDER BY c.\\"updatedAt\\" DESC LIMIT 1"`),
    { timeoutMs: 60000 },
  );
  const installationId = String(connRows.stdout || '').trim().split(/\r?\n/).filter(Boolean)[0];
  if (!installationId) throw new Error('installationId missing');
  const issued = await createInstallationAccessToken(installationId);
  const probeEnvLocal = join(ARTIFACT_DIR, '.step314-clone-probe.env');
  writeFileSync(probeEnvLocal, `INSTALL_TOKEN=${issued.token}\n`, { mode: 0o600 });
  await runner.upload(probeEnvLocal, '/opt/launchos/tmp/step314-clone-probe.env');
  try {
    writeFileSync(probeEnvLocal, 'INSTALL_TOKEN=\n');
    unlinkSync(probeEnvLocal);
  } catch {
    /* ignore */
  }

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
  diagnosis.cloneTiming = {
    exitCode: ecM ? Number(ecM[1]) : cloneRun.exitCode,
    durationSec: durM ? Number(durM[1]) : null,
    errorRedacted: errM ? errM[1].slice(0, 220) : null,
    under60s: durM ? Number(durM[1]) < 60 : false,
    ok: ecM ? Number(ecM[1]) === 0 : false,
  };
  console.log('CLONE', JSON.stringify(diagnosis.cloneTiming));

  // timing inference from logs
  const timeSamples = (diagnosis.logHits.analyze?.samples || []).concat(diagnosis.logHits.GitError?.samples || []).slice(0, 12);
  diagnosis.analyzeTimingInference = {
    note: 'Infer hang vs fail-fast from log density + known curl max-time 180 and nginx 504',
    gitErrorCount: diagnosis.logHits.GitError?.count || 0,
    analyzeCount: diagnosis.logHits.analyze?.count || 0,
    timeoutCount: diagnosis.logHits.timeout?.count || 0,
    samples: timeSamples,
  };

  console.log('[4] zip analyze + plan');
  const zipPath = join(ARTIFACT_DIR, 'step31-smoke.zip');
  if (!existsSync(zipPath)) {
    diagnosis.zipPlan = { skipped: true, reason: 'zip missing' };
  } else {
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
      diagnosis.zipPlan = { ok: false, reason: 'login failed', loginStatus: zipLogin.status, snippet: redact(zipLogin.text).slice(0, 200) };
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
      const uploadTime = zt ? Number(zt[1]) : null;
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
      diagnosis.zipPlan = {
        uploadStatus,
        uploadTimeSec: uploadTime,
        analyzeStatus: zipAnalyze.status,
        analyzeTimeSec: zipAnalyze.timeSec,
        analyzeStage: analyzeJson?.stage || null,
        analyzeKeys: analyzeJson && typeof analyzeJson === 'object' ? Object.keys(analyzeJson).slice(0, 30) : [],
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
        planErrorMessage: planJson?.message || planJson?.error || null,
      };
    }
  }
  console.log('ZIP_PLAN', JSON.stringify(diagnosis.zipPlan));

  const cloneOkFast = diagnosis.cloneTiming?.ok && diagnosis.cloneTiming?.under60s;
  if (cloneOkFast) {
    diagnosis.conclusion =
      'Clone with HTTP/1.1+installation auth succeeds under 60s; private/public ANALYZE 504 is likely nginx proxy_read_timeout cutting long analyze (clone+scan) before API finishes. Minimal fix: raise proxy_read_timeout/proxy_send_timeout for api-alpha.zsaos.com only (e.g. 300s), and/or keep clone shallow + HTTP/1.1.';
  } else if (diagnosis.cloneTiming?.ok) {
    diagnosis.conclusion =
      'Clone works but is slow (>=60s); nginx 504 during analyze is consistent with proxy timeouts. Raise api-alpha proxy timeouts and keep shallow HTTP/1.1 clone.';
  } else {
    diagnosis.conclusion =
      'In-container authenticated HTTP/1.1 clone still failing; 504 may be secondary. Fix clone/auth path first. See cloneTiming.errorRedacted.';
  }

  writeFileSync(join(ARTIFACT_DIR, 'step314-timeout-diagnosis.json'), JSON.stringify(diagnosis, null, 2));
  console.log('\n========== DIAGNOSIS ==========');
  console.log(JSON.stringify({
    cloneTiming: diagnosis.cloneTiming,
    nginxHasProxyRead: diagnosis.nginxTimeouts?.hasProxyRead,
    nginxSnippet: diagnosis.nginxTimeouts?.snippet?.slice(0, 800),
    logHitCounts: Object.fromEntries(Object.entries(diagnosis.logHits).map(([k, v]) => [k, v.count])),
    logSamples: Object.fromEntries(Object.entries(diagnosis.logHits).map(([k, v]) => [k, v.samples.slice(0, 3)])),
    zipPlan: diagnosis.zipPlan,
    conclusion: diagnosis.conclusion,
  }, null, 2));
} finally {
  await runner.disconnect().catch(() => {});
  await prisma.$disconnect().catch(() => {});
}

