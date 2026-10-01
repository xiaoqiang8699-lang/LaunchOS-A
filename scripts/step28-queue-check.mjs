import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

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

// Prefer names from @launchos/shared queue helpers if present
const names = [
  'deploymentQueue',
  'systemCertQueue',
  'serverProvisionQueue',
  'databaseProvisionQueue',
  'redisProvisionQueue',
  'serverInitializationQueue',
];

for (const n of names) {
  const workers = await r.smembers(`bull:${n}:workers`);
  console.log(`${n}\tconsumer=${workers.length}`);
}
await r.quit();
