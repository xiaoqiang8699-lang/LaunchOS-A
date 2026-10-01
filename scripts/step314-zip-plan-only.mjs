import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

const TARGET_HOST = '116.62.198.184';
const API_HOST = 'api-alpha.zsaos.com';
const WEB_ORIGIN = 'https://alpha.zsaos.com';
const API_ORIGIN = `https://${API_HOST}`;
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
const zipPath = join(ARTIFACT_DIR, 'step31-smoke.zip');

function redact(t) {
  return String(t || '')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[JWT_REDACTED]')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/Bearer\s+[A-Za-z0-9._\-+=/]+/gi, 'Bearer ***')
    .replace(/(PASSWORD|SECRET|TOKEN|authorization)[=:][^\s"']+/gi, '$1=***');
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function curlResolve(url, host, { method = 'GET', headers = {}, body, maxTime = '120', formFile } = {}) {
  const args = ['-k', '-sS', '-X', method, '--resolve', `${host}:443:${TARGET_HOST}`, '-w', '\n__STATUS__:%{http_code}\n__TIME__:%{time_total}', '--max-time', String(maxTime)];
  for (const [k, v] of Object.entries(headers)) {
    if (v == null) continue;
    args.push('-H', `${k}: ${v}`);
  }
  if (formFile) {
    args.push('-F', `file=@${formFile}`);
  } else if (body != null) {
    args.push('-H', 'content-type: application/json');
    args.push('--data-binary', body);
  }
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
  const out = String(r.stdout || '').replace(/\r/g, '');
  const sm = out.match(/\n__STATUS__:(\d+)/);
  const tm = out.match(/\n__TIME__:([0-9.]+)/);
  let text = out.replace(/\n__STATUS__:\d+\s*/g, '').replace(/\n__TIME__:[0-9.]+\s*/g, '').trim();
  // fallback: extract JSON object if parse markers interfered
  if (!parseJson(text)) {
    const m = out.match(/\{[\s\S]*\}/);
    if (m) text = m[0];
  }
  return { status: sm ? Number(sm[1]) : 0, timeSec: tm ? Number(tm[1]) : null, text };
}

const zipEmail = `alpha-s314-zipdiag2-${Date.now()}@zsaos.test`;
const zipPass = `Alpha${randomBytes(5).toString('hex')}!aA1`;
curlResolve(`${API_ORIGIN}/api/v1/auth/register`, API_HOST, {
  method: 'POST',
  headers: { origin: WEB_ORIGIN },
  body: JSON.stringify({ email: zipEmail, password: zipPass, name: 'S314ZipDiag2' }),
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
  console.log(JSON.stringify({ ok: false, reason: 'login failed', loginStatus: zipLogin.status, snippet: redact(zipLogin.text).slice(0, 200) }));
  process.exit(1);
}

const upload = curlResolve(`${API_ORIGIN}/api/v1/onboarding/source/zip`, API_HOST, {
  method: 'POST',
  headers: { authorization: `Bearer ${zipToken}`, origin: WEB_ORIGIN },
  formFile: zipPath,
  maxTime: '180',
});
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
const result = {
  uploadStatus: upload.status,
  uploadTimeSec: upload.timeSec,
  analyzeStatus: zipAnalyze.status,
  analyzeTimeSec: zipAnalyze.timeSec,
  analyzeStage: analyzeJson?.stage || null,
  analyzeSnippet: redact(zipAnalyze.text).slice(0, 400),
  analyzeKeys: analyzeJson ? Object.keys(analyzeJson).slice(0, 30) : [],
  uncertainWebRoots: analyzeJson?.uncertainWebRoots || null,
  rootStatus,
  rootSnippet,
  planStatus: zipPlan.status,
  planTimeSec: zipPlan.timeSec,
  planSnippet: redact(zipPlan.text).slice(0, 400),
  planKeys: planJson ? Object.keys(planJson).slice(0, 30) : [],
  planHasLaunchRunId: Boolean(planJson?.launchRunId),
  planHasPrimaryLabel: Boolean(planJson?.primaryLabel),
  planMessage: planJson?.message || planJson?.error || null,
  planOk: zipPlan.status >= 200 && zipPlan.status < 300 && Boolean(planJson?.launchRunId || planJson?.primaryLabel),
  whyPlanOkFalse:
    zipAnalyze.status === 201
      ? !planJson
        ? 'plan response not JSON'
        : zipPlan.status >= 400
          ? `plan HTTP ${zipPlan.status}: ${planJson?.message || planJson?.error || 'no message'}`
          : !(planJson?.launchRunId || planJson?.primaryLabel)
            ? `plan HTTP ${zipPlan.status} but missing launchRunId/primaryLabel (stage=${planJson?.stage || analyzeJson?.stage || null})`
            : null
      : `analyzeStatus=${zipAnalyze.status}`,
};
writeFileSync(join(ARTIFACT_DIR, 'step314-zip-plan.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));

// scrub prior JWT leak in diagnosis json
const diagPath = join(ARTIFACT_DIR, 'step314-timeout-diagnosis.json');
if (existsSync(diagPath)) {
  const scrubbed = redact(readFileSync(diagPath, 'utf8'));
  writeFileSync(diagPath, scrubbed);
}

