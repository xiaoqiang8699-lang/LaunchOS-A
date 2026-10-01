import { createRequire } from 'node:module';
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
const requireRr = createRequire(resolve(root, 'packages/remote-runner/package.json'));
const { Client } = requireRr('ssh2');
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential } = requireApi('@launchos/shared');
const prisma = new PrismaClient();
const s = await prisma.serverInstance.findFirst({ where: { host: '116.62.198.184' } });
const password = decryptCredential(s.credentialEncrypted);
console.log('passLen', password.length, 'hasNl', /\r|\n/.test(password));

await new Promise((resolvePromise, reject) => {
  const client = new Client();
  client
    .on('ready', () => {
      console.log('READY');
      client.exec('echo ok', (err, stream) => {
        if (err) return reject(err);
        stream.on('data', (d) => console.log('out', String(d)));
        stream.on('close', () => {
          client.end();
          resolvePromise();
        });
      });
    })
    .on('error', (e) => {
      console.log('error', e.message, e.level || '');
      reject(e);
    })
    .connect({
      host: s.host,
      port: s.port,
      username: 'root',
      password,
      readyTimeout: 30000,
      tryKeyboard: true,
      debug: (m) => {
        if (/auth|pass|fail|banner|disconnect/i.test(m)) console.log('dbg', m);
      },
    });
}).catch(() => undefined);

await prisma.$disconnect();
