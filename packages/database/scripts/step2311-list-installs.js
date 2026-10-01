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
  const list = await fetch('https://api.github.com/app/installations', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${jwt}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'LaunchOS',
    },
  });
  const arr = await list.json();
  console.log(JSON.stringify({
    status: list.status,
    installations: Array.isArray(arr)
      ? arr.map((i) => ({
          id: i.id,
          account: i.account?.login,
          type: i.account?.type,
          selection: i.repository_selection,
          permissions: i.permissions,
          suspended: Boolean(i.suspended_at),
        }))
      : arr,
  }, null, 2));
})();
