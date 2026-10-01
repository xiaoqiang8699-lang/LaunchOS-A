/**
 * Step 25.2 — Redis connection E2E (secrets from env only).
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

const REDIS_HOST = process.env.E2E_REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number(process.env.E2E_REDIS_PORT || 16379);
const REDIS_PASS = process.env.E2E_REDIS_PASSWORD;
const REDIS_PASS_SPECIAL = process.env.E2E_REDIS_PASSWORD_SPECIAL || REDIS_PASS;
const DEPLOY_HOST = process.env.E2E_DEPLOY_REDIS_HOST || 'host.docker.internal';
const DEPLOY_PORT = Number(process.env.E2E_DEPLOY_REDIS_PORT || 16379);
const DEPLOY_PASS = process.env.E2E_DEPLOY_REDIS_PASSWORD || REDIS_PASS;
const LOOP_HOST = process.env.E2E_LOOPBACK_REDIS_HOST || '127.0.0.1';
const LOOP_PORT = Number(process.env.E2E_LOOPBACK_REDIS_PORT || 26379);
const NOAUTH_HOST = process.env.E2E_NOAUTH_REDIS_HOST || '127.0.0.1';
const NOAUTH_PORT = Number(process.env.E2E_NOAUTH_REDIS_PORT || 16380);

if (!REDIS_PASS || !DEPLOY_PASS) {
  console.error('Missing Redis E2E passwords');
  process.exit(1);
}

const FORBIDDEN = [REDIS_PASS, REDIS_PASS_SPECIAL, DEPLOY_PASS, 'redis://', 'rediss://'];
const results = [];
const log = (step, ok, detail) => {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step}: ${detail}`);
};

function assertNoPlaintext(payload) {
  const text = JSON.stringify(payload);
  for (const needle of FORBIDDEN) {
    if (needle && text.includes(needle)) throw new Error('plaintext leak detected');
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
    const err = new Error(
      Array.isArray(json?.message) ? json.message.join(',') : json?.message || res.statusText,
    );
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

async function waitDeployment(token, deploymentId, timeoutMs = 240_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const dep = await api(`/deployments/${deploymentId}`, { token });
    if (['SUCCESS', 'FAILED', 'CANCELLED'].includes(dep.status)) return dep;
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error('deployment timeout');
}

async function main() {
  const token = await login();
  const prisma = new PrismaClient();

  try {
    // Ensure REDIS_URL requirement exists via rescan
    await api(`/projects/${PROJECT_ID}/units/${API_UNIT}/config/rescan`, {
      method: 'POST',
      token,
    });

    const apiBefore = await api(`/projects/${PROJECT_ID}/units/${API_UNIT}/config-requirements`, {
      token,
    });
    const webBefore = await api(`/projects/${PROJECT_ID}/units/${WEB_UNIT}/config-requirements`, {
      token,
    });
    const apiRevBefore = apiBefore.summary?.configRevision ?? 0;
    const webRevBefore = webBefore.summary?.configRevision ?? 0;
    const redisReq = apiBefore.requirements.find((r) => r.key === 'REDIS_URL');
    log('API has REDIS_URL requirement', Boolean(redisReq?.sensitive), `required=${redisReq?.required}`);
    log(
      'Web no REDIS_URL requirement',
      !webBefore.requirements.find((r) => r.key === 'REDIS_URL'),
      'ok',
    );

    const authFail = await fetch(`${API}/projects/${PROJECT_ID}/redis-connections/test`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        host: REDIS_HOST,
        port: REDIS_PORT,
        password: 'definitely-wrong-password',
        tlsMode: 'DISABLE',
        testLocation: 'CONTROL_PLANE',
      }),
    }).then(async (res) => ({ body: await res.json() }));
    log(
      'AUTH_FAILED',
      authFail.body?.errorCode === 'AUTH_FAILED' ||
        (authFail.body?.success === false &&
          String(authFail.body?.message || '').includes('不正确')),
      `errorCode=${authFail.body?.errorCode || 'n/a'}`,
    );
    assertNoPlaintext(authFail.body);

    const timeoutStarted = Date.now();
    const timeout = await fetch(`${API}/projects/${PROJECT_ID}/redis-connections/test`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        host: '203.0.113.9',
        port: 59998,
        password: REDIS_PASS,
        tlsMode: 'DISABLE',
        testLocation: 'CONTROL_PLANE',
      }),
    }).then(async (res) => ({ body: await res.json() }));
    log(
      'TIMEOUT/HOST_UNREACHABLE',
      timeout.body?.success === false && Date.now() - timeoutStarted < 20_000,
      `code=${timeout.body?.errorCode} elapsed=${Date.now() - timeoutStarted}`,
    );

    const okTest = await api(`/projects/${PROJECT_ID}/redis-connections/test`, {
      method: 'POST',
      token,
      body: {
        host: REDIS_HOST,
        port: REDIS_PORT,
        password: REDIS_PASS,
        databaseIndex: 0,
        tlsMode: 'DISABLE',
        testLocation: 'CONTROL_PLANE',
      },
    });
    log('PING success', okTest.success === true, `latency=${okTest.latencyMs}`);

    const special = await api(`/projects/${PROJECT_ID}/redis-connections/test`, {
      method: 'POST',
      token,
      body: {
        host: REDIS_HOST,
        port: REDIS_PORT,
        password: REDIS_PASS_SPECIAL,
        tlsMode: 'DISABLE',
        testLocation: 'CONTROL_PLANE',
      },
    });
    log('special char password', special.success === true, `ok=${special.success}`);

    const noauth = await api(`/projects/${PROJECT_ID}/redis-connections/test`, {
      method: 'POST',
      token,
      body: {
        host: NOAUTH_HOST,
        port: NOAUTH_PORT,
        tlsMode: 'DISABLE',
        testLocation: 'CONTROL_PLANE',
      },
    });
    log('no-auth success', noauth.success === true, `ok=${noauth.success}`);

    const listed = await api(`/projects/${PROJECT_ID}/redis-connections`, { token });
    for (const conn of listed.connections || []) {
      await api(`/projects/${PROJECT_ID}/redis-connections/${conn.id}`, {
        method: 'DELETE',
        token,
      });
    }

    const controlLoop = await fetch(`${API}/projects/${PROJECT_ID}/redis-connections/test`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        host: process.env.E2E_REMOTE_PUBLIC_HOST || '8.138.113.134',
        port: LOOP_PORT,
        password: DEPLOY_PASS,
        tlsMode: 'DISABLE',
        testLocation: 'CONTROL_PLANE',
      }),
    }).then(async (res) => ({ body: await res.json() }));

    const targetLoop = await api(`/projects/${PROJECT_ID}/redis-connections/test`, {
      method: 'POST',
      token,
      body: {
        host: LOOP_HOST,
        port: LOOP_PORT,
        password: DEPLOY_PASS,
        tlsMode: 'DISABLE',
        testLocation: 'TARGET_SERVER',
        serverInstanceId: SERVER_ID,
      },
    });
    log(
      'TARGET_SERVER vs CONTROL_PLANE',
      controlLoop.body?.success === false && targetLoop.success === true,
      `cp=${controlLoop.body?.success} ts=${targetLoop.success}`,
    );

    const created = await api(`/projects/${PROJECT_ID}/redis-connections`, {
      method: 'POST',
      token,
      body: {
        name: 'Step252 Test Redis',
        host: DEPLOY_HOST,
        port: DEPLOY_PORT,
        password: DEPLOY_PASS,
        databaseIndex: 0,
        tlsMode: 'DISABLE',
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
      'ok',
    );

    const apiAfter = await api(`/projects/${PROJECT_ID}/units/${API_UNIT}/config-requirements`, {
      token,
    });
    const redisAfter = apiAfter.requirements.find((r) => r.key === 'REDIS_URL');
    log(
      'API dirty + configured',
      apiAfter.summary.configRevision > apiRevBefore &&
        redisAfter?.configured === true &&
        redisAfter?.needsRedeploy === true,
      `rev ${apiRevBefore}->${apiAfter.summary.configRevision}`,
    );
    log(
      'provider metadata',
      redisAfter?.managedByRedisConnection === true || redisAfter?.providerLabel === 'Redis 服务',
      `provider=${redisAfter?.providerLabel}`,
    );

    const webAfter = await api(`/projects/${PROJECT_ID}/units/${WEB_UNIT}/config-requirements`, {
      token,
    });
    log(
      'Web unaffected',
      webAfter.summary.configRevision === webRevBefore &&
        !webAfter.requirements.find((r) => r.key === 'REDIS_URL'),
      `webRev=${webAfter.summary.configRevision}`,
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
      await new Promise((r) => setTimeout(r, 3000));
      const domain = process.env.E2E_API_URL || 'https://api-launchos.zsaos.com';
      const redisCheck = await fetch(`${domain}/redis-check`).then(async (res) => ({
        status: res.status,
        body: await res.json().catch(() => ({})),
      }));
      assertNoPlaintext(redisCheck.body);
      log(
        '/redis-check',
        redisCheck.body?.redisConnected === true,
        `status=${redisCheck.status} connected=${redisCheck.body?.redisConnected}`,
      );
    }

    const impact = await api(
      `/projects/${PROJECT_ID}/redis-connections/${created.connection.id}/delete-impact`,
      { token },
    );
    log(
      'delete impact',
      impact.affectedUnits?.some((u) => u.id === API_UNIT),
      impact.message,
    );
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
