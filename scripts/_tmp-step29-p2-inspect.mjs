import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(resolve(root, '.env'), 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i <= 0) continue;
  const k = t.slice(0, i).trim();
  let v = t.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (process.env[k] === undefined) process.env[k] = v;
}

const require = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = require('@launchos/database');
const p = new PrismaClient();
const server = await p.serverInstance.findUnique({
  where: { id: 'cmub78pz001sdripco5pexhdz' },
  select: { id: true, host: true, metadata: true, status: true, provider: true },
});
const oldGw = await p.serverInstance.findUnique({
  where: { id: 'cmu25on0i0009ri7cvjsnmew3' },
  select: { id: true, host: true, status: true, username: true },
}).catch(() => null);
const cloud = await p.cloudResource.findMany({
  where: {
    OR: [
      { providerResourceId: { contains: 'i-' } },
      { type: { in: ['ECS', 'SERVER', 'SECURITY_GROUP'] } },
    ],
  },
  select: { id: true, type: true, status: true, name: true, metadata: true, providerResourceId: true },
  take: 20,
}).catch(() => []);

const webMain = join(
  'C:\\Users\\柠蜜\\AppData\\Local\\Temp\\launchos-repos\\cmu3j24mv0001ri7wcsoa30hj\\apps\\web\\main.js',
);
console.log(
  JSON.stringify(
    {
      server: {
        id: server?.id,
        host: server?.host,
        status: server?.status,
        metaKeys: server?.metadata && typeof server.metadata === 'object' ? Object.keys(server.metadata) : [],
        metadata: server?.metadata,
      },
      oldGw,
      cloud: cloud.map((c) => ({
        id: c.id,
        type: c.type,
        status: c.status,
        name: c.name,
        providerResourceId: c.providerResourceId,
        metaKeys:
          c.metadata && typeof c.metadata === 'object' ? Object.keys(c.metadata) : [],
      })),
      webMainExists: require('node:fs').existsSync(webMain),
      webMainSnippet: require('node:fs').existsSync(webMain)
        ? require('node:fs').readFileSync(webMain, 'utf8').slice(0, 300)
        : null,
    },
    null,
    2,
  ),
);
await p.$disconnect();
