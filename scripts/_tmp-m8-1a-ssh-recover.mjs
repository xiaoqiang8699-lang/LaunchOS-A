/**
 * Try Alpha DB server credential + alternate SSH auth.
 * Does not print secrets.
 * node scripts/_tmp-m8-1a-ssh-recover.mjs
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
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

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireRunner = createRequire(resolve(root, 'packages/remote-runner/package.json'));
const { Client } = requireRunner('ssh2');
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername } = requireApi('@launchos/shared');

function fp(s) {
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}

async function trySsh({ host, port, username, password, label }) {
  return new Promise((resolvePromise) => {
    const client = new Client();
    const timer = setTimeout(() => {
      try {
        client.end();
      } catch {}
      resolvePromise({ label, ok: false, error: 'timeout' });
    }, 20000);
    client
      .on('ready', () => {
        clearTimeout(timer);
        client.exec('echo OK', (err, stream) => {
          if (err) {
            client.end();
            resolvePromise({ label, ok: false, error: err.message });
            return;
          }
          let out = '';
          stream.on('data', (d) => {
            out += d.toString();
          });
          stream.on('close', () => {
            client.end();
            resolvePromise({ label, ok: true, out: out.trim() });
          });
        });
      })
      .on('error', (error) => {
        clearTimeout(timer);
        resolvePromise({ label, ok: false, error: error.message });
      })
      .connect({ host, port, username, password, readyTimeout: 15000, tryKeyboard: true });
  });
}

const local = new PrismaClient();
const localServer = await local.serverInstance.findFirst({
  where: { OR: [{ id: 'cmuma9i480001rij49yv4yw2q' }, { host: '116.62.198.184' }] },
});
const localPw = decryptCredential(localServer.credentialEncrypted);
const localUser = resolveServerSshUsername({
  serverUsername: localServer.username,
  provider: localServer.provider,
});

const attempts = [];
attempts.push(
  await trySsh({
    host: localServer.host,
    port: localServer.port || 22,
    username: localUser,
    password: localPw,
    label: 'local-db-root',
  }),
);
attempts.push(
  await trySsh({
    host: localServer.host,
    port: localServer.port || 22,
    username: 'root',
    password: localPw.trim(),
    label: 'local-db-root-trim',
  }),
);

let alphaDbOk = false;
let alphaPwFp = null;
let alphaCredLen = null;
let alphaSameAsLocal = null;
if (process.env.ALPHA_DATABASE_URL) {
  const alpha = new PrismaClient({ datasources: { db: { url: process.env.ALPHA_DATABASE_URL } } });
  try {
    const alphaServer = await alpha.serverInstance.findFirst({
      where: { OR: [{ id: 'cmuma9i480001rij49yv4yw2q' }, { host: '116.62.198.184' }] },
    });
    if (alphaServer?.credentialEncrypted) {
      alphaDbOk = true;
      const alphaPw = decryptCredential(alphaServer.credentialEncrypted);
      alphaPwFp = fp(alphaPw);
      alphaCredLen = alphaPw.length;
      alphaSameAsLocal = alphaPw === localPw;
      attempts.push(
        await trySsh({
          host: alphaServer.host,
          port: alphaServer.port || 22,
          username: resolveServerSshUsername({
            serverUsername: alphaServer.username,
            provider: alphaServer.provider,
          }),
          password: alphaPw,
          label: 'alpha-db-root',
        }),
      );
    }
  } catch (error) {
    attempts.push({ label: 'alpha-db', ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    await alpha.$disconnect();
  }
}

console.log(
  JSON.stringify(
    {
      localPwLen: localPw.length,
      localPwFp: fp(localPw),
      alphaDbOk,
      alphaPwFp,
      alphaCredLen,
      alphaSameAsLocal,
      jwtFp: fp(process.env.JWT_SECRET || ''),
      attempts,
    },
    null,
    2,
  ),
);
await local.$disconnect();
if (!attempts.some((a) => a.ok)) process.exitCode = 1;
