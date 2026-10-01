/**
 * Step 27 regression — redeploy existing Ceshi-project via managed worker.
 * Does not print secrets. Does not create paid resources.
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

const API = 'http://127.0.0.1:3001/api/v1';
const PROJECT_ID = process.argv[2] || 'cmumcbqn3001jriq8am7vxtf6';
const PLATFORM_HOST = '116.62.198.184';
const EXPECTED = 'LaunchOS First Real Deploy';

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
    throw new Error(
      `${method} ${path} → ${res.status}: ${
        Array.isArray(json?.message) ? json.message.join(',') : json?.message || res.statusText
      }`,
    );
  }
  return json;
}

async function httpGet(url) {
  const res = await fetch(url, { redirect: 'follow' });
  return { status: res.status, text: (await res.text()).slice(0, 300) };
}

const require = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = require('@launchos/database');
const prisma = new PrismaClient();

const report = {
  projectId: PROJECT_ID,
  deploymentId: null,
  serverScope: null,
  serverHost: null,
  status: null,
  visitUrl: null,
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
  const detail = await api(`/projects/${PROJECT_ID}`, { token });
  const env = (detail.environments || []).find((item) => item.name === 'production');
  if (!env) throw new Error('missing production env');

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
  report.serverInstanceId = created.serverInstanceId || created.deployment?.serverInstanceId;
  const server = await prisma.serverInstance.findUnique({
    where: { id: report.serverInstanceId },
    select: { host: true, scope: true },
  });
  report.serverHost = server?.host || null;
  report.serverScope = server?.scope || null;
  if (server?.scope !== 'PLATFORM_MANAGED' || server?.host !== PLATFORM_HOST) {
    throw new Error(`wrong node host=${server?.host} scope=${server?.scope}`);
  }

  let final = null;
  for (let i = 0; i < 90; i += 1) {
    await new Promise((r) => setTimeout(r, 5000));
    final = await api(`/deployments/${deploymentId}`, { token });
    report.status = final.status || final.deployment?.status;
    console.log(`poll#${i + 1} status=${report.status}`);
    if (['SUCCESS', 'FAILED', 'CANCELLED'].includes(report.status)) break;
  }

  report.visitUrl =
    final?.visitUrl ||
    final?.deployment?.visitUrl ||
    final?.systemDomain ||
    final?.deployment?.systemDomain ||
    null;
  const candidates = [
    report.visitUrl,
    'https://launchos-real-test.zsaos.com/',
    'https://launchos-real-test-mceb05.zsaos.com/',
  ].filter(Boolean);
  for (const url of candidates) {
    const normalized = url.startsWith('http') ? url : `https://${url}/`;
    try {
      const hit = await httpGet(normalized);
      if (hit.status === 200 && String(hit.text).includes(EXPECTED)) {
        report.publicHttp = { url: normalized, ...hit };
        report.bodyMatch = true;
        break;
      }
      if (!report.publicHttp) report.publicHttp = { url: normalized, ...hit };
    } catch (error) {
      if (!report.publicHttp) {
        report.publicHttp = {
          url: normalized,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  for (const host of [
    'api-launchos.zsaos.com',
    'web-launchos.zsaos.com',
    'oneclick-web.zsaos.com',
    'launchos-real-test.zsaos.com',
  ]) {
    try {
      const hit = await httpGet(`https://${host}/`);
      report.existingRoutes[host] = {
        status: hit.status,
        ok: hit.status >= 200 && hit.status < 500,
        bodySnippet: hit.text.slice(0, 80),
      };
    } catch (error) {
      report.existingRoutes[host] = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'SUCCESS' || !report.bodyMatch) process.exitCode = 1;
} catch (error) {
  console.error('REGRESSION_FAIL', error instanceof Error ? error.message : error);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
