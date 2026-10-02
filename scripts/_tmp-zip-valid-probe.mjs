import { createRequire } from 'node:module';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const requireApi = createRequire(resolve('apps/api/package.json'));
const { zipSync } = requireApi('fflate');

const auth = JSON.parse(readFileSync('.tools/alpha-runtime/1002-auth.json', 'utf8'));
const login = spawnSync(
  'curl.exe',
  [
    '-sS',
    '-X',
    'POST',
    'http://127.0.0.1:3001/api/v1/auth/login',
    '-H',
    'content-type: application/json',
    '--data-binary',
    JSON.stringify({ email: auth.email, password: auth.password }),
  ],
  { encoding: 'utf8' },
);
const token = JSON.parse(login.stdout || '{}').accessToken;
if (!token) {
  console.error('LOGIN', login.stdout);
  process.exit(1);
}

const enc = new TextEncoder();
const zipped = zipSync({
  'app/index.js': enc.encode("console.log('ok')\n"),
  'package.json': enc.encode(JSON.stringify({ name: 'smoke-app' })),
});
const dir = join(process.env.TEMP || '/tmp', 'los-zip-smoke');
mkdirSync(dir, { recursive: true });
const p = join(dir, 'valid-tiny.zip');
writeFileSync(p, zipped);

const up = spawnSync(
  'curl.exe',
  [
    '-sS',
    '-X',
    'POST',
    'http://127.0.0.1:3001/api/v1/projects/source/zip',
    '-H',
    `Authorization: Bearer ${token}`,
    '-F',
    `file=@${p};type=application/zip`,
    '-w',
    '\nSTATUS:%{http_code}\n',
  ],
  { encoding: 'utf8', maxBuffer: 8_000_000 },
);
console.log(up.stdout);
console.log('EXIT', up.status);
