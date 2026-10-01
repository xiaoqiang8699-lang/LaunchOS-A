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

function patchClean(conf) {
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
      // strip ALL timeout directives in block (any indent)
      block = block.replace(/^[ \t]*proxy_(?:read|send|connect)_timeout[ \t]+[^;]+;[ \t]*\r?\n?/gm, '');
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
const { conf: patched, changed } = patchClean(String(cur.stdout || ''));
console.log('CHANGED', changed);
console.log('TIMEOUT_COUNT', (patched.match(/proxy_read_timeout/g) || []).length);
console.log('SEND_COUNT', (patched.match(/proxy_send_timeout/g) || []).length);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const local = join(ARTIFACT, `step314-routes-timeout-clean-${stamp}.conf`);
writeFileSync(local, patched, 'utf8');
const remoteTemp = `/opt/launchos/gateway/generated/routes-timeout-clean-${stamp}.conf`;
const remoteBackup = `/opt/launchos/gateway/backups/routes-timeout-clean-${stamp}.conf`;
await runner.upload(local, remoteTemp, { timeoutMs: 60000 });

const apply = await runner.execute(
  shellCommand(
    `cp -f ${INCLUDE} ${remoteBackup} && cp -f ${remoteTemp} ${INCLUDE} && nginx -t && nginx -s reload && grep -nE 'api-alpha|proxy_read_timeout|proxy_send_timeout|proxy_connect_timeout' ${INCLUDE} | head -n 40`,
  ),
  { timeoutMs: 30000 },
);
console.log('EXIT', apply.exitCode);
console.log('OUT', apply.stdout);
console.log('ERR', apply.stderr);

await runner.disconnect();
await prisma.$disconnect();
process.exit(apply.exitCode === 0 && /proxy_read_timeout\s+300s/.test(apply.stdout || '') ? 0 : 1);
