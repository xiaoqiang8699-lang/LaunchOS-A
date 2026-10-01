import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
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

const DEP = 'cmunoy33y005rrl01dnkps3rp';
const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: '116.62.198.184' } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});

const script = `#!/bin/bash
set +e
echo ===LOGS===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT left(message,500) FROM \\"DeploymentLog\\" WHERE \\"deploymentId\\"='${DEP}' ORDER BY \\"createdAt\\" ASC LIMIT 80;"
echo ===CONN===
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, \\"installationId\\" FROM \\"GitProviderConnection\\" WHERE id='cmump0lbq0018rl01n2beawv6'; SELECT id, \\"authStatus\\", \\"isPrivate\\", coalesce(\\"fullName\\",'') FROM \\"SourceRepository\\" WHERE \\"projectId\\"='cmunhwais0003rl01wqj1qy11';"
echo ===WORKER_TAIL===
podman logs --tail 120 launchos-alpha-worker 2>&1 | sed -E 's/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer|gh[pousr]_[A-Za-z0-9_]{20,}|x-access-token:)[^ ]+/\\1***/gi' | grep -E 'cmunoy33y|Git|tarball|VALIDATE|github|403|401|rate|fetch|error|Error|fail' | tail -60
echo ===PROBE_TARBALL===
podman exec launchos-alpha-worker sh -lc 'ls -la /tmp/launchos-repos/cmunhwais0003rl01wqj1qy11/apps/web/package.json 2>/dev/null; ls /tmp/launchos-repos/cmunhwais0003rl01wqj1qy11/apps/web 2>/dev/null | head'
`;
await runner.writeTextFile('/opt/launchos/bin/step317-web-git-diag.sh', script);
const r = await runner.execute(
  shellCommand('chmod 700 /opt/launchos/bin/step317-web-git-diag.sh && /opt/launchos/bin/step317-web-git-diag.sh'),
  { timeoutMs: 90000 },
);
console.log(r.stdout || r.stderr);
await runner.disconnect();
await prisma.$disconnect();
