/**
 * Install git inside running Alpha API/Worker containers on managed host, then smoke analyze.
 */
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: TARGET } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});

await runner.writeTextFile(
  '/opt/launchos/bin/step31-install-git.sh',
  `#!/bin/sh
set -e
for c in launchos-alpha-api launchos-alpha-worker; do
  echo "INSTALL_GIT $c"
  podman exec -u 0 "$c" sh -c 'command -v git >/dev/null && git --version && exit 0; apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git && git --version'
done
`,
);
const install = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/bin/step31-install-git.sh && /opt/launchos/bin/step31-install-git.sh'),
  { timeoutMs: 300000 },
);
console.log('install_exit', install.exitCode);
console.log(String(install.stdout || '').slice(0, 2000));
console.log(String(install.stderr || '').slice(0, 1000));

await runner.disconnect();
await prisma.$disconnect();

// analyze smoke
function curl(url, host, { method = 'GET', headers = {}, body = null } = {}) {
  const args = ['-k', '-sS', '-X', method, '--resolve', `${host}:443:${TARGET}`, '-w', '\n__STATUS__:%{http_code}'];
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

const API = 'api-alpha.zsaos.com';
const WEB = 'https://alpha.zsaos.com';
const email = `alpha-git-${Date.now()}@zsaos.test`;
const password = `Alpha${randomBytes(5).toString('hex')}!aA1`;
curl(`https://${API}/api/v1/auth/register`, API, {
  method: 'POST',
  headers: { origin: WEB },
  body: JSON.stringify({ email, password, name: 'GitSmoke' }),
});
const login = curl(`https://${API}/api/v1/auth/login`, API, {
  method: 'POST',
  headers: { origin: WEB },
  body: JSON.stringify({ email, password }),
});
const token = JSON.parse(login.text).accessToken;
const auth = { authorization: `Bearer ${token}`, origin: WEB };
const pub = curl(`https://${API}/api/v1/onboarding/source/public`, API, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({ cloneUrl: 'https://github.com/octocat/Hello-World.git', branch: 'master' }),
});
console.log('public', pub.status, pub.text.slice(0, 300));
const analyze = curl(`https://${API}/api/v1/onboarding/analyze`, API, {
  method: 'POST',
  headers: auth,
});
console.log('analyze', analyze.status, analyze.text.slice(0, 800));
