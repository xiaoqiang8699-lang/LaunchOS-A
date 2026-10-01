const fs = require('fs');
const path = require('path');
const envPath = path.resolve(__dirname, '../../../.env');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const i = trimmed.indexOf('=');
  if (i <= 0) continue;
  const key = trimmed.slice(0, i).trim();
  let value = trimmed.slice(i + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  if (!(key in process.env)) process.env[key] = value;
}
const { PrismaClient } = require('../generated/client');
const { createInstallationAccessToken, listInstallationRepositories } = require('../../github/dist');
const p = new PrismaClient();
async function main() {
  const connections = await p.gitProviderConnection.findMany({
    select: { id: true, workspaceId: true, provider: true, installationId: true, login: true, status: true, createdAt: true },
  });
  console.log('connections', JSON.stringify(connections, null, 2));
  const servers = await p.serverInstance.findMany({ select: { id: true, name: true, host: true, port: true }, take: 10 });
  console.log('servers', JSON.stringify(servers, null, 2));
  for (const c of connections) {
    try {
      const token = await createInstallationAccessToken(c.installationId);
      const repos = await listInstallationRepositories(token.token);
      const summary = repos.map((r) => ({ fullName: r.fullName, private: r.private, defaultBranch: r.defaultBranch, htmlUrl: r.htmlUrl }));
      console.log('private_repos', c.login || c.installationId, JSON.stringify(summary.filter((r) => r.private), null, 2));
      console.log('counts', c.login || c.installationId, 'private=', summary.filter((r) => r.private).length, 'public=', summary.filter((r) => !r.private).length);
      console.log('all_names', summary.map((r) => (r.private ? 'P:' : 'U:') + r.fullName).join(', '));
    } catch (e) {
      console.error('list failed', c.installationId, e instanceof Error ? e.message : e);
    }
  }
  const users = await p.user.findMany({ select: { email: true }, take: 20, orderBy: { createdAt: 'desc' } });
  console.log('users', users.map((u) => u.email));
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => p.$disconnect());
