import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const auth = JSON.parse(readFileSync(resolve(root, '.tools/alpha-runtime/ux1-auth.json'), 'utf8'));
const HOST = '116.62.198.184';
function curl(url, host, opts = {}) {
  const { method = 'GET', headers = {}, body = null } = opts;
  const args = ['-sS', '-L', '-X', method, '-w', '\n__STATUS__:%{http_code}', '--max-time', '60', '--resolve', `${host}:443:${HOST}`];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body != null) args.push('-H', 'content-type: application/json', '--data-binary', body);
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)/);
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out };
}
const login = curl('https://api-alpha.zsaos.com/api/v1/auth/login', 'api-alpha.zsaos.com', {
  method: 'POST',
  body: JSON.stringify({ email: auth.email, password: auth.password }),
});
const token = JSON.parse(login.text || '{}').accessToken;
const pid = 'cmunsm2lk00ctrl01nnu1pwyd';
const paths = [
  `/projects/${pid}/database-summary`,
  `/projects/${pid}/database`,
  `/apps/${pid}/database`,
  `/projects/${pid}/dependencies`,
  `/projects/${pid}/runtime-config`,
  `/projects/${pid}/config`,
  `/projects/${pid}/runtime-config/summary`,
];
const out = {};
for (const p of paths) {
  const r = curl(`https://api-alpha.zsaos.com/api/v1${p}`, 'api-alpha.zsaos.com', {
    headers: { Authorization: `Bearer ${token}` },
  });
  out[p] = { status: r.status, text: r.text.slice(0, 500) };
}
writeFileSync(resolve(root, '.tools/alpha-runtime/ux1-db-probe.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
