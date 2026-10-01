import { createRequire } from 'node:module';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of [resolve(root, '.env')]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');

const TARGET = '116.62.198.184';
const API_HOST = 'api-alpha.zsaos.com';
const WEB_ORIGIN = 'https://alpha.zsaos.com';
const API_ORIGIN = `https://${API_HOST}`;

function curl(url, host, { method = 'GET', headers = {}, body = null } = {}) {
  const args = [
    '-k', '-sS', '-X', method,
    '--resolve', `${host}:443:${TARGET}`,
    '-w', '\n__STATUS__:%{http_code}',
    '--max-time', '180',
  ];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body != null) {
    args.push('-H', 'content-type: application/json');
    args.push('--data-binary', body);
  }
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)\s*$/);
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out };
}

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: TARGET } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});

const probe = await runner.execute(
  shellCommand(
    [
      "echo MIRRORS",
      "for u in 'https://gitclone.com/github.com/octocat/Hello-World.git' 'https://mirror.ghproxy.com/https://github.com/octocat/Hello-World.git' 'https://github.com.cnpmjs.org/octocat/Hello-World.git'; do echo URL=$u; timeout 25 env GIT_TERMINAL_PROMPT=0 git -c http.version=HTTP/1.1 ls-remote --heads \"$u\" 2>&1 | head -5; echo EXIT:$?; done",
      "echo CTR_MIRROR",
      "podman exec launchos-alpha-api sh -c 'timeout 25 env GIT_TERMINAL_PROMPT=0 git -c http.version=HTTP/1.1 ls-remote --heads https://gitclone.com/github.com/octocat/Hello-World.git 2>&1 | head -8; echo EXIT:$?'",
    ].join('; '),
  ),
  { timeoutMs: 120000 },
);
console.log(String(probe.stdout || '').slice(0, 4000));
await runner.disconnect();
await prisma.$disconnect();

// If gitclone works, run public analyze with that URL
const email = `alpha-git311c-${Date.now()}@zsaos.test`;
const password = `Alpha${randomBytes(5).toString('hex')}!aA1`;
curl(`${API_ORIGIN}/api/v1/auth/register`, API_HOST, {
  method: 'POST',
  headers: { origin: WEB_ORIGIN },
  body: JSON.stringify({ email, password, name: 'Git311c' }),
});
const login = curl(`${API_ORIGIN}/api/v1/auth/login`, API_HOST, {
  method: 'POST',
  headers: { origin: WEB_ORIGIN },
  body: JSON.stringify({ email, password }),
});
const token = JSON.parse(login.text).accessToken;
const auth = { authorization: `Bearer ${token}`, origin: WEB_ORIGIN };
const cloneUrl = 'https://gitclone.com/github.com/octocat/Hello-World.git';
const pub = curl(`${API_ORIGIN}/api/v1/onboarding/source/public`, API_HOST, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ cloneUrl, branch: 'master' }),
});
console.log('public', pub.status, pub.text.slice(0, 400));
const analyze = curl(`${API_ORIGIN}/api/v1/onboarding/analyze`, API_HOST, {
  method: 'POST',
  headers: auth,
});
console.log('analyze', analyze.status, analyze.text.slice(0, 800));

const reportPath = resolve(root, '.tools/step311-git-runtime-fix-report.json');
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
report.publicRepoAnalyze = {
  connectStatus: pub.status,
  analyzeStatus: analyze.status,
  gitMissingError: /本机未安装\s*Git|git not found|ENOENT.*git/i.test(analyze.text + pub.text),
  cloneUrlUsed: cloneUrl,
  githubComDirect: 'TCP hang from host; api.github.com OK',
  analyzeSnippet: analyze.text.slice(0, 500),
  connectSnippet: pub.text.slice(0, 300),
  ok:
    pub.status >= 200 &&
    pub.status < 300 &&
    analyze.status >= 200 &&
    analyze.status < 300 &&
    !/本机未安装\s*Git|git not found|ENOENT.*git/i.test(analyze.text),
};
const routesOk = Object.values(report.existingRoutesRegression || {}).every((r) => r.ok);
report.final =
  report.candidateHealth?.healthy &&
  report.publicApiHealth?.ok &&
  report.publicRepoAnalyze?.ok &&
  report.zipRegression?.ok &&
  routesOk
    ? 'PASS'
    : 'FAIL';
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log('updated final', report.final);
