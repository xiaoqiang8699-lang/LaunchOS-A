import { readFileSync as read, writeFileSync as write } from 'node:fs';
import { spawnSync as spawn } from 'node:child_process';

const TARGET = '116.62.198.184';
const auth = JSON.parse(read('.tools/alpha-runtime/admin-auth.json', 'utf8'));
let userPass = null;
try {
  userPass = JSON.parse(read('.tools/alpha-runtime/ux3-auth.json', 'utf8')).password;
} catch {}

function curl(url, host, opts = {}) {
  const args = ['-sS', '-L', '-X', opts.method || 'GET', '-w', '\n__STATUS__:%{http_code}', '--max-time', '60', '--resolve', `${host}:443:${TARGET}`];
  for (const [k, v] of Object.entries(opts.headers || {})) args.push('-H', `${k}: ${v}`);
  if (opts.body != null) {
    args.push('-H', 'content-type: application/json', '--data-binary', opts.body);
  }
  args.push(url);
  const r = spawn('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)\s*$/);
  const text = m ? out.slice(0, m.index) : out;
  return { status: m ? Number(m[1]) : 0, text };
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const adminLogin = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: auth.email, password: auth.password }),
});
const adminToken = parse(adminLogin.text)?.accessToken;
if (!adminToken) throw new Error('admin login failed: ' + adminLogin.text.slice(0, 200));

const adminOverview = curl('https://api-alpha.zsaos.com/api/v1/admin/overview', 'api-alpha.zsaos.com', {
  headers: { authorization: `Bearer ${adminToken}` },
});

let userAdmin = null;
let userLoginStatus = null;
if (userPass) {
  const userLogin = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
    method: 'POST',
    body: JSON.stringify({ email: '1002@qq.com', password: userPass }),
  });
  userLoginStatus = userLogin.status;
  const userToken = parse(userLogin.text)?.accessToken;
  if (userToken) {
    userAdmin = curl('https://api-alpha.zsaos.com/api/v1/admin/overview', 'api-alpha.zsaos.com', {
      headers: { authorization: `Bearer ${userToken}` },
    });
  }
}

const deps = curl(
  `https://api-alpha.zsaos.com/api/v1/admin/deployments?page=1&pageSize=5&q=${encodeURIComponent('web-ceshi')}`,
  'api-alpha.zsaos.com',
  { headers: { authorization: `Bearer ${adminToken}` } },
);
const depBody = parse(deps.text);
const apps = curl(
  `https://api-alpha.zsaos.com/api/v1/admin/apps?page=1&pageSize=5&q=${encodeURIComponent('web-ceshi')}`,
  'api-alpha.zsaos.com',
  { headers: { authorization: `Bearer ${adminToken}` } },
);
const appBody = parse(apps.text);
const appId = appBody?.items?.[0]?.id;
const appDetail = appId
  ? curl(`https://api-alpha.zsaos.com/api/v1/admin/apps/${appId}`, 'api-alpha.zsaos.com', {
      headers: { authorization: `Bearer ${adminToken}` },
    })
  : null;
const workspaces = curl(
  `https://api-alpha.zsaos.com/api/v1/admin/workspaces?page=1&pageSize=5&q=${encodeURIComponent('测试2号')}`,
  'api-alpha.zsaos.com',
  { headers: { authorization: `Bearer ${adminToken}` } },
);
const wsBody = parse(workspaces.text);

const report = {
  adminOverview: adminOverview.status,
  userLoginStatus,
  userAdminOverview: userAdmin?.status ?? null,
  userAdminSnippet: userAdmin ? (userAdmin.text || '').slice(0, 180) : null,
  deploymentsWebCeshi: {
    status: deps.status,
    total: depBody?.total ?? null,
    first: depBody?.items?.[0]
      ? { id: depBody.items[0].id, status: depBody.items[0].status, app: depBody.items[0].appName }
      : null,
  },
  appDetailStatus: appDetail?.status ?? null,
  workspaceSearch: { status: workspaces.status, total: wsBody?.total ?? null, first: wsBody?.items?.[0]?.name ?? null },
};
write('.tools/alpha-runtime/ops1-user-regression.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
