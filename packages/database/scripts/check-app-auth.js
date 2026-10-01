const fs = require('fs');
const path = require('path');
const envPath = path.resolve(__dirname, '../../../.env');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i <= 0) continue;
  const k = t.slice(0, i).trim();
  let v = t.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!(k in process.env)) process.env[k] = v;
}
const { PrismaClient } = require('../generated/client');
const { createInstallationAccessToken, listInstallationRepositories, isGitHubAppConfigured, readGitHubAppConfig } = require('../../github/dist');
const p = new PrismaClient();
function mask(s){ return s ? `${String(s).slice(0,4)}…(len=${String(s).length})` : null; }
async function main(){
  const cfg = readGitHubAppConfig();
  console.log(JSON.stringify({
    configured: isGitHubAppConfigured(),
    hasAppId: Boolean(cfg?.appId),
    hasSlug: Boolean(cfg?.slug),
    hasPrivateKey: Boolean(cfg?.privateKey),
    privateKeyLen: cfg?.privateKey ? cfg.privateKey.length : 0,
    slug: cfg?.slug || null,
  }, null, 2));
  const connections = await p.gitProviderConnection.findMany({
    select: { id:true, workspaceId:true, installationId:true, login:true, status:true, provider:true,
      workspace:{ select:{ id:true, name:true, members:{ select:{ role:true, user:{ select:{ email:true } } } } } }
    }
  });
  console.log('connections', JSON.stringify(connections, null, 2));
  for (const c of connections) {
    const issued = await createInstallationAccessToken(c.installationId);
    console.log(JSON.stringify({
      installationId: c.installationId,
      tokenIssued: Boolean(issued?.token),
      tokenLen: issued?.token ? issued.token.length : 0,
      expiresAt: issued?.expiresAt || null,
      tokenPreview: mask(issued?.token),
    }, null, 2));
    const repos = await listInstallationRepositories(issued.token);
    console.log(JSON.stringify({
      repoCount: repos.length,
      repos: repos.map(r => ({ fullName:r.fullName, private:r.private, defaultBranch:r.defaultBranch })),
    }, null, 2));
  }
}
main().catch(e=>{ console.error('ERR', e instanceof Error ? e.message : e); process.exitCode=1; }).finally(()=>p.$disconnect());
