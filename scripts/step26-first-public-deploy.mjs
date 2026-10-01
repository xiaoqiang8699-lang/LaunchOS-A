/**
 * Step 26 — First Real Public Deployment
 * Creates a launchos-hosted deploy of Ceshi-project onto the PLATFORM_MANAGED node.
 * Does not print secrets. Does not create paid cloud resources.
 */
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

const API = process.env.API_BASE || 'http://127.0.0.1:3001/api/v1';
const REPO = 'https://github.com/xiaoqiang8699-lang/Ceshi-project.git';
const EXPECTED_BODY = 'LaunchOS First Real Deploy';
const PUBLIC_HOST = 'launchos-real-test.zsaos.com';
const PLATFORM_HOST = '116.62.198.184';
const EMAIL = process.env.E2E_EMAIL || 'step20-check@launchos.dev';
const PASSWORD = process.env.E2E_PASSWORD || 'Launchos123!';

function assertNoSecret(json, label) {
  const blob = typeof json === 'string' ? json : JSON.stringify(json);
  if (/redis:\/\/[^:\s]+:[^@\s]+@/i.test(blob)) throw new Error(`REDIS_URL leak in ${label}`);
  if (/postgres(ql)?:\/\/[^:\s]+:[^@\s]+@/i.test(blob)) throw new Error(`DATABASE_URL leak in ${label}`);
  if (/LTAI[A-Za-z0-9]{12,}/.test(blob)) throw new Error(`ALIYUN AK leak in ${label}`);
  if (/"password"\s*:\s*"[^"*]{4,}"/i.test(blob)) throw new Error(`password leak in ${label}`);
}

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
    json = { raw: text.slice(0, 500) };
  }
  if (!res.ok) {
    const message = Array.isArray(json?.message)
      ? json.message.join(',')
      : json?.message || res.statusText;
    const err = new Error(`${method} ${path} → ${res.status}: ${message}`);
    err.code = json?.code;
    err.payload = json;
    throw err;
  }
  assertNoSecret(json, path);
  return json;
}

async function httpGet(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { Accept: 'text/plain,*/*' },
  });
  const text = await res.text();
  return { status: res.status, text: text.slice(0, 500), finalUrl: res.url };
}

const require = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = require('@launchos/database');
const prisma = new PrismaClient();

const report = {
  loginEmail: EMAIL,
  projectId: null,
  deploymentId: null,
  serverInstanceId: null,
  serverHost: null,
  serverScope: null,
  status: null,
  publicUrl: `https://${PUBLIC_HOST}/`,
  publicHttp: null,
  bodyMatch: false,
  existingRoutes: {},
  containersBefore: null,
  containersAfter: null,
};

try {
  console.log('login…');
  let login;
  try {
    login = await api('/auth/login', {
      method: 'POST',
      body: { email: EMAIL, password: PASSWORD },
    });
  } catch (error) {
    console.log('primary login failed, trying fallback email…');
    login = await api('/auth/login', {
      method: 'POST',
      body: {
        email: 'xiaoqiang8699@gmail.com',
        password: PASSWORD,
      },
    });
    report.loginEmail = 'xiaoqiang8699@gmail.com';
  }
  const token = login.accessToken;
  assertNoSecret(login, 'login');

  console.log('create project…');
  const project = await api('/projects', {
    method: 'POST',
    token,
    body: {
      name: 'launchos-real-test',
      type: 'WEB',
      applicationPurpose: 'WEBSITE',
      description: 'Step 26 First Real Public Deployment',
      source: {
        type: 'GITHUB',
        url: REPO,
        branch: 'main',
        fullName: 'xiaoqiang8699-lang/Ceshi-project',
        isPrivate: false,
      },
      defaultBranch: 'main',
    },
  });
  report.projectId = project.id;
  console.log(JSON.stringify({ projectId: project.id, slug: project.slug, sourceUrl: project.sourceUrl }));

  console.log('create environment…');
  let environment;
  try {
    environment = await api(`/projects/${project.id}/environments`, {
      method: 'POST',
      token,
      body: { type: 'production', name: 'production' },
    });
  } catch (error) {
    if (!String(error.message).includes('already exists')) throw error;
    const detail = await api(`/projects/${project.id}`, { token });
    environment = (detail.environments || []).find((item) => item.name === 'production');
    if (!environment) throw error;
  }
  console.log(JSON.stringify({ environmentId: environment.id }));

  console.log('analyze…');
  const analysis = await api(`/projects/${project.id}/code-analysis`, {
    method: 'POST',
    token,
  });
  console.log(
    JSON.stringify({
      framework: analysis.result?.framework || analysis.analysis?.framework || null,
      deployable: analysis.result?.deployable ?? analysis.analysis?.deployable ?? null,
    }),
  );

  console.log('create deployment (hostingMode=launchos)…');
  const created = await api(`/projects/${project.id}/deployments`, {
    method: 'POST',
    token,
    body: {
      environmentId: environment.id,
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
      targetType: created.targetType || created.deployment?.targetType,
    }),
  );

  if (report.serverInstanceId) {
    const server = await prisma.serverInstance.findUnique({
      where: { id: report.serverInstanceId },
      select: { host: true, scope: true, workspaceId: true },
    });
    report.serverHost = server?.host || null;
    report.serverScope = server?.scope || null;
    if (server?.scope !== 'PLATFORM_MANAGED' || server?.host !== PLATFORM_HOST) {
      throw new Error(
        `Wrong managed node selected: host=${server?.host} scope=${server?.scope}`,
      );
    }
  }

  let final = null;
  for (let i = 0; i < 90; i += 1) {
    await new Promise((r) => setTimeout(r, 5000));
    final = await api(`/deployments/${deploymentId}`, { token });
    const st = final.status || final.deployment?.status;
    report.status = st;
    console.log(`poll#${i + 1} status=${st}`);
    if (st === 'SUCCESS' || st === 'FAILED' || st === 'CANCELLED') break;
  }

  const domain = (final.systemDomain || final.deployment?.systemDomain || PUBLIC_HOST).replace(
    /^https?:\/\//,
    '',
  );
  report.publicUrl = `https://${domain.replace(/\/$/, '')}/`;

  try {
    report.publicHttp = await httpGet(report.publicUrl);
    report.bodyMatch = String(report.publicHttp.text || '').includes(EXPECTED_BODY);
  } catch (error) {
    report.publicHttp = { error: error instanceof Error ? error.message : String(error) };
  }

  for (const host of ['api-launchos.zsaos.com', 'web-launchos.zsaos.com', 'oneclick-web.zsaos.com']) {
    try {
      const result = await httpGet(`https://${host}/`);
      report.existingRoutes[host] = { status: result.status, ok: result.status >= 200 && result.status < 500 };
    } catch (error) {
      report.existingRoutes[host] = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  console.log('\n=== STEP26_PUBLIC_DEPLOY_RESULT ===');
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'SUCCESS' || !report.bodyMatch) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error('STEP26_FAIL', error instanceof Error ? error.message : error);
  if (error?.payload) {
    console.error(JSON.stringify({ code: error.code || null, payload: error.payload }, null, 2));
  }
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
