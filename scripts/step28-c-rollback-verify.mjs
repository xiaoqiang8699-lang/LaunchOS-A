/**
 * Step 28 follow-up: deploy Release C, verify public bodies, rollback to A.
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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const API = 'http://127.0.0.1:3001/api/v1';
const PROJECT_ID = 'cmumcbqn3001jriq8am7vxtf6';
const PUBLIC_URL = 'https://launchos-real-test.zsaos.com/';
const SYSTEM_URL = 'https://launchos-real-test-mceb05.zsaos.com/';
const REAL_IP = '116.62.198.184';
const REPO = 'https://github.com/xiaoqiang8699-lang/Ceshi-project.git';
const work = join(process.env.TEMP || '/tmp', `launchos-step28b-${Date.now()}`);

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
    throw new Error(`${method} ${path} → ${res.status}: ${json?.message || res.statusText}`);
  }
  return json;
}

function curlHost(url, host) {
  const r = spawnSync(
    'curl.exe',
    ['-sS', '-k', '--resolve', `${host}:443:${REAL_IP}`, url, '--max-time', '20'],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`curl ${host} failed: ${r.stderr}`);
  return (r.stdout || '').trim();
}

function git(args) {
  const r = spawnSync('git', args, { cwd: work, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`);
  return (r.stdout || '').trim();
}

async function waitDeploy(token, id, label) {
  let final = null;
  for (let i = 0; i < 90; i += 1) {
    await new Promise((r) => setTimeout(r, 5000));
    final = await api(`/deployments/${id}`, { token });
    console.log(`${label} poll#${i + 1} status=${final.status} failure=${final.failureCode || '-'}`);
    if (['SUCCESS', 'FAILED', 'CANCELLED'].includes(final.status)) break;
  }
  return final;
}

const require = createRequire(resolve(root, 'packages/database/package.json'));
const { PrismaClient } = require('@launchos/database');
const prisma = new PrismaClient();
const report = {};

try {
  mkdirSync(work, { recursive: true });
  git(['clone', REPO, work]);
  writeFileSync(
    join(work, 'server.js'),
    `const http = require('http');\nconst port = Number(process.env.PORT || 3000);\nconst server = http.createServer((_req, res) => {\n  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });\n  res.end('LaunchOS Release C\\n');\n});\nserver.listen(port, '0.0.0.0');\n`,
  );
  git(['add', '.']);
  git(['commit', '-m', 'Step28 Release C ensure', '--allow-empty']);
  git(['push', 'origin', 'main']);

  const login = await api('/auth/login', {
    method: 'POST',
    body: { email: 'xiaoqiang8699@gmail.com', password: process.env.E2E_PASSWORD || 'Launchos123!' },
  });
  const token = login.accessToken;
  const project = await api(`/projects/${PROJECT_ID}`, { token });
  const environmentId = (project.environments || []).find((e) => e.name === 'production')?.id;

  report.before = {
    public: curlHost(PUBLIC_URL, 'launchos-real-test.zsaos.com'),
    system: curlHost(SYSTEM_URL, 'launchos-real-test-mceb05.zsaos.com'),
  };

  const created = await api(`/projects/${PROJECT_ID}/deployments`, {
    method: 'POST',
    token,
    body: {
      environmentId,
      hostingMode: 'launchos',
      targetType: 'MANAGED_SERVER',
      idempotencyKey: `step28-C2-${Date.now()}`,
    },
  });
  report.versionC = await waitDeploy(token, created.id, 'C');
  report.afterC = {
    public: curlHost(PUBLIC_URL, 'launchos-real-test.zsaos.com'),
    system: curlHost(SYSTEM_URL, 'launchos-real-test-mceb05.zsaos.com'),
  };
  report.pointersAfterC = await prisma.projectEnvironment.findUnique({
    where: { id: environmentId },
    select: { activeDeploymentId: true, previousDeploymentId: true },
  });

  const rb = await api(`/apps/${PROJECT_ID}/environments/${environmentId}/rollback`, {
    method: 'POST',
    token,
  });
  report.rollback = await waitDeploy(token, rb.id || rb.deployment?.id, 'rollback');
  report.afterRollback = {
    public: curlHost(PUBLIC_URL, 'launchos-real-test.zsaos.com'),
    system: curlHost(SYSTEM_URL, 'launchos-real-test-mceb05.zsaos.com'),
  };
  report.pointersAfterRollback = await prisma.projectEnvironment.findUnique({
    where: { id: environmentId },
    select: { activeDeploymentId: true, previousDeploymentId: true },
  });

  for (const host of ['api-launchos.zsaos.com', 'web-launchos.zsaos.com', 'oneclick-web.zsaos.com']) {
    report[host] = curlHost(`https://${host}/`, host).slice(0, 80);
  }

  console.log(JSON.stringify(report, null, 2));
  const ok =
    report.before.public.includes('LaunchOS Release A') &&
    report.versionC?.status === 'SUCCESS' &&
    report.afterC.public.includes('LaunchOS Release C') &&
    report.afterC.system.includes('LaunchOS Release C') &&
    report.rollback?.status === 'SUCCESS' &&
    report.afterRollback.public.includes('LaunchOS Release A');
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  console.error('FAIL', error instanceof Error ? error.message : error);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
  rmSync(work, { recursive: true, force: true });
}
