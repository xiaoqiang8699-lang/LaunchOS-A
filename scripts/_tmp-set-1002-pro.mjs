import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const user = JSON.parse(readFileSync('.tools/alpha-runtime/1002-auth.json', 'utf8'));

function curl(method, url, opts = {}) {
  const args = [
    '-sS',
    '-L',
    '-X',
    method,
    '-w',
    '\n__STATUS__:%{http_code}',
    '--max-time',
    '60',
    '--resolve',
    'api-alpha.zsaos.com:443:116.62.198.184',
  ];
  if (opts.token) args.push('-H', `Authorization: Bearer ${opts.token}`);
  if (opts.body) args.push('-H', 'content-type: application/json', '--data-binary', opts.body);
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)/);
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out };
}

const login = curl('POST', 'https://api-alpha.zsaos.com/api/v1/auth/login', {
  body: JSON.stringify({ email: user.email, password: user.password }),
});
const token = JSON.parse(login.text || '{}').accessToken;
if (!token) {
  console.error('LOGIN_FAIL', login);
  process.exit(1);
}

const before = curl('GET', 'https://api-alpha.zsaos.com/api/v1/billing/subscription', { token });
console.log('BEFORE', before.status, before.text.slice(0, 500));

const change = curl('POST', 'https://api-alpha.zsaos.com/api/v1/billing/subscription/change-plan', {
  token,
  body: JSON.stringify({ plan: 'pro' }),
});
console.log('CHANGE', change.status, change.text.slice(0, 800));

const after = curl('GET', 'https://api-alpha.zsaos.com/api/v1/billing/subscription', { token });
console.log('AFTER', after.status, after.text.slice(0, 500));

const usage = curl('GET', 'https://api-alpha.zsaos.com/api/v1/account/usage', { token });
console.log('USAGE', usage.status, usage.text.slice(0, 500));

const parsed = JSON.parse(after.text || '{}');
const plan = parsed.plan?.code || parsed.planCode || parsed.plan || '';
if (change.status >= 200 && change.status < 300 && String(plan).toLowerCase() === 'pro') {
  console.log('PLAN_SET=pro');
} else {
  console.error('PLAN_SET_FAILED');
  process.exit(1);
}
