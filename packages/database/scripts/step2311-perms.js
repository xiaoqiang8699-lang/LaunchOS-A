const fs = require('fs');
const path = require('path');
function loadEnv() {
  for (const line of fs.readFileSync(path.resolve(__dirname, '../../../.env'), 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[k] = v;
  }
}
loadEnv();
const { createGitHubAppJwt } = require('../../github/dist');
(async () => {
  const key = process.env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n');
  const jwt = createGitHubAppJwt(process.env.GITHUB_APP_ID, key);
  const ir = await fetch('https://api.github.com/app/installations/161887508/access_tokens', {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${jwt}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'LaunchOS',
    },
    body: '{}',
  });
  const ij = await ir.json();
  console.log(JSON.stringify({
    status: ir.status,
    permissions: ij.permissions || null,
    selection: ij.repository_selection || null,
    hasToken: Boolean(ij.token),
  }, null, 2));
})();
