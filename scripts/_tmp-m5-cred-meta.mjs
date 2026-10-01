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
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, isEncryptedCredential } = requireApi('@launchos/shared');
const prisma = new PrismaClient();
const s = await prisma.serverInstance.findFirst({ where: { host: '116.62.198.184' } });
const enc = s.credentialEncrypted;
console.log(
  JSON.stringify(
    {
      id: s.id,
      updatedAt: s.updatedAt,
      createdAt: s.createdAt,
      encPrefix: String(enc).slice(0, 20),
      encLen: String(enc).length,
      isEnc: isEncryptedCredential(enc),
      passLen: decryptCredential(enc).length,
      metadataKeys: Object.keys(s.metadata || {}),
      metaUpdated: (s.metadata || {}).capacityProbe?.probedAt,
    },
    null,
    2,
  ),
);

// Look for alternate credential sources in related tables
const creds = await prisma.$queryRawUnsafe(
  `SELECT table_name, column_name FROM information_schema.columns WHERE column_name ILIKE '%credential%' OR column_name ILIKE '%password%' ORDER BY 1,2`,
);
console.log('cred-cols', creds);

await prisma.$disconnect();
