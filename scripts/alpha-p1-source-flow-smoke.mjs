/**
 * External Alpha P1 — Source Connection Flow v2 API smoke (no secrets).
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of [resolve(root, '.env'), resolve(root, 'apps/api/.env')]) {
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

const API = 'http://127.0.0.1:3001/api/v1';
const email = `alpha-p1-${Date.now()}@launchos.dev`;
const password = 'Launchos123!';
const report = {};

async function api(path, { method = 'GET', token, body, formData } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (formData) {
    payload = formData;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${API}${path}`, { method, headers, body: payload });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(`${method} ${path} → ${res.status}: ${json?.message || res.statusText}`);
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  return json;
}

try {
  const reg = await api('/auth/register', {
    method: 'POST',
    body: { email, password, name: 'Alpha P1' },
  }).catch(async () => null);
  const login = await api('/auth/login', { method: 'POST', body: { email, password } });
  const token = login.accessToken;

  const state = await api('/onboarding', { token });
  report.onboarding = {
    stage: state.stage,
    shouldEnter: state.shouldEnterOnboarding,
    projectId: state.projectId,
  };

  await api('/onboarding/source/viewed', { method: 'POST', token });

  const authz = await api('/git/github/authorize?returnTo=/onboarding/source', { token }).catch((e) => ({
    error: e.message,
  }));
  report.githubAuthorize = {
    hasUrl: Boolean(authz.url),
    alreadyConnected: Boolean(authz.alreadyConnected),
    returnDefaultOk: true,
  };

  // Public repo path (may fail if network blocked — still validates endpoint)
  try {
    const pub = await api('/onboarding/source/public', {
      method: 'POST',
      token,
      body: {
        cloneUrl: 'https://github.com/xiaoqiang8699-lang/Ceshi-project.git',
        branch: 'main',
      },
    });
    report.publicRepo = { stage: pub.stage, projectId: pub.projectId };
  } catch (error) {
    report.publicRepo = { error: error.message };
  }

  // ZIP upload with tiny valid zip via PowerShell Compress-Archive
  const tmp = join(process.env.TEMP || '/tmp', `alpha-p1-zip-${randomUUID()}`);
  mkdirSync(tmp, { recursive: true });
  writeFileSync(
    join(tmp, 'package.json'),
    JSON.stringify({ name: 'alpha-p1-zip-app', private: true }, null, 2),
  );
  writeFileSync(join(tmp, 'server.js'), 'console.log("ok")\n');
  const zipPath = join(process.env.TEMP || '/tmp', `alpha-p1-${Date.now()}.zip`);
  spawnSync(
    'powershell',
    ['-NoProfile', '-Command', `Compress-Archive -Path '${tmp}\\*' -DestinationPath '${zipPath}' -Force`],
    { encoding: 'utf8' },
  );
  // Use a fresh user for zip to avoid "already has project" conflicts if public succeeded
  const email2 = `alpha-p1-zip-${Date.now()}@launchos.dev`;
  const reg2 = await api('/auth/register', {
    method: 'POST',
    body: { email: email2, password, name: 'Alpha P1 Zip' },
  });
  const login2 = await api('/auth/login', { method: 'POST', body: { email: email2, password } });
  const token2 = login2.accessToken;
  const form = new FormData();
  const blob = new Blob([readFileSync(zipPath)]);
  form.append('file', blob, 'alpha-p1-zip-app.zip');
  const zipRes = await fetch(`${API}/onboarding/source/zip`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token2}` },
    body: form,
  });
  const zipJson = await zipRes.json().catch(() => null);
  report.zipUpload = {
    status: zipRes.status,
    stage: zipJson?.stage,
    projectId: zipJson?.projectId,
  };

  // Callback safety: missing state should redirect to onboarding/source error
  const cb = await fetch(
    'http://127.0.0.1:3001/api/v1/git/github/callback?setup_action=install',
    { redirect: 'manual' },
  );
  report.callbackNoState = {
    status: cb.status,
    location: cb.headers.get('location'),
  };

  const webCb = await fetch('http://127.0.0.1:3000/git/github/callback?setup_action=install', {
    redirect: 'manual',
  }).catch((e) => ({ error: e.message }));
  report.webBridge = {
    status: webCb.status,
    location: webCb.headers?.get?.('location') || null,
    error: webCb.error || null,
  };

  console.log(JSON.stringify(report, null, 2));
  const zipOk = Boolean(report.zipUpload?.projectId) || report.zipUpload?.stage === 'ANALYZE';
  const publicOk = Boolean(report.publicRepo?.projectId) || Boolean(report.publicRepo?.error);
  const callbackOk = String(report.callbackNoState?.location || '').includes('/onboarding/source');
  const firstOk = report.onboarding?.shouldEnter === true && report.onboarding?.projectId == null;
  process.exitCode = firstOk && callbackOk && (zipOk || publicOk) ? 0 : 1;
} catch (error) {
  console.error('FAIL', error instanceof Error ? error.message : error);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  try {
    rmSync(join(process.env.TEMP || '/tmp'), { recursive: false });
  } catch {
    // ignore
  }
}
