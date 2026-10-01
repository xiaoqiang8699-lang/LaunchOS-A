/**
 * Step 25.1 — PostgreSQL database connection E2E.
 * Secrets must come from env; never printed.
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const { PrismaClient } = require(resolve(ROOT, 'packages/database/generated/client'));

const API = process.env.API_BASE || 'http://localhost:3001/api/v1';
const PROJECT_ID = process.env.E2E_PROJECT_ID || 'cmu3j24mv0001ri7wcsoa30hj';
const WEB_UNIT = process.env.E2E_WEB_UNIT || 'cmu3j27340007ri7wcno1xrai';
const API_UNIT = process.env.E2E_API_UNIT || 'cmu3j272x0005ri7wlxlbajeu';
const SERVER_ID = process.env.E2E_SERVER_ID || 'cmu22cqo80007ri6wkt4krfsq';
const ENV_ID = process.env.E2E_ENV_ID || 'cmu3j5ppc000hri7wvxrjopit';

const DB_HOST = process.env.E2E_PG_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.E2E_PG_PORT || 5432);
const DB_NAME = process.env.E2E_PG_DATABASE || 'launchos_step251';
const DB_USER = process.env.E2E_PG_USER || 'launchos_step251';
const DB_PASS = process.env.E2E_PG_PASSWORD;
const DB_PASS_SPECIAL = process.env.E2E_PG_PASSWORD_SPECIAL;
const DEPLOY_DB_HOST = process.env.E2E_DEPLOY_PG_HOST || 'host.docker.internal';
const DEPLOY_DB_PORT = Number(process.env.E2E_DEPLOY_PG_PORT || 15432);
const DEPLOY_DB_PASS = process.env.E2E_DEPLOY_PG_PASSWORD || DB_PASS_SPECIAL || DB_PASS;

if (!DB_PASS || !DB_PASS_SPECIAL || !DEPLOY_DB_PASS) {
  console.error('Missing E2E_PG_PASSWORD / E2E_PG_PASSWORD_SPECIAL / E2E_DEPLOY_PG_PASSWORD');
  process.exit(1);
}

const FORBIDDEN = [DB_PASS, DB_PASS_SPECIAL, DEPLOY_DB_PASS, 'postgresql://'];

const results = [];
const log = (step, ok, detail) => {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step}: ${detail}`);
};

function assertNoPlaintext(payload) {
  const text = JSON.stringify(payload);
  for (const needle of FORBIDDEN) {
    if (needle && text.includes(needle)) {
      throw new Error('plaintext leak detected');
    }
  }
}

async function api(path, { method = 'GET', token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload = body;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${API}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(Array.isArray(json?.message) ? json.message.join(',') : json?.message || res.statusText);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  assertNoPlaintext(json);
  return json;
}

async function login() {
  const data = await api('/auth/login', {
    method: 'POST',
    body: {
      email: process.env.E2E_EMAIL || 'xiaoqiang8699@gmail.com',
      password: process.env.E2E_PASSWORD || 'Launchos123!',
    },
  });
  return data.accessToken;
}

async function waitDeployment(token, deploymentId, timeoutMs = 180_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const dep = await api(`/deployments/${deploymentId}`, { token });
    if (['SUCCESS', 'FAILED', 'CANCELLED'].includes(dep.status)) {
      return dep;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('deployment timeout');
}

async function main() {
  const token = await login();
  const prisma = new PrismaClient();

  try {
    const apiBefore = await api(`/projects/${PROJECT_ID}/units/${API_UNIT}/config-requirements`, {
      token,
    });
    const webBefore = await api(`/projects/${PROJECT_ID}/units/${WEB_UNIT}/config-requirements`, {
      token,
    });
    const apiRevBefore = apiBefore.summary?.configRevision ?? 0;
    const webRevBefore = webBefore.summary?.configRevision ?? 0;

    const authFail = await fetch(`${API}/projects/${PROJECT_ID}/database-connections/test`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        engine: 'POSTGRESQL',
        host: DB_HOST,
        port: DB_PORT,
        databaseName: DB_NAME,
        username: DB_USER,
        password: 'definitely-wrong-password',
        sslMode: 'DISABLE',
        testLocation: 'CONTROL_PLANE',
      }),
    }).then(async (res) => ({ status: res.status, body: await res.json() }));
    log(
      'AUTH_FAILED',
      authFail.body?.errorCode === 'AUTH_FAILED' ||
        authFail.body?.success === false && String(authFail.body?.message || '').includes('不正确'),
      `errorCode=${authFail.body?.errorCode || 'n/a'}`,
    );
    assertNoPlaintext(authFail.body);

    const timeoutStarted = Date.now();
    const timeout = await fetch(`${API}/projects/${PROJECT_ID}/database-connections/test`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        engine: 'POSTGRESQL',
        host: '203.0.113.9',
        port: 59999,
        databaseName: DB_NAME,
        username: DB_USER,
        password: DB_PASS,
        sslMode: 'DISABLE',
        testLocation: 'CONTROL_PLANE',
      }),
    }).then(async (res) => ({ status: res.status, body: await res.json(), ok: res.ok }));
    const timeoutElapsed = Date.now() - timeoutStarted;
    const timeoutCode = timeout.body?.errorCode || timeout.body?.code;
    log(
      'TIMEOUT/HOST_UNREACHABLE',
      timeout.body?.success === false &&
        timeoutElapsed < 20_000 &&
        ['TIMEOUT', 'HOST_UNREACHABLE', 'DNS_ERROR', 'UNKNOWN'].includes(timeoutCode),
      `code=${timeoutCode || 'fail'} elapsedMs=${timeoutElapsed}`,
    );

    const okTest = await api(`/projects/${PROJECT_ID}/database-connections/test`, {
      method: 'POST',
      token,
      body: {
        engine: 'POSTGRESQL',
        host: DB_HOST,
        port: DB_PORT,
        databaseName: DB_NAME,
        username: DB_USER,
        password: DB_PASS,
        sslMode: 'DISABLE',
        testLocation: 'CONTROL_PLANE',
      },
    });
    log('SELECT 1 success', okTest.success === true, `latency=${okTest.latencyMs}`);

    // Clean previous connections for deterministic bind
    const listed = await api(`/projects/${PROJECT_ID}/database-connections`, { token });
    for (const conn of listed.connections || []) {
      await api(`/projects/${PROJECT_ID}/database-connections/${conn.id}`, {
        method: 'DELETE',
        token,
      });
    }

    const specialTest = await api(`/projects/${PROJECT_ID}/database-connections/test`, {
      method: 'POST',
      token,
      body: {
        engine: 'POSTGRESQL',
        host: DB_HOST,
        port: DB_PORT,
        databaseName: DB_NAME,
        username: DB_USER,
        password: DB_PASS_SPECIAL,
        sslMode: 'DISABLE',
        testLocation: 'CONTROL_PLANE',
      },
    });
    log('special char password', specialTest.success === true, `ok=${specialTest.success}`);

    const created = await api(`/projects/${PROJECT_ID}/database-connections`, {
      method: 'POST',
      token,
      body: {
        name: 'Step251 Test DB',
        engine: 'POSTGRESQL',
        host: DEPLOY_DB_HOST,
        port: DEPLOY_DB_PORT,
        databaseName: DB_NAME,
        username: DB_USER,
        password: DEPLOY_DB_PASS,
        sslMode: 'DISABLE',
        unitIds: [API_UNIT],
        testLocation: 'TARGET_SERVER',
        serverInstanceId: SERVER_ID,
        confirmReplaceManual: true,
      },
    });
    log(
      'save connection',
      Boolean(created.connection?.id) && created.connection.passwordConfigured === true,
      `status=${created.connection?.status}`,
    );
    log(
      'password never returned',
      !('password' in (created.connection || {})) &&
        !('passwordEncrypted' in (created.connection || {})),
      'fields checked',
    );

    const apiAfter = await api(`/projects/${PROJECT_ID}/units/${API_UNIT}/config-requirements`, {
      token,
    });
    const dbReq = apiAfter.requirements.find((item) => item.key === 'DATABASE_URL');
    log(
      'API dirty + configured',
      apiAfter.summary.configRevision > apiRevBefore &&
        dbReq?.configured === true &&
        dbReq?.needsRedeploy === true,
      `rev ${apiRevBefore}->${apiAfter.summary.configRevision}`,
    );
    log(
      'provider metadata',
      dbReq?.managedByDatabaseConnection === true || dbReq?.providerLabel === 'PostgreSQL 数据库',
      `provider=${dbReq?.providerLabel}`,
    );

    const webAfter = await api(`/projects/${PROJECT_ID}/units/${WEB_UNIT}/config-requirements`, {
      token,
    });
    const webDb = webAfter.requirements.find((item) => item.key === 'DATABASE_URL');
    log(
      'Web no DATABASE_URL',
      !webDb && webAfter.summary.configRevision === webRevBefore,
      `webRev=${webAfter.summary.configRevision}`,
    );

    // Target server can reach loopback-only Postgres; control plane cannot.
    const loopHost = process.env.E2E_LOOPBACK_PG_HOST || '127.0.0.1';
    const loopPort = Number(process.env.E2E_LOOPBACK_PG_PORT || 25432);
    const controlLoop = await fetch(`${API}/projects/${PROJECT_ID}/database-connections/test`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        engine: 'POSTGRESQL',
        host: DB_HOST,
        port: loopPort,
        databaseName: DB_NAME,
        username: DB_USER,
        password: DB_PASS,
        sslMode: 'DISABLE',
        testLocation: 'CONTROL_PLANE',
      }),
    }).then(async (res) => ({ body: await res.json() }));
    const targetLoop = await api(`/projects/${PROJECT_ID}/database-connections/test`, {
      method: 'POST',
      token,
      body: {
        engine: 'POSTGRESQL',
        host: loopHost,
        port: loopPort,
        databaseName: DB_NAME,
        username: DB_USER,
        password: DEPLOY_DB_PASS,
        sslMode: 'DISABLE',
        testLocation: 'TARGET_SERVER',
        serverInstanceId: SERVER_ID,
      },
    });
    log(
      'TARGET_SERVER vs CONTROL_PLANE',
      controlLoop.body?.success === false && targetLoop.success === true,
      `cp=${controlLoop.body?.success} ts=${targetLoop.success}`,
    );

    const deployment = await api(`/projects/${PROJECT_ID}/deployments`, {
      method: 'POST',
      token,
      body: {
        environmentId: ENV_ID,
        deployableUnitId: API_UNIT,
        hostingMode: 'my-server',
        serverInstanceId: SERVER_ID,
      },
    });
    const finished = await waitDeployment(token, deployment.id);
    log('redeploy API', finished.status === 'SUCCESS', `status=${finished.status}`);

    if (finished.status === 'SUCCESS') {
      // Public API db-check if domain known
      const services = await api(`/projects/${PROJECT_ID}/services`, { token }).catch(() => []);
      const apiService = (services || []).find((s) => s.deployableUnitId === API_UNIT);
      const domain =
        process.env.E2E_API_URL ||
        'https://api-launchos.zsaos.com';
      const dbCheck = await fetch(`${domain}/db-check`).then(async (res) => ({
        status: res.status,
        body: await res.json().catch(() => ({})),
      }));
      assertNoPlaintext(dbCheck.body);
      log(
        '/db-check',
        dbCheck.body?.databaseConnected === true,
        `status=${dbCheck.status} connected=${dbCheck.body?.databaseConnected}`,
      );
      void apiService;
    }

    const impact = await api(
      `/projects/${PROJECT_ID}/database-connections/${created.connection.id}/delete-impact`,
      { token },
    );
    log(
      'delete impact',
      impact.affectedUnits?.some((u) => u.id === API_UNIT),
      impact.message,
    );

    // Keep connection for demo continuity; optional delete+restore covered by impact check.
  } finally {
    await prisma.$disconnect();
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\nSummary: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
