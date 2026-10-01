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
const { createInstallationAccessToken } = requireApi('@launchos/github');

function redact(t) {
  return String(t || '')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/x-access-token:[^\s@]+/gi, 'x-access-token:***')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer|AUTHORIZATION: basic)[=:][^\s]+/gi, '$1=***');
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

// Issue token from local machine using same config if available; else from worker
await runner.writeTextFile(
  '/opt/launchos/tmp/step317-git-probe.js',
  `const { createInstallationAccessToken } = require('/app/packages/github/dist/index.js');
const { spawnSync } = require('child_process');
const fs = require('fs');
(async () => {
  const tok = await createInstallationAccessToken(process.env.INSTALL_ID);
  const basic = Buffer.from('x-access-token:' + tok.token).toString('base64');
  const url = 'https://github.com/xiaoqiang8699-lang/launchos-multi-demo.git';
  const dir = '/tmp/launchos-repos-probe-' + Date.now();
  fs.rmSync('/tmp/launchos-repos/cmunhwais0003rl01wqj1qy11', { recursive: true, force: true });
  console.log('CLEANED_OLD_REPO');
  const ls = spawnSync('git', ['-c','http.version=HTTP/1.1','-c','http.extraHeader=AUTHORIZATION: basic '+basic,'ls-remote','--heads',url], { encoding:'utf8', timeout: 60000 });
  console.log('LS_EXIT='+ls.status);
  console.log('LS_OUT='+String(ls.stdout||'').slice(0,200));
  console.log('LS_ERR='+String(ls.stderr||'').slice(0,300));
  const clone = spawnSync('git', ['-c','http.version=HTTP/1.1','-c','http.extraHeader=AUTHORIZATION: basic '+basic,'clone','--depth','1','--branch','main',url,dir], { encoding:'utf8', timeout: 180000 });
  console.log('CLONE_EXIT='+clone.status);
  console.log('CLONE_OUT='+String(clone.stdout||'').slice(0,200));
  console.log('CLONE_ERR='+String(clone.stderr||'').slice(0,500));
  console.log('TIMEOUT_CONST='+(require('fs').readFileSync('/app/packages/git/dist/git.service.js','utf8').match(/DEFAULT_GIT_TIMEOUT_MS\\s*=\\s*(\\d+)/)||[])[1]);
})().catch(e => { console.log('FAIL', e.message); process.exit(1); });
`,
);

const probe = await runner.execute(
  shellCommand(
    `podman cp /opt/launchos/tmp/step317-git-probe.js launchos-alpha-worker:/tmp/step317-git-probe.js && podman exec -e INSTALL_ID='${installId}' launchos-alpha-worker node /tmp/step317-git-probe.js`,
  ),
  { timeoutMs: 300000 },
);
const out = redact((probe.stdout || '') + (probe.stderr || ''));
writeFileSync(join(root, '.tools/alpha-runtime/step317-git-probe.txt'), out);
console.log(out);
await runner.disconnect();
await prisma.$disconnect();
