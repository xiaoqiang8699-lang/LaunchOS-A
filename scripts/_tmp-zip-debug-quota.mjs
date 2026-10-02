import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const requireApi = createRequire(resolve('apps/api/package.json'));
const { zipSync } = requireApi('fflate');

const auth = JSON.parse(readFileSync('.tools/alpha-runtime/1002-auth.json', 'utf8'));
function curl(method, path, opts = {}) {
  const args = ['-sS', '-X', method, '-w', '\nSTATUS:%{http_code}\n', '--max-time', '60'];
  if (opts.token) args.push('-H', `Authorization: Bearer ${opts.token}`);
  if (opts.json) args.push('-H', 'content-type: application/json', '--data-binary', opts.json);
  if (opts.form) args.push('-F', opts.form);
  args.push(`http://127.0.0.1:3001/api/v1${path}`);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
  return r.stdout || '';
}

const loginOut = curl('POST', '/auth/login', {
  json: JSON.stringify({ email: auth.email, password: auth.password }),
});
const token = JSON.parse(loginOut.split('\nSTATUS:')[0] || '{}').accessToken;
console.log('projects', curl('GET', '/projects', { token }).slice(0, 500));
console.log('account', curl('GET', '/account/usage', { token }).slice(0, 800));

const enc = new TextEncoder();
const payload = Buffer.alloc(256 * 1024, 97);
const files = {
  'app/index.js': enc.encode("console.log('ok')\n"),
  'package.json': enc.encode(JSON.stringify({ name: `smoke-${randomUUID().slice(0, 6)}` })),
  'blob.bin': payload,
};
const zipped = zipSync(files);
const dir = join(process.env.TEMP || '/tmp', 'los-zip-smoke');
mkdirSync(dir, { recursive: true });
const p = join(dir, 'valid.zip');
writeFileSync(p, zipped);
console.log('upload', curl('POST', '/projects/source/zip', { token, form: `file=@${p};type=application/zip` }).slice(0, 800));
