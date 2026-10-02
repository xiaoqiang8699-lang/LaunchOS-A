/**
 * Alpha: set client_max_body_size 1400m on api-alpha.zsaos.com for ZIP uploads (1200MB app limit).
 * Safe reload only. Does not alter protected hostnames.
 * node scripts/_tmp-zip-nginx-body-size.mjs --confirm-zip-nginx
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
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
if (!process.argv.includes('--confirm-zip-nginx')) {
  console.error('pass --confirm-zip-nginx');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');

const TARGET_HOST = '116.62.198.184';
const INCLUDE = '/opt/launchos/gateway/active/launchos-routes.conf';
const ARTIFACT = resolve(root, '.tools', 'alpha-runtime');
mkdirSync(ARTIFACT, { recursive: true });
const PROTECTED = [
  'alpha.zsaos.com',
  'api-alpha.zsaos.com',
  'web-launchos.zsaos.com',
  'api-launchos.zsaos.com',
  'oneclick-web.zsaos.com',
  'launchos-real-test.zsaos.com',
];
const BODY_LINE = '    client_max_body_size 1400m;';

function patchApiAlphaBodySize(conf) {
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
      let block = b.text;
      block = block.replace(/^\s*client_max_body_size\s+[^;]+;\s*\n?/gm, '');
      block = block.replace(/\{\s*\n/, `{\n${BODY_LINE}\n`);
      changed += 1;
      return block;
    })
    .join('');
  return { conf: out, changed };
}

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({
  where: { OR: [{ id: 'cmuma9i480001rij49yv4yw2q' }, { host: TARGET_HOST, scope: 'PLATFORM_MANAGED' }] },
});
if (!server) throw new Error('server missing');
const username = resolveServerSshUsername({
  serverUsername: server.username,
  provider: server.provider,
});
const password = decryptCredential(server.credentialEncrypted);
console.log('SSH_TARGET', server.host, username, 'credLen', String(password || '').length);
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username,
  password,
  readyTimeoutMs: 30000,
});

const cur = await runner.execute(shellCommand(`cat ${INCLUDE}`), { timeoutMs: 20000 });
const before = String(cur.stdout || '');
const beforeMatch = before.match(/server_name\s+[^;]*api-alpha\.zsaos\.com[\s\S]*?client_max_body_size\s+([^;]+);/i);
console.log('BEFORE_BODY_SIZE', beforeMatch ? beforeMatch[1].trim() : 'UNSET_OR_DEFAULT');

const { conf: patched, changed } = patchApiAlphaBodySize(before);
console.log('CHANGED_SERVERS', changed);
for (const h of PROTECTED) {
  if (!patched.includes(h)) throw new Error('missing protected host ' + h);
}
if (!/server_name\s+[^;]*api-alpha\.zsaos\.com[\s\S]*?client_max_body_size\s+1400m;/i.test(patched)) {
  throw new Error('patch failed to set 1400m on api-alpha');
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const local = join(ARTIFACT, `zip-routes-body-${stamp}.conf`);
writeFileSync(local, patched, 'utf8');
const remoteTemp = `/opt/launchos/gateway/generated/routes-zip-body-${stamp}.conf`;
const remoteBackup = `/opt/launchos/gateway/backups/routes-zip-body-${stamp}.conf`;
await runner.upload(local, remoteTemp, { timeoutMs: 60000 });

const cmd = `cp -f ${INCLUDE} ${remoteBackup} && cp -f ${remoteTemp} ${INCLUDE} && nginx -t && nginx -s reload && grep -nE 'api-alpha|client_max_body_size' ${INCLUDE} | head -n 40`;
const apply = await runner.execute(shellCommand(cmd), { timeoutMs: 30000 });
console.log('APPLY_EXIT', apply.exitCode);
console.log('APPLY_OUT', apply.stdout);
console.log('APPLY_ERR', apply.stderr);

const after = await runner.execute(
  shellCommand(`grep -nE 'api-alpha|client_max_body_size' ${INCLUDE} | head -n 40`),
  { timeoutMs: 15000 },
);
console.log('AFTER', after.stdout);

await runner.disconnect();
await prisma.$disconnect();
if (apply.exitCode !== 0 || !/client_max_body_size\s+1400m/.test(String(after.stdout || ''))) {
  process.exit(1);
}
console.log('ZIP_NGINX_BODY_SIZE_OK=true');
