/**
 * Step 28 A/B/C + rollback regression against Ceshi-project / launchos-real-test.
 * Pushes version bodies to the test repo, then deploys via API.
 * Does not print secrets. Does not create paid resources.
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const API = 'http://127.0.0.1:3001/api/v1';
const PROJECT_ID = process.env.STEP28_PROJECT_ID || 'cmumcbqn3001jriq8am7vxtf6';
const PUBLIC_URL = 'https://launchos-real-test.zsaos.com/';
const REPO = 'https://github.com/xiaoqiang8699-lang/Ceshi-project.git';
const work = join(process.env.TEMP || '/tmp', `launchos-step28-${Date.now()}`);

async function api(path, { method = 'GET', token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${API}${path}`, { method, headers, body: payload });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(
      `${method} ${path} → ${res.status}: ${
        Array.isArray(json?.message) ? json.message.join(',') : json?.message || res.statusText
      }`,
    );
    err.status = res.status;
    err.code = json?.code;
    err.payload = json;
    throw err;
  }
  return json;
}

async function httpGet(url) {
  const res = await fetch(url, { redirect: 'follow' });
  return { status: res.status, text: (await res.text()).slice(0, 200) };
}

function git(args, cwd = work) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
  return (r.stdout || '').trim();
}

function writeApp(bodyText, mode = 'ok') {
  if (mode === 'crash') {
    writeFileSync(
      join(work, 'server.js'),
      `console.error('intentional crash for Step28 Version B');\nprocess.exit(1);\n`,
      'utf8',
    );
  } else {
    writeFileSync(
      join(work, 'server.js'),
      `const http = require('http');\nconst port = Number(process.env.PORT || 3000);\nconst server = http.createServer((_req, res) => {\n  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });\n  res.end('${bodyText}\\n');\n});\nserver.listen(port, '0.0.0.0');\n`,
      'utf8',
    );
  }
  writeFileSync(
    join(work, 'package.json'),
    JSON.stringify(
      {
        name: 'launchos-real-deploy-test-app',
        private: true,
        scripts: { start: 'node server.js' },
      },
      null,
      2,
    ),
    'utf8',
  );
}

async function deploy(token, environmentId, label) {
  const created = await api(`/projects/${PROJECT_ID}/deployments`, {
    method: 'POST',
    token,
    body: {
      environmentId,
      hostingMode: 'launchos',
      targetType: 'MANAGED_SERVER',
      idempotencyKey: `step28-${label}-${Date.now()}`,
    },
  });
  const id = created.id || created.deployment?.id;
  let final = null;
  for (let i = 0; i < 90; i += 1) {
    await new Promise((r) => setTimeout(r, 5000));
    final = await api(`/deployments/${id}`, { token });
    const st = final.status || final.deployment?.status;
    console.log(`${label} poll#${i + 1} status=${st} failureCode=${final.failureCode || '-'}`);
    if (['SUCCESS', 'FAILED', 'CANCELLED'].includes(st)) break;
  }
  return { id, final };
}

const require = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = require('@launchos/database');
const prisma = new PrismaClient();
const report = {
  versionA: null,
  versionB: null,
  versionC: null,
  rollback: null,
  publicAfterB: null,
  publicAfterC: null,
  publicAfterRollback: null,
  existingRoutes: {},
  queueIsolation: null,
  duplicateClick: null,
  workerCrash: null,
};

try {
  mkdirSync(work, { recursive: true });
  git(['clone', REPO, work]);
  git(['checkout', 'main']);

  const login = await api('/auth/login', {
    method: 'POST',
    body: {
      email: 'xiaoqiang8699@gmail.com',
      password: process.env.E2E_PASSWORD || 'Launchos123!',
    },
  });
  const token = login.accessToken;
  const project = await api(`/projects/${PROJECT_ID}`, { token });
  const environmentId = (project.environments || []).find((e) => e.name === 'production')?.id;
  if (!environmentId) throw new Error('missing production env');

  // Duplicate click during Version A create
  writeApp('LaunchOS Release A', 'ok');
  git(['add', '.']);
  git(['commit', '-m', 'Step28 Release A']);
  git(['push', 'origin', 'main']);

  const aKey = `step28-A-${Date.now()}`;
  const first = await api(`/projects/${PROJECT_ID}/deployments`, {
    method: 'POST',
    token,
    body: {
      environmentId,
      hostingMode: 'launchos',
      targetType: 'MANAGED_SERVER',
      idempotencyKey: aKey,
    },
  });
  let dupStatus = null;
  try {
    await api(`/projects/${PROJECT_ID}/deployments`, {
      method: 'POST',
      token,
      body: {
        environmentId,
        hostingMode: 'launchos',
        targetType: 'MANAGED_SERVER',
        idempotencyKey: `step28-A-dup-${Date.now()}`,
      },
    });
    dupStatus = 'NOT_BLOCKED';
  } catch (error) {
    dupStatus = error.code || String(error.status) || 'blocked';
  }
  // Same idempotency key should return same deployment
  const same = await api(`/projects/${PROJECT_ID}/deployments`, {
    method: 'POST',
    token,
    body: {
      environmentId,
      hostingMode: 'launchos',
      targetType: 'MANAGED_SERVER',
      idempotencyKey: aKey,
    },
  });
  report.duplicateClick = {
    firstId: first.id,
    sameId: same.id,
    sameOk: same.id === first.id,
    secondCode: dupStatus,
  };

  let finalA = null;
  let killedWorker = false;
  for (let i = 0; i < 90; i += 1) {
    await new Promise((r) => setTimeout(r, 5000));
    finalA = await api(`/deployments/${first.id}`, { token });
    console.log(`A poll#${i + 1} status=${finalA.status} stage=${finalA.currentStage || '-'}`);
    if (!killedWorker && finalA.status === 'RUNNING' && i >= 1) {
      // Worker crash regression: kill node worker; supervisor must restart.
      try {
        const { spawnSync } = await import('node:child_process');
        spawnSync(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*dist\\main.js*' -and $_.Name -eq 'node.exe' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
          ],
          { encoding: 'utf8' },
        );
        killedWorker = true;
        report.workerCrash = { killedAtPoll: i + 1, deploymentId: first.id };
        console.log('worker crash injected during Version A');
      } catch (error) {
        report.workerCrash = { error: error instanceof Error ? error.message : String(error) };
      }
    }
    if (['SUCCESS', 'FAILED', 'CANCELLED'].includes(finalA.status)) break;
  }
  report.versionA = { id: first.id, final: finalA };
  report.publicAfterA = await httpGet(PUBLIC_URL);

  writeApp('LaunchOS Release B', 'crash');
  git(['add', '.']);
  git(['commit', '-m', 'Step28 Release B crash on start']);
  git(['push', 'origin', 'main']);
  report.versionB = await deploy(token, environmentId, 'B');
  report.publicAfterB = await httpGet(PUBLIC_URL);

  writeApp('LaunchOS Release C', 'ok');
  git(['add', '.']);
  git(['commit', '-m', 'Step28 Release C']);
  git(['push', 'origin', 'main']);
  report.versionC = await deploy(token, environmentId, 'C');
  report.publicAfterC = await httpGet(PUBLIC_URL);

  const env = await prisma.projectEnvironment.findUnique({
    where: { id: environmentId },
    select: { activeDeploymentId: true, previousDeploymentId: true },
  });
  report.pointersAfterC = env;

  const rb = await api(`/apps/${PROJECT_ID}/environments/${environmentId}/rollback`, {
    method: 'POST',
    token,
  });
  const rbId = rb.id || rb.deployment?.id;
  let rbFinal = null;
  for (let i = 0; i < 90; i += 1) {
    await new Promise((r) => setTimeout(r, 5000));
    rbFinal = await api(`/deployments/${rbId}`, { token });
    console.log(`rollback poll#${i + 1} status=${rbFinal.status}`);
    if (['SUCCESS', 'FAILED', 'CANCELLED'].includes(rbFinal.status)) break;
  }
  report.rollback = { id: rbId, status: rbFinal?.status, meta: rb.rollback || null };
  report.publicAfterRollback = await httpGet(PUBLIC_URL);
  report.pointersAfterRollback = await prisma.projectEnvironment.findUnique({
    where: { id: environmentId },
    select: { activeDeploymentId: true, previousDeploymentId: true },
  });

  for (const host of [
    'api-launchos.zsaos.com',
    'web-launchos.zsaos.com',
    'oneclick-web.zsaos.com',
    'launchos-real-test.zsaos.com',
  ]) {
    report.existingRoutes[host] = await httpGet(`https://${host}/`);
  }

  console.log(JSON.stringify(report, null, 2));
  const ok =
    report.versionA?.final?.status === 'SUCCESS' &&
    report.publicAfterA?.text?.includes('LaunchOS Release A') &&
    report.versionB?.final?.status === 'FAILED' &&
    report.publicAfterB?.text?.includes('LaunchOS Release A') &&
    report.versionC?.final?.status === 'SUCCESS' &&
    report.publicAfterC?.text?.includes('LaunchOS Release C') &&
    report.rollback?.status === 'SUCCESS' &&
    report.publicAfterRollback?.text?.includes('LaunchOS Release A');
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  console.error('STEP28_REGRESSION_FAIL', error instanceof Error ? error.message : error);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
  rmSync(work, { recursive: true, force: true });
}
