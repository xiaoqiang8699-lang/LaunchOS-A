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
    .replace(/x-access-token:[^\s@]+/gi, 'x-access-token:***')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer)[=:][^\s]+/gi, '$1=***')
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
  readyTimeoutMs: 20000,
});

const checks = [
  ['ps', 'podman ps -a --filter name=launchos-alpha-worker --format "{{.Names}} {{.Status}} {{.Image}}"'],
  ['logs', 'podman logs --tail 40 launchos-alpha-worker 2>&1 | head -n 40'],
  ['git', 'podman exec launchos-alpha-worker git --version 2>&1'],
  ['pk', `podman exec launchos-alpha-worker /bin/sh -c 'echo PK_LEN=\${#GITHUB_APP_PRIVATE_KEY}; echo APP_ID=\$GITHUB_APP_ID; echo SLUG=\$GITHUB_APP_SLUG'`],
  [
    'conn',
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, \\"installationId\\" FROM \\"GitProviderConnection\\" WHERE id='cmump0lbq0018rl01n2beawv6'; SELECT id, url, \\"authStatus\\", \\"isPrivate\\" FROM \\"SourceRepository\\" WHERE \\"projectId\\"='cmunhwais0003rl01wqj1qy11';"`,
  ],
  [
    'launchrun',
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, \\"currentStage\\", coalesce(\\"failureCode\\",''), left(coalesce(\\"failureMessage\\",''),120), \\"updatedAt\\"::text FROM \\"LaunchRun\\" WHERE id='cmunhwddb0019rl01fzipihgn';"`,
  ],
  [
    'deps',
    `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, coalesce(\\"failureCode\\",''), \\"createdAt\\"::text, \\"updatedAt\\"::text FROM \\"Deployment\\" WHERE \\"projectId\\"='cmunhwais0003rl01wqj1qy11' ORDER BY \\"createdAt\\" DESC LIMIT 5;"`,
  ],
];

const out = [];
for (const [label, cmd] of checks) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs: 60000 });
  out.push(`===${label}===`);
  out.push(redact((r.stdout || '') + (r.stderr || '')).trim());
  out.push(`exit=${r.exitCode}`);
}

// Token + ls-remote probe inside worker
const installId = (
  await runner.execute(
    shellCommand(
      `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT \\"installationId\\" FROM \\"GitProviderConnection\\" WHERE id='cmump0lbq0018rl01n2beawv6';"`,
    ),
    { timeoutMs: 30000 },
  )
).stdout.trim();
const repoUrl = (
  await runner.execute(
    shellCommand(
      `podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT url FROM \\"SourceRepository\\" WHERE \\"projectId\\"='cmunhwais0003rl01wqj1qy11' ORDER BY \\"createdAt\\" DESC LIMIT 1;"`,
    ),
    { timeoutMs: 30000 },
  )
).stdout.trim();
out.push(`INSTALL_ID=${installId}`);
out.push(`REPO_URL=${repoUrl}`);

await runner.writeTextFile(
  '/opt/launchos/tmp/step317-token-probe.js',
  `const { createInstallationAccessToken, isGitHubAppConfigured, listInstallationRepositories } = require('/app/packages/github/dist/index.js');
const { spawnSync } = require('child_process');
(async () => {
  console.log('configured=' + isGitHubAppConfigured());
  console.log('INSTALL_ID=' + process.env.INSTALL_ID);
  console.log('REPO_URL=' + process.env.REPO_URL);
  try {
    const tok = await createInstallationAccessToken(process.env.INSTALL_ID);
    console.log('TOKEN_OK len=' + tok.token.length + ' exp=' + tok.expiresAt);
    const repos = await listInstallationRepositories(process.env.INSTALL_ID);
    console.log('REPOS=' + (repos || []).map((r) => r.full_name || r.fullName || r.name).join(','));
    const basic = Buffer.from('x-access-token:' + tok.token).toString('base64');
    const r = spawnSync(
      'git',
      [
        '-c', 'http.version=HTTP/1.1',
        '-c', 'http.extraHeader=AUTHORIZATION: basic ' + basic,
        'ls-remote', '--symref', process.env.REPO_URL, 'HEAD',
      ],
      { encoding: 'utf8', timeout: 60000 },
    );
    console.log('LS_EXIT=' + r.status);
    console.log('LS_OUT=' + String(r.stdout || '').slice(0, 400));
    console.log('LS_ERR=' + String(r.stderr || '').slice(0, 600));
  } catch (e) {
    console.log('TOKEN_FAIL ' + (e && e.code ? e.code : '') + ' ' + (e && e.message ? e.message : String(e)));
  }
})();
`,
);

const probe = await runner.execute(
  shellCommand(
    `podman cp /opt/launchos/tmp/step317-token-probe.js launchos-alpha-worker:/tmp/step317-token-probe.js && podman exec -e INSTALL_ID='${installId}' -e REPO_URL='${repoUrl}' launchos-alpha-worker node /tmp/step317-token-probe.js`,
  ),
  { timeoutMs: 90000 },
);
out.push('===token_probe===');
out.push(redact((probe.stdout || '') + (probe.stderr || '')).trim());
out.push(`exit=${probe.exitCode}`);

const text = out.join('\n');
writeFileSync(join(root, '.tools/alpha-runtime/step317-validate-diag3.txt'), text);
console.log(text);

await runner.disconnect();
await prisma.$disconnect();
