import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

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
const bcrypt = requireApi('bcrypt');

const TARGET = '116.62.198.184';
const API_HOST = 'api-alpha.zsaos.com';
const WEB_ORIGIN = 'https://alpha.zsaos.com';
const API_ORIGIN = `https://${API_HOST}`;

function curlResolve(url, host, { method = 'GET', headers = {}, body = null, maxTime = '90' } = {}) {
  const args = ['-k','-sS','-X',method,'--resolve',`${host}:443:${TARGET}`,'-w','\n__STATUS__:%{http_code}','--max-time',String(maxTime)];
  for (const [k,v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body != null) { args.push('-H','content-type: application/json','--data-binary', body); }
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
  const out = String(r.stdout||'');
  const m = out.match(/\n__STATUS__:(\d+)\s*$/);
  return { status: m?Number(m[1]):0, text: m?out.slice(0,m.index):out };
}
function parseJson(t){ try{return JSON.parse(t);}catch{return null;} }

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: TARGET } });
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username: resolveServerSshUsername(server.username), password: decryptCredential(server.credentialEncrypted), readyTimeoutMs: 20000 });

// Patch catch to log real error
const pull = await runner.execute(shellCommand(`podman exec launchos-alpha-api cat /app/apps/api/dist/analyses/analyses.service.js`), { timeoutMs: 30000 });
let js = String(pull.stdout || '');
if (!js.includes('STEP314_CLONE_ERR')) {
  const needle = `catch (error) {
                if (error instanceof common_1.BadRequestException) {
                    throw error;
                }
                if (error instanceof github_1.GitHubAppError) {
                    throw new common_1.BadRequestException(error.message || CODE_READ_FAILED);
                }
                if (error instanceof git_1.GitError) {
                    throw new common_1.BadRequestException(CODE_READ_FAILED);
                }
                throw new common_1.BadRequestException(CODE_READ_FAILED);
            }`;
  // Flexible replace
  const re = /catch \(error\) \{\s*if \(error instanceof common_1\.BadRequestException\) \{\s*throw error;\s*\}\s*if \(error instanceof github_1\.GitHubAppError\) \{\s*throw new common_1\.BadRequestException\(error\.message \|\| CODE_READ_FAILED\);\s*\}\s*if \(error instanceof git_1\.GitError\) \{\s*throw new common_1\.BadRequestException\(CODE_READ_FAILED\);\s*\}\s*throw new common_1\.BadRequestException\(CODE_READ_FAILED\);\s*\}/;
  if (!re.test(js)) {
    console.log('NEEDLE_MISS sample', js.includes('CODE_READ_FAILED'), js.indexOf('catch (error)'));
    // dump surrounding catch
    const i = js.indexOf('await this.git.cloneRepository');
    console.log(js.slice(i, i+900));
    throw new Error('catch block not found');
  }
  js = js.replace(re, `catch (error) {
                console.error('STEP314_CLONE_ERR', error && (error.stack || error.message || error));
                if (error instanceof common_1.BadRequestException) {
                    throw error;
                }
                if (error instanceof github_1.GitHubAppError) {
                    throw new common_1.BadRequestException(error.message || CODE_READ_FAILED);
                }
                if (error instanceof git_1.GitError) {
                    throw new common_1.BadRequestException(CODE_READ_FAILED);
                }
                throw new common_1.BadRequestException(CODE_READ_FAILED);
            }`);
  const local = join(root, '.tools/alpha-runtime/step314-analyses.service.logpatch.js');
  writeFileSync(local, js);
  await runner.upload(local, '/opt/launchos/tmp/step314-analyses.service.js', { timeoutMs: 60000 });
  await runner.execute(shellCommand(`podman cp /opt/launchos/tmp/step314-analyses.service.js launchos-alpha-api:/app/apps/api/dist/analyses/analyses.service.js && podman restart launchos-alpha-api`), { timeoutMs: 90000 });
  await new Promise((r) => setTimeout(r, 6000));
  const health = curlResolve(`${API_ORIGIN}/api/v1/health`, API_HOST, { maxTime: '30' });
  console.log('HEALTH', health.status, health.text.slice(0,80));
} else {
  console.log('LOGPATCH_ALREADY');
}

// public analyze one-shot
const email = `alpha-s314-diag-${Date.now()}@zsaos.test`;
const pass = `Alpha${randomBytes(5).toString('hex')}!aA1`;
curlResolve(`${API_ORIGIN}/api/v1/auth/register`, API_HOST, { method:'POST', headers:{origin:WEB_ORIGIN}, body: JSON.stringify({email,password:pass,name:'Diag'}), maxTime:'60' });
const login = curlResolve(`${API_ORIGIN}/api/v1/auth/login`, API_HOST, { method:'POST', headers:{origin:WEB_ORIGIN}, body: JSON.stringify({email,password:pass}), maxTime:'60' });
const tok = parseJson(login.text)?.accessToken;
const auth = { authorization: `Bearer ${tok}`, origin: WEB_ORIGIN };
const conn = curlResolve(`${API_ORIGIN}/api/v1/onboarding/source/public`, API_HOST, { method:'POST', headers:auth, body: JSON.stringify({ cloneUrl:'https://github.com/octocat/Hello-World.git', branch:'master' }), maxTime:'90' });
console.log('CONNECT', conn.status, conn.text.slice(0,200));
const an = curlResolve(`${API_ORIGIN}/api/v1/onboarding/analyze`, API_HOST, { method:'POST', headers:auth, maxTime:'180' });
console.log('ANALYZE', an.status, an.text.slice(0,300));

const logs = await runner.execute(shellCommand(`podman logs --tail 80 launchos-alpha-api 2>&1 | grep -F STEP314_CLONE_ERR -A 5 | tail -n 40`), { timeoutMs: 30000 });
console.log('ERRLOG', (logs.stdout||'').replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g,'***').replace(/x-access-token:[^\s@]+/gi,'x-access-token:***'));

await runner.disconnect(); await prisma.$disconnect();
