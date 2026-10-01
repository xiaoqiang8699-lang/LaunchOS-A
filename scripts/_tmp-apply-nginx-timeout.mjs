import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of [resolve(root, '.env'), resolve(root, '.secrets/alpha-data-plane.env')]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
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

const INCLUDE = '/opt/launchos/gateway/active/launchos-routes.conf';
const ARTIFACT = resolve(root, '.tools', 'alpha-runtime');
const PROTECTED = [
  'alpha.zsaos.com',
  'api-alpha.zsaos.com',
  'web-launchos.zsaos.com',
  'api-launchos.zsaos.com',
  'oneclick-web.zsaos.com',
  'launchos-real-test.zsaos.com',
];

function patchApiAlphaTimeouts(conf) {
  const TIMEOUT_LINES = [
    '        proxy_connect_timeout 60s;',
    '        proxy_send_timeout 300s;',
    '        proxy_read_timeout 300s;',
  ];
  const blocks = [];
  let index = 0;
  while (index < conf.length) {
    const start = conf.indexOf('server', index);
    if (start < 0) {
      blocks.push({ type: 'text', text: conf.slice(index) });
      break;
    }
    if (start > index) blocks.push({ type: 'text', text: conf.slice(index, start) });
    const brace = conf.indexOf('{', start);
    if (brace < 0) {
      blocks.push({ type: 'text', text: conf.slice(start) });
      break;
    }
    let depth = 0;
    let end = brace;
    for (; end < conf.length; end += 1) {
      if (conf[end] === '{') depth += 1;
      else if (conf[end] === '}') {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      }
    }
    blocks.push({ type: 'server', text: conf.slice(start, end) });
    index = end;
  }
  let changed = 0;
  const out = blocks
    .map((b) => {
      if (b.type !== 'server') return b.text;
      if (!/server_name\s+[^;]*api-alpha\.zsaos\.com/i.test(b.text)) return b.text;
      if (!/proxy_pass\s+/i.test(b.text)) return b.text;
      let block = b.text;
      block = block.replace(/^\s*proxy_(?:read|send|connect)_timeout\s+[^;]+;\s*\n?/gm, '');
      block = block.replace(/(proxy_pass\s+[^;]+;\s*\n)/i, `$1${TIMEOUT_LINES.join('\n')}\n`);
      changed += 1;
      return block;
    })
    .join('');
  return { conf: out, changed };
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

const cur = await runner.execute(shellCommand(`cat ${INCLUDE}`), { timeoutMs: 20000 });
const { conf: patched, changed } = patchApiAlphaTimeouts(String(cur.stdout || ''));
console.log('CHANGED', changed, 'HAS', /proxy_read_timeout\s+300s/.test(patched));
for (const h of PROTECTED) {
  if (!patched.includes(h)) throw new Error('missing ' + h);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const local = join(ARTIFACT, `step314-routes-timeout-${stamp}.conf`);
writeFileSync(local, patched, 'utf8');
const remoteTemp = `/opt/launchos/gateway/generated/routes-timeout-${stamp}.conf`;
const remoteBackup = `/opt/launchos/gateway/backups/routes-timeout-${stamp}.conf`;
await runner.upload(local, remoteTemp, { timeoutMs: 60000 });

// Avoid multiline set -e under sh -lc; use && chain. Do NOT wrap again with conflicting set.
const cmd = `cp -f ${INCLUDE} ${remoteBackup} && cp -f ${remoteTemp} ${INCLUDE} && nginx -t && nginx -s reload && grep -nE 'api-alpha|proxy_read_timeout|proxy_send_timeout|proxy_connect_timeout' ${INCLUDE} | head -n 40`;
const apply = await runner.execute(shellCommand(cmd), { timeoutMs: 30000 });
console.log('APPLY_EXIT', apply.exitCode);
console.log('APPLY_OUT', apply.stdout);
console.log('APPLY_ERR', apply.stderr);

const after = await runner.execute(
  shellCommand(`grep -nE 'api-alpha|proxy_read_timeout|proxy_send_timeout|proxy_connect_timeout' ${INCLUDE} | head -n 40; wc -c ${INCLUDE}`),
  { timeoutMs: 15000 },
);
console.log('AFTER', after.stdout);

await runner.disconnect();
await prisma.$disconnect();
if (apply.exitCode !== 0 || !/proxy_read_timeout\s+300s/.test(String(after.stdout || ''))) {
  process.exit(1);
}
console.log('NGINX_TIMEOUT_OK');
