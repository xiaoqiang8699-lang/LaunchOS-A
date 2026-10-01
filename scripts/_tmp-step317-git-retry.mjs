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
  return String(t || '')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/AUTHORIZATION: basic [A-Za-z0-9+/=]+/gi, 'AUTHORIZATION: basic ***');
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
  '/opt/launchos/tmp/step317-git-probe2.js',
  `const { createInstallationAccessToken, isGitHubAppConfigured } = require('/app/packages/github/dist/index.js');
const { spawnSync } = require('child_process');
(async () => {
  console.log('configured=' + isGitHubAppConfigured());
  console.log('APP_ID=' + (process.env.GITHUB_APP_ID || ''));
  console.log('PK_LEN=' + String(process.env.GITHUB_APP_PRIVATE_KEY || '').length);
  const installId = process.env.INSTALL_ID;
  const tok = await createInstallationAccessToken(installId);
  console.log('TOKEN_OK len=' + tok.token.length);
  const basic = Buffer.from('x-access-token:' + tok.token).toString('base64');
  const url = 'https://github.com/xiaoqiang8699-lang/launchos-multi-demo.git';
  const ls = spawnSync('git', ['-c','http.version=HTTP/1.1','-c','http.extraHeader=AUTHORIZATION: basic '+basic,'ls-remote','--symref',url,'HEAD'], { encoding:'utf8', timeout: 90000 });
  console.log('LS_EXIT=' + ls.status + ' ERR=' + ls.error);
  console.log('LS_OUT=' + String(ls.stdout||'').slice(0,300));
  console.log('LS_ERR=' + String(ls.stderr||'').slice(0,500));
  const cloneDir = '/tmp/git-probe-' + Date.now();
  const cl = spawnSync('git', ['-c','http.version=HTTP/1.1','-c','http.extraHeader=AUTHORIZATION: basic '+basic,'clone','--depth','1','--branch','main',url,cloneDir], { encoding:'utf8', timeout: 180000 });
  console.log('CLONE_EXIT=' + cl.status + ' ERR=' + cl.error);
  console.log('CLONE_ERR=' + String(cl.stderr||'').slice(0,500));
})().catch((e) => { console.log('FAIL ' + (e && e.message ? e.message : e)); process.exit(1); });
`,
);

await runner.writeTextFile(
  '/opt/launchos/bin/step317-git-probe2.sh',
  `#!/bin/bash
set -euo pipefail
INSTALL_ID="$1"
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "UPDATE \\"GitProviderConnection\\" SET status='ACTIVE' WHERE id='cmump0lbq0018rl01n2beawv6'; UPDATE \\"SourceRepository\\" SET \\"authStatus\\"='OK' WHERE \\"connectionId\\"='cmump0lbq0018rl01n2beawv6';"
podman cp /opt/launchos/tmp/step317-git-probe2.js launchos-alpha-worker:/tmp/step317-git-probe2.js
podman exec -e INSTALL_ID="$INSTALL_ID" -e GITHUB_APP_ID="$(sed -n 's/^GITHUB_APP_ID=//p' /opt/launchos/config/alpha-github.env | head -1)" launchos-alpha-worker /bin/sh -c 'export GITHUB_APP_PRIVATE_KEY="$(cat /run/secrets/github-app.pem)"; node /tmp/step317-git-probe2.js'
`,
);

const r = await runner.execute(
  shellCommand(`chmod 700 /opt/launchos/bin/step317-git-probe2.sh && /opt/launchos/bin/step317-git-probe2.sh '${installId}'`),
  { timeoutMs: 300000 },
);
const out = redact((r.stdout || '') + (r.stderr || ''));
writeFileSync(join(root, '.tools/alpha-runtime/step317-git-retry.txt'), out);
console.log(out);
await runner.disconnect();
await prisma.$disconnect();
