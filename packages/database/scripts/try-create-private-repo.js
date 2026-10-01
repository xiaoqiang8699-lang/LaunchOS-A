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
const { createInstallationAccessToken, listInstallationRepositories, getInstallation } = require('../../github/dist');
const p = new PrismaClient();
async function main() {
  const c = await p.gitProviderConnection.findFirst({ where: { status: 'ACTIVE' } });
  if (!c) throw new Error('no active connection');
  const issued = await createInstallationAccessToken(c.installationId);
  const token = issued.token;
  // Probe installation account / permissions without printing token
  const inst = await getInstallation(c.installationId);
  console.log(JSON.stringify({ installationId: c.installationId, accountLogin: inst.accountLogin || inst.login || null, accountType: inst.accountType || null, accountId: inst.accountId || null }, null, 2));
  // Try create private repo via installation token (may fail for user accounts)
  const name = 'launchos-private-web-238';
  const createRes = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'LaunchOS-Acceptance',
    },
    body: JSON.stringify({ name, private: true, description: 'LaunchOS Step 23.8 private web acceptance', auto_init: false }),
  });
  const createBody = await createRes.text();
  console.log(JSON.stringify({ createStatus: createRes.status, createOk: createRes.ok, createHint: createBody.slice(0, 300).replace(/ghs_[A-Za-z0-9_]+/g, '***') }, null, 2));
  // Also try org endpoint if account looks like org
  if (!createRes.ok && (inst.accountLogin || c.login)) {
    const login = inst.accountLogin || c.login;
    const orgRes = await fetch(`https://api.github.com/orgs/${encodeURIComponent(login)}/repos`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'LaunchOS-Acceptance',
      },
      body: JSON.stringify({ name, private: true, description: 'LaunchOS Step 23.8 private web acceptance', auto_init: false }),
    });
    const orgBody = await orgRes.text();
    console.log(JSON.stringify({ orgCreateStatus: orgRes.status, orgCreateOk: orgRes.ok, orgHint: orgBody.slice(0, 300).replace(/ghs_[A-Za-z0-9_]+/g, '***') }, null, 2));
  }
  const repos = await listInstallationRepositories(token);
  console.log(JSON.stringify({ repos: repos.map(r => ({ fullName: r.fullName, private: r.private, defaultBranch: r.defaultBranch })) }, null, 2));
}
main().catch(e => { console.error('ERR', e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(() => p.$disconnect());
