import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of [resolve(root, '.env'), resolve(root, 'apps/api/.env'), resolve(root, 'apps/worker/.env')]) {
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

const require = createRequire(resolve(root, 'packages/shared/package.json'));
const Redis = require('ioredis');
const r = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 8000 });
const keys = await r.keys('bull:*');
console.log('bull_keys', keys.length);
for (const k of keys.filter((x) => /worker|meta|id/i.test(x)).slice(0, 60)) {
  console.log(k);
}
for (const n of [
  'deploymentQueue',
  'systemCertQueue',
  'serverProvisionQueue',
  'databaseProvisionQueue',
  'redisProvisionQueue',
  'serverInitializationQueue',
]) {
  const workers = await r.smembers(`bull:${n}:workers`);
  const active = await r.llen(`bull:${n}:active`);
  const wait = await r.llen(`bull:${n}:wait`);
  console.log(`${n}\tworkers=${workers.length}\tactive=${active}\twait=${wait}`);
}
await r.quit();
