const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pemPath = process.argv[2];
const root = path.resolve(__dirname, '..');
const envPath = path.join(root, '.env');
const pem = fs.readFileSync(pemPath, 'utf8').trim().replace(/\r\n/g, '\n');
crypto.createPrivateKey(pem);
const value = `"${pem.replace(/\n/g, '\\n')}"`;
let text = fs.readFileSync(envPath, 'utf8');
text = /^GITHUB_APP_PRIVATE_KEY=/m.test(text)
  ? text.replace(/^GITHUB_APP_PRIVATE_KEY=.*$/m, `GITHUB_APP_PRIVATE_KEY=${value}`)
  : text + `\nGITHUB_APP_PRIVATE_KEY=${value}\n`;
fs.writeFileSync(envPath, text);
for (const k of Object.keys(process.env)) if (k.startsWith('GITHUB_')) delete process.env[k];
for (const line of fs.readFileSync(envPath,'utf8').split(/\r?\n/)) {
  const t=line.trim(); if(!t||t.startsWith('#')||!t.includes('=')) continue;
  const i=t.indexOf('='); const key=t.slice(0,i).trim(); let v=t.slice(i+1).trim();
  if ((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'"))) v=v.slice(1,-1);
  process.env[key]=v;
}
const gh = require(path.join(root, 'packages/github/dist/index.js'));
const cfg = gh.readGitHubAppConfig();
const jwt = gh.createGitHubAppJwt(cfg.appId, cfg.privateKey);
(async () => {
  const r = await fetch('https://api.github.com/app', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${jwt}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'LaunchOS',
    },
  });
  const body = await r.json().catch(() => ({}));
  console.log(JSON.stringify({ ok: r.ok, status: r.status, appId: body.id || null, slug: body.slug || null, keyUpdated: true }, null, 2));
})();
