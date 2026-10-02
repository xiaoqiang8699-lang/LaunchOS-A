/**
 * Local ZIP Source Upload smoke (multipart sizes).
 * node scripts/_tmp-zip-p0-local-smoke.mjs
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ZIP_SOURCE_MAX_BYTES, sanitizeZipEntryPath } from '../packages/shared/dist/zip-intake.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { zipSync } = requireApi('fflate');
const { PrismaClient } = requireApi('@launchos/database');
const API = process.env.API_BASE || 'http://127.0.0.1:3001';
const ARTIFACT = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT, { recursive: true });
const TMP = join(process.env.TEMP || '/tmp', 'launchos-zip-p0-smoke');
mkdirSync(TMP, { recursive: true });

function loadAuth() {
  const p = join(ARTIFACT, '1002-auth.json');
  if (!existsSync(p)) throw new Error('missing 1002-auth.json');
  return JSON.parse(readFileSync(p, 'utf8'));
}

function curlJson(method, path, opts = {}) {
  const args = ['-sS', '-X', method, '-w', '\n__STATUS__:%{http_code}', '--max-time', String(opts.maxTime || 180)];
  if (opts.token) args.push('-H', `Authorization: Bearer ${opts.token}`);
  if (opts.json) {
    args.push('-H', 'content-type: application/json', '--data-binary', opts.json);
  }
  if (opts.formFile) {
    args.push('-F', `file=@${opts.formFile};type=application/zip`);
  }
  args.push(`${API}/api/v1${path}`);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 16_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)/);
  const text = m ? out.slice(0, m.index) : out;
  let body = null;
  try {
    body = JSON.parse(text || '{}');
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  return { status: m ? Number(m[1]) : 0, body, text };
}

function makeZip(path, approxBytes) {
  const enc = new TextEncoder();
  const overhead = 8192;
  const pad = Math.max(64, approxBytes - overhead);
  // Random bytes resist DEFLATE so archive size stays near target.
  const random = new Uint8Array(pad);
  for (let i = 0; i < pad; i += 1) random[i] = (i * 17 + 31) % 251;
  const files = {
    'package.json': enc.encode(JSON.stringify({ name: `zip-smoke-${randomUUID().slice(0, 8)}` })),
    'app/index.js': enc.encode("console.log('launchos-zip-smoke')\n"),
    'data/pad.bin': random,
  };
  const buf = zipSync(files, { level: 0 });
  writeFileSync(path, buf);
  return statSync(path).size;
}

const auth = loadAuth();
const prisma = new PrismaClient();
const user = await prisma.user.findFirst({ where: { email: auth.email || '1002@qq.com' } });
if (!user) throw new Error('smoke user missing');
const membership = await prisma.workspaceMember.findFirst({
  where: { userId: user.id },
  include: { workspace: true },
});
if (!membership) throw new Error('workspace missing');
await prisma.project.deleteMany({ where: { workspaceId: membership.workspaceId } });
console.log('CLEARED_PROJECTS workspace', membership.workspaceId);

const login = curlJson('POST', '/auth/login', {
  json: JSON.stringify({ email: auth.email || '1002@qq.com', password: auth.password }),
});
const token = login.body?.accessToken;
if (!token) {
  console.error('LOGIN_FAIL', login.status, login.text.slice(0, 300));
  process.exit(1);
}

const results = [];
const cases = [
  { label: '1MB', bytes: 1 * 1024 * 1024, expect: 'PASS' },
  { label: '20MB', bytes: 20 * 1024 * 1024, expect: 'PASS' },
  { label: '50MB', bytes: 50 * 1024 * 1024, expect: 'PASS' },
  { label: '100MB', bytes: 100 * 1024 * 1024, expect: 'PASS' },
  { label: '~195MB', bytes: 195 * 1024 * 1024, expect: 'PASS' },
  { label: '>200MB', bytes: ZIP_SOURCE_MAX_BYTES + 1024 * 1024, expect: 'REJECT_413' },
];

for (const c of cases) {
  if (c.expect === 'PASS') {
    await prisma.project.deleteMany({ where: { workspaceId: membership.workspaceId } });
  }
  const file = join(TMP, `${c.label.replace(/[~.>]/g, '')}-${randomUUID().slice(0, 8)}.zip`);
  const size = makeZip(file, c.bytes);
  console.log('UPLOAD', c.label, 'size=', size);
  const res = curlJson('POST', '/projects/source/zip', {
    token,
    formFile: file,
    maxTime: 600,
  });
  const ok =
    c.expect === 'PASS'
      ? res.status >= 200 && res.status < 300 && Boolean(res.body?.id)
      : res.status === 413 && res.body?.code === 'SOURCE_ARCHIVE_TOO_LARGE';
  results.push({
    label: c.label,
    size,
    status: res.status,
    code: res.body?.code,
    projectId: res.body?.id || null,
    ok: Boolean(ok),
    message: typeof res.body?.message === 'string' ? res.body.message.slice(0, 120) : undefined,
  });
  console.log('RESULT', results[results.length - 1]);
  try {
    unlinkSync(file);
  } catch {}
}

const slipOk = sanitizeZipEntryPath('../etc/passwd') === null;
const ignoreOk = sanitizeZipEntryPath('node_modules/x/index.js') === null;

const report = {
  ZIP_SOURCE_MAX_BYTES,
  slipOk,
  ignoreOk,
  results,
  allOk: results.every((r) => r.ok) && slipOk && ignoreOk,
};
writeFileSync(join(ARTIFACT, 'zip-p0-local-smoke.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await prisma.$disconnect();
if (!report.allOk) process.exit(1);
console.log('ZIP_LOCAL_SMOKE_PASS=true');
