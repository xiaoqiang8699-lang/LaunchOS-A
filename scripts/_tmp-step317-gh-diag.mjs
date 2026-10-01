import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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
const {
  createInstallationAccessToken,
  isGitHubAppConfigured,
  listInstallationRepositories,
} = requireApi('@launchos/github');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');

const PROJECT = 'cmunhwais0003rl01wqj1qy11';
const TARGET_HOST = '116.62.198.184';
const prisma = new PrismaClient();

const src = await prisma.sourceRepository.findFirst({
  where: { projectId: PROJECT },
  orderBy: { createdAt: 'desc' },
});
const conn = src?.connectionId
  ? await prisma.gitProviderConnection.findUnique({ where: { id: src.connectionId } })
  : null;

console.log(
  JSON.stringify(
    {
      configured: isGitHubAppConfigured(),
      source: src && {
        id: src.id,
        url: src.url,
        fullName: src.fullName,
        branch: src.branch,
        isPrivate: src.isPrivate,
        authStatus: src.authStatus,
        connectionId: src.connectionId,
      },
      conn: conn && {
        id: conn.id,
        status: conn.status,
        installationId: conn.installationId,
        accountLogin: conn.accountLogin,
      },
    },
    null,
    2,
  ),
);

let tokenOk = false;
let token = null;
if (conn?.installationId) {
  try {
    const tok = await createInstallationAccessToken(conn.installationId);
    tokenOk = true;
    token = tok.token;
    console.log('TOKEN_OK expires', tok.expiresAt, 'len', tok.token.length);
    const repos = await listInstallationRepositories(conn.installationId);
    console.log(
      'REPOS',
      (repos || []).slice(0, 15).map((r) => r.full_name || r.fullName || r.name),
    );
  } catch (e) {
    console.log('TOKEN_FAIL', e?.code || '', e?.message || String(e));
  }
}

if (conn && conn.status !== 'ACTIVE') {
  await prisma.gitProviderConnection.update({
    where: { id: conn.id },
    data: { status: 'ACTIVE' },
  });
  if (src) {
    await prisma.sourceRepository.update({
      where: { id: src.id },
      data: { authStatus: 'ACTIVE' },
    });
  }
  console.log('REACTIVATED_CONNECTION');
}

const deps = await prisma.deployment.findMany({
  where: { projectId: PROJECT },
  orderBy: { createdAt: 'desc' },
  take: 4,
  select: { id: true, status: true, createdAt: true, failureReason: true, environmentId: true },
});
console.log('DEPS', deps);
for (const d of deps.slice(0, 2)) {
  const steps = await prisma.deploymentStep.findMany({
    where: { deploymentId: d.id },
    orderBy: { createdAt: 'asc' },
    select: { stepKey: true, status: true, errorMessage: true },
  });
  const logs = await prisma.deploymentLog.findMany({
    where: { deploymentId: d.id },
    orderBy: { createdAt: 'asc' },
    take: 30,
    select: { level: true, message: true },
  });
  console.log('---', d.id);
  console.log('STEPS', steps);
  console.log('LOGS', logs.map((l) => l.message));
}

// Probe from worker container: git + ls-remote with installation token
const server = await prisma.serverInstance.findFirst({ where: { host: TARGET_HOST } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});

const probe = await runner.execute(
  shellCommand(`podman exec launchos-alpha-worker sh -lc 'which git; git --version; echo PEM=\${GITHUB_APP_PRIVATE_KEY:+yes}; env | grep -E "^GITHUB_APP_" | sed "s/=.*//" | sort'`),
  { timeoutMs: 30000 },
);
console.log('WORKER_PROBE', probe.stdout || '', probe.stderr || '', 'exit', probe.exitCode);

if (tokenOk && src?.url) {
  // Write token to a temp file inside worker via stdin-safe approach using env file
  const url = src.url;
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  const ls = await runner.execute(
    shellCommand(
      `podman exec -e AUTH_B64='${basic}' launchos-alpha-worker sh -lc 'git -c http.version=HTTP/1.1 -c http.extraHeader="AUTHORIZATION: basic \$AUTH_B64" ls-remote --heads "${url}" HEAD 2>&1 | head -n 5'`,
    ),
    { timeoutMs: 60000 },
  );
  console.log('LS_REMOTE', 'exit', ls.exitCode, (ls.stdout || ls.stderr || '').slice(0, 500));
}

await runner.disconnect().catch(() => {});
await prisma.$disconnect();
