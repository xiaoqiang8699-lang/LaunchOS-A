import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const PROJECT_ID = process.argv[2] || 'cmumcbqn3001jriq8am7vxtf6';
const EXPECTED_BODY = 'LaunchOS First Real Deploy';
const PUBLIC_HOST = 'launchos-real-test.zsaos.com';
const PLATFORM_HOST = '116.62.198.184';

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
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 800) };
  }
  if (!res.ok) {
    const message = Array.isArray(json?.message)
      ? json.message.join(',')
      : json?.message || res.statusText;
    throw new Error(`${method} ${path} → ${res.status}: ${message}`);
  }
  return json;
}

async function httpGet(url) {
  const res = await fetch(url, { redirect: 'follow' });
  const text = await res.text();
  return { status: res.status, text: text.slice(0, 400) };
}

const require = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = require('@launchos/database');
const prisma = new PrismaClient();

const report = {
  projectId: PROJECT_ID,
  deploymentId: null,
  serverInstanceId: null,
  serverHost: null,
  serverScope: null,
  status: null,
  publicUrl: `https://${PUBLIC_HOST}/`,
  publicHttp: null,
  bodyMatch: false,
  existingRoutes: {},
};

try {
  const login = await api('/auth/login', {
    method: 'POST',
    body: {
      email: 'xiaoqiang8699@gmail.com',
      password: process.env.E2E_PASSWORD || 'Launchos123!',
    },
  });
  const token = login.accessToken;

  console.log('analyze…');
  const analysis = await api(`/projects/${PROJECT_ID}/code-analysis`, { method: 'POST', token });
  console.log(
    JSON.stringify({
      framework: analysis.result?.framework || analysis.analysis?.framework || null,
      units: (analysis.result?.units || []).map((u) => ({
        id: u.id,
        deployable: u.deployable,
        framework: u.framework,
      })),
    }),
  );

  const detail = await api(`/projects/${PROJECT_ID}`, { token });
  const env = (detail.environments || []).find((item) => item.name === 'production');
  if (!env) throw new Error('production environment missing');

  console.log('create deployment…');
  const created = await api(`/projects/${PROJECT_ID}/deployments`, {
    method: 'POST',
    token,
    body: {
      environmentId: env.id,
      hostingMode: 'launchos',
      targetType: 'MANAGED_SERVER',
    },
  });
  const deploymentId = created.id || created.deployment?.id;
  report.deploymentId = deploymentId;
  report.serverInstanceId = created.serverInstanceId || created.deployment?.serverInstanceId || null;
  console.log(
    JSON.stringify({
      deploymentId,
      status: created.status || created.deployment?.status,
      serverInstanceId: report.serverInstanceId,
    }),
  );

  const server = await prisma.serverInstance.findUnique({
    where: { id: report.serverInstanceId },
    select: { host: true, scope: true, workspaceId: true },
  });
  report.serverHost = server?.host || null;
  report.serverScope = server?.scope || null;
  if (server?.scope !== 'PLATFORM_MANAGED' || server?.host !== PLATFORM_HOST) {
    throw new Error(`Wrong node: host=${server?.host} scope=${server?.scope}`);
  }

  let final = null;
  for (let i = 0; i < 90; i += 1) {
    await new Promise((r) => setTimeout(r, 5000));
    final = await api(`/deployments/${deploymentId}`, { token });
    report.status = final.status || final.deployment?.status;
    console.log(`poll#${i + 1} status=${report.status}`);
    if (report.status === 'SUCCESS' || report.status === 'FAILED' || report.status === 'CANCELLED') {
      break;
    }
  }

  try {
    report.publicHttp = await httpGet(report.publicUrl);
    report.bodyMatch = String(report.publicHttp.text || '').includes(EXPECTED_BODY);
  } catch (error) {
    report.publicHttp = { error: error instanceof Error ? error.message : String(error) };
  }

  for (const host of ['api-launchos.zsaos.com', 'web-launchos.zsaos.com', 'oneclick-web.zsaos.com']) {
    try {
      const result = await httpGet(`https://${host}/`);
      report.existingRoutes[host] = {
        status: result.status,
        ok: result.status >= 200 && result.status < 500,
      };
    } catch (error) {
      report.existingRoutes[host] = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (report.status === 'FAILED') {
    const steps = await prisma.deploymentStep.findMany({
      where: { deploymentId },
      orderBy: { order: 'asc' },
      select: { name: true, status: true, errorMessage: true },
    });
    report.failedSteps = steps
      .filter((s) => s.status === 'FAILED')
      .map((s) => ({ name: s.name, error: s.errorMessage?.slice(0, 300) || null }));
  }

  console.log('\n=== STEP26_PUBLIC_DEPLOY_RESULT ===');
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'SUCCESS' || !report.bodyMatch) process.exitCode = 1;
} catch (error) {
  console.error('STEP26_FAIL', error instanceof Error ? error.message : error);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
