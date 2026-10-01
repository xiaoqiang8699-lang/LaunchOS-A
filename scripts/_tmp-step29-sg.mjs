import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
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
const cr = await p.cloudResource.findUnique({ where: { id: 'cmuas8iiz0001riown1l1a0o3' } });
const meta = cr?.metadata && typeof cr.metadata === 'object' ? cr.metadata : {};
console.log(
  JSON.stringify(
    {
      type: cr?.type,
      status: cr?.status,
      keys: Object.keys(meta),
      securityGroupId: meta.securityGroupId || meta.SecurityGroupId || null,
      authorizedPorts: meta.authorizedPorts || meta.securityGroupPorts || meta.ports || null,
      network: meta.network || meta.vpc || null,
      slice: JSON.stringify(meta).slice(0, 1500),
    },
    null,
    2,
  ),
);
await p.$disconnect();
