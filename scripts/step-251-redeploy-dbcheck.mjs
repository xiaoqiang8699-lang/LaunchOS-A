/**
 * Redeploy API unit only and poll /db-check.
 * Expects DB connection already saved and env loaded.
 */
import { createRequire } from 'node:module';

const API = process.env.API_BASE || 'http://localhost:3001/api/v1';
const PROJECT_ID = process.env.E2E_PROJECT_ID || 'cmu3j24mv0001ri7wcsoa30hj';
const API_UNIT = process.env.E2E_API_UNIT || 'cmu3j272x0005ri7wlxlbajeu';
const SERVER_ID = process.env.E2E_SERVER_ID || 'cmu22cqo80007ri6wkt4krfsq';
const ENV_ID = process.env.E2E_ENV_ID || 'cmu3j5ppc000hri7wvxrjopit';
const PUBLIC_API = process.env.E2E_API_URL || 'https://api-launchos.zsaos.com';

async function api(path, { method = 'GET', token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload = body;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${API}${path}`, { method, headers, body: payload });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || res.statusText);
  return json;
}

async function main() {
  const login = await api('/auth/login', {
    method: 'POST',
    body: {
      email: process.env.E2E_EMAIL || 'xiaoqiang8699@gmail.com',
      password: process.env.E2E_PASSWORD || 'Launchos123!',
    },
  });
  const token = login.accessToken;
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
  const started = Date.now();
  let finished;
  while (Date.now() - started < 240_000) {
    finished = await api(`/deployments/${deployment.id}`, { token });
    if (['SUCCESS', 'FAILED', 'CANCELLED'].includes(finished.status)) break;
    await new Promise((r) => setTimeout(r, 4000));
  }
  console.log(`redeploy=${finished?.status}`);
  if (finished?.status !== 'SUCCESS') {
    process.exitCode = 1;
    return;
  }
  await new Promise((r) => setTimeout(r, 3000));
  const dbCheck = await fetch(`${PUBLIC_API}/db-check`).then(async (res) => ({
    status: res.status,
    body: await res.json().catch(() => ({})),
  }));
  const text = JSON.stringify(dbCheck.body);
  if (text.includes('postgresql://') || /password/i.test(text) && text.includes(':')) {
    console.log('db-check=LEAK');
    process.exitCode = 1;
    return;
  }
  console.log(`db-check=${dbCheck.body.databaseConnected === true ? 'PASS' : 'FAIL'} status=${dbCheck.status}`);
  if (dbCheck.body.databaseConnected !== true) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
