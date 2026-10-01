import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of [resolve(root, '.env'), resolve(root, '.secrets/alpha-data-plane.env')]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
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

function redact(t) {
  return String(t || '').replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***');
}

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: '116.62.198.184' } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});

const installId = (
  await runner.execute(
    shellCommand(
      `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT \\"installationId\\" FROM \\"GitProviderConnection\\" WHERE id='cmump0lbq0018rl01n2beawv6';"`,
    ),
    { timeoutMs: 30000 },
  )
).stdout.trim();

await runner.writeTextFile(
  '/opt/launchos/tmp/step317-tarball-probe.js',
  `const { createInstallationAccessToken } = require('/app/packages/github/dist/index.js');
const { spawnSync } = require('child_process');
const fs = require('fs');
(async () => {
  const tok = await createInstallationAccessToken(process.env.INSTALL_ID);
  const out = '/tmp/gh-tarball-' + Date.now() + '.tar.gz';
  const dir = '/tmp/gh-extract-' + Date.now();
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync('curl', ['-fsSL','--max-time','120','-H','Accept: application/vnd.github+json','-H','Authorization: Bearer '+tok.token,'-H','User-Agent: LaunchOS','-H','X-GitHub-Api-Version: 2022-11-28','-o',out,'https://api.github.com/repos/xiaoqiang8699-lang/launchos-multi-demo/tarball/main'], { encoding:'utf8' });
  console.log('CURL_EXIT='+r.status);
  console.log('CURL_ERR='+String(r.stderr||'').slice(0,300));
  console.log('SIZE='+(fs.existsSync(out)?fs.statSync(out).size:0));
  if (r.status === 0) {
    const t = spawnSync('tar', ['-xzf', out, '-C', dir, '--strip-components=1'], { encoding:'utf8' });
    console.log('TAR_EXIT='+t.status);
    console.log('FILES='+fs.readdirSync(dir).slice(0,20).join(','));
  }
})().catch(e => { console.log('FAIL '+e.message); process.exit(1); });
`,
);

const r = await runner.execute(
  shellCommand(
    `podman cp /opt/launchos/tmp/step317-tarball-probe.js launchos-alpha-worker:/tmp/step317-tarball-probe.js && podman exec -e INSTALL_ID='${installId}' -e GITHUB_APP_ID="$(sed -n 's/^GITHUB_APP_ID=//p' /opt/launchos/config/alpha-github.env | head -1)" launchos-alpha-worker /bin/sh -c 'export GITHUB_APP_PRIVATE_KEY="$(cat /run/secrets/github-app.pem)"; node /tmp/step317-tarball-probe.js'`,
  ),
  { timeoutMs: 180000 },
);
console.log(redact((r.stdout || '') + (r.stderr || '')));
writeFileSync(join(root, '.tools/alpha-runtime/step317-tarball-probe.txt'), redact((r.stdout || '') + (r.stderr || '')));
await runner.disconnect();
await prisma.$disconnect();
