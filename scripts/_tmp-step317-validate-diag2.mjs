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

await runner.writeTextFile(
  '/opt/launchos/bin/step317-validate-diag2.sh',
  `#!/bin/bash
set -euo pipefail
echo ===CONN===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "
SELECT id, status, \\"installationId\\" FROM \\"GitProviderConnection\\" WHERE id='cmump0lbq0018rl01n2beawv6';
SELECT id, url, branch, \\"isPrivate\\", \\"authStatus\\", coalesce(\\"connectionId\\",'') FROM \\"SourceRepository\\" WHERE \\"projectId\\"='cmunhwais0003rl01wqj1qy11';
"
echo ===LATEST_DEPS===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "
SELECT id, status, coalesce(\\"failureCode\\",''), left(coalesce(\\"errorMessage\\",''),200), \\"createdAt\\"::text
FROM \\"Deployment\\" WHERE \\"projectId\\"='cmunhwais0003rl01wqj1qy11'
ORDER BY \\"createdAt\\" DESC LIMIT 3;
"
DEP=$(podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT id FROM \\"Deployment\\" WHERE \\"projectId\\"='cmunhwais0003rl01wqj1qy11' ORDER BY \\"createdAt\\" DESC LIMIT 1;")
echo DEP=\$DEP
echo ===STEPS===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT \\"stepKey\\", status, left(coalesce(\\"errorMessage\\",''),300) FROM \\"DeploymentStep\\" WHERE \\"deploymentId\\"='\$DEP' ORDER BY \\"createdAt\\";"
echo ===LOGS===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT left(message,400) FROM \\"DeploymentLog\\" WHERE \\"deploymentId\\"='\$DEP' ORDER BY \\"createdAt\\" ASC LIMIT 40;"
echo ===WORKER_PK===
podman exec launchos-alpha-worker /bin/sh -c 'node -e "const k=process.env.GITHUB_APP_PRIVATE_KEY||\\"\\"; console.log(\\"PK_LEN=\\"+k.length); console.log(\\"PK_BEGIN=\\"+(k.slice(0,40).replace(/\\n/g,\"\\\\n\"))); console.log(\\"APP_ID=\\"+(process.env.GITHUB_APP_ID||\\"\")); console.log(\\"GIT=\\"+require(\\"child_process\\").execSync(\\"git --version\\").toString().trim());"'
INSTALL_ID=$(podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT \\"installationId\\" FROM \\"GitProviderConnection\\" WHERE id='cmump0lbq0018rl01n2beawv6';")
REPO_URL=$(podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT url FROM \\"SourceRepository\\" WHERE \\"projectId\\"='cmunhwais0003rl01wqj1qy11' ORDER BY \\"createdAt\\" DESC LIMIT 1;")
echo INSTALL_ID=\$INSTALL_ID
echo REPO_URL=\$REPO_URL
echo ===TOKEN_FROM_WORKER===
podman exec -e INSTALL_ID="\$INSTALL_ID" -e REPO_URL="\$REPO_URL" launchos-alpha-worker /bin/sh -c 'node -e "
const { createInstallationAccessToken, isGitHubAppConfigured, listInstallationRepositories } = require(\\"/app/packages/github/dist/index.js\\");
(async () => {
  console.log(\\"configured=\\"+isGitHubAppConfigured());
  console.log(\\"INSTALL_ID=\\"+process.env.INSTALL_ID);
  console.log(\\"REPO_URL=\\"+process.env.REPO_URL);
  try {
    const tok = await createInstallationAccessToken(process.env.INSTALL_ID);
    console.log(\\"TOKEN_OK len=\\"+tok.token.length+\\" exp=\\"+tok.expiresAt);
    const repos = await listInstallationRepositories(process.env.INSTALL_ID);
    console.log(\\"REPOS=\\"+(repos||[]).map(r=>r.full_name||r.fullName||r.name).join(\\",\\"));
    const { spawnSync } = require(\\"child_process\\");
    const basic = Buffer.from(\\"x-access-token:\\"+tok.token).toString(\\"base64\\");
    const r = spawnSync(\\"git\\", [\\"-c\\",\\"http.version=HTTP/1.1\\",\\"-c\\",\\"http.extraHeader=AUTHORIZATION: basic \\"+basic,\\"ls-remote\\",\\"--symref\\",process.env.REPO_URL,\\"HEAD\\"], { encoding:\\"utf8\\", timeout:60000 });
    console.log(\\"LS_EXIT=\\"+r.status);
    console.log(\\"LS_OUT=\\"+(r.stdout||\\"\\").slice(0,300));
    console.log(\\"LS_ERR=\\"+(r.stderr||\\"\\").slice(0,500));
  } catch (e) {
    console.log(\\"TOKEN_FAIL \\"+(e && e.code ? e.code : \\"\\")+\\" \\"+(e && e.message ? e.message : String(e)));
  }
})();
"'
echo ===WORKER_LOG_TAIL===
podman logs --tail 60 launchos-alpha-worker 2>&1 | sed 's/gh[pousr]_[A-Za-z0-9_]\\{20,\\}/*** /g'
`,
);

const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/bin/step317-validate-diag2.sh && /opt/launchos/bin/step317-validate-diag2.sh'),
  { timeoutMs: 120000 },
);
const out = redact(r.stdout || r.stderr || '');
writeFileSync(join(root, '.tools/alpha-runtime/step317-validate-diag2.txt'), out);
console.log(out.slice(0, 8000));
console.log('exit', r.exitCode);

await runner.disconnect();
await prisma.$disconnect();
