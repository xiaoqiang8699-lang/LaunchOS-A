/**
 * Read-only: dump DescribeAvailableResource shape (no CreateInstance).
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
for (const line of readFileSync(resolve(root, '.env'), 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i <= 0) continue;
  const k = t.slice(0, i).trim();
  let v = t.slice(i + 1).trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1);
  }
  if (process.env[k] === undefined) process.env[k] = v;
}

const { PrismaClient } = require(resolve(root, 'packages/database/generated/client'));
const { decryptCredential } = require(resolve(root, 'packages/shared/dist/index.js'));
const requireP = createRequire(resolve(root, 'packages/providers/package.json'));
const Kv = requireP('@alicloud/r-kvstore20150101');
const openapi = requireP('@alicloud/openapi-core');

const prisma = new PrismaClient();
const account = await prisma.providerAccount.findFirst({
  where: { status: 'ACTIVE', provider: { type: 'ALIYUN' } },
  orderBy: { createdAt: 'asc' },
});
const secrets = JSON.parse(decryptCredential(account.credentialEncrypted));
const config = new openapi.$OpenApiUtil.Config({
  accessKeyId: secrets.accessKey,
  accessKeySecret: secrets.secretKey,
});
config.endpoint = 'r-kvstore.aliyuncs.com';
const kv = new Kv.default(config);

const region = 'cn-hangzhou';
const response = await kv.describeAvailableResource(
  new Kv.DescribeAvailableResourceRequest({
    regionId: region,
    instanceChargeType: 'PostPaid',
    productType: 'Local',
    engine: 'Redis',
  }),
);

const body = response.body || {};
const outPath = resolve(root, '.tools/step-254-available-resource-raw.json');
writeFileSync(outPath, JSON.stringify(body, null, 2));

// Walk and extract instanceClass + engineVersion pairs for redis.master.small.default
const text = JSON.stringify(body);
const classHits = [...new Set(text.match(/redis\.[a-z0-9._-]+/gi) || [])].sort();
const versionHits = [...new Set(text.match(/"[0-9]+\.[0-9]+"/g) || [])].sort();

function walk(node, path = [], acc = []) {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    node.forEach((item, i) => walk(item, path.concat(String(i)), acc));
    return acc;
  }
  const keys = Object.keys(node);
  const hasClass = keys.some((k) => /instanceclass/i.test(k));
  const hasVersion = keys.some((k) => /engineversion/i.test(k));
  if (hasClass || hasVersion) {
    acc.push({
      path: path.join('.'),
      keys,
      sample: Object.fromEntries(
        keys.slice(0, 20).map((k) => {
          const v = node[k];
          if (v && typeof v === 'object') return [k, Array.isArray(v) ? `[array:${v.length}]` : '{obj}'];
          return [k, v];
        }),
      ),
    });
  }
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === 'object') walk(v, path.concat(k), acc);
  }
  return acc;
}

const nodes = walk(body).slice(0, 40);

// Focused extract for small.default
function collectCombos(node, ctx = {}, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectCombos(item, ctx, out);
    return out;
  }
  const next = { ...ctx };
  for (const [k, v] of Object.entries(node)) {
    const lk = k.toLowerCase();
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      if (lk.includes('zoneid') || lk === 'zone') next.zoneId = String(v);
      if (lk.includes('engineversion')) next.engineVersion = String(v);
      if (lk === 'engine') next.engine = String(v);
      if (lk.includes('instanceclass') || lk === 'instanceclass') next.instanceClass = String(v);
      if (lk.includes('architecture')) next.architecture = String(v);
      if (lk.includes('edition') || lk.includes('product')) next.productHint = String(v);
      if (lk.includes('nodetype')) next.nodeType = String(v);
      if (lk.includes('series')) next.series = String(v);
      if (lk === 'status' || lk.includes('available') || lk.includes('soldout')) {
        next.availabilityHint = String(v);
      }
    }
  }
  if (next.instanceClass && next.engineVersion) {
    out.push({ ...next });
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') collectCombos(v, next, out);
  }
  return out;
}

const combos = collectCombos(body);
const small = combos.filter((c) => /redis\.master\.small\.default/i.test(c.instanceClass || ''));
const uniqueSmallVersions = [...new Set(small.map((c) => c.engineVersion))].sort();
const uniqueClasses = [...new Set(combos.map((c) => c.instanceClass).filter(Boolean))].sort();
const byClassVersion = {};
for (const c of combos) {
  if (!c.instanceClass) continue;
  byClassVersion[c.instanceClass] ||= new Set();
  if (c.engineVersion) byClassVersion[c.instanceClass].add(c.engineVersion);
}

console.log(
  JSON.stringify(
    {
      region,
      rawSavedTo: outPath,
      topKeys: Object.keys(body),
      classHitsCount: classHits.length,
      classHitsSample: classHits.slice(0, 30),
      versionHitsSample: versionHits.slice(0, 20),
      interestingNodes: nodes.slice(0, 15),
      comboCount: combos.length,
      uniqueClassesCount: uniqueClasses.length,
      uniqueClassesSample: uniqueClasses.slice(0, 40),
      smallDefault: {
        comboCount: small.length,
        engineVersions: uniqueSmallVersions,
        sample: small.slice(0, 5),
      },
      classToVersions: Object.fromEntries(
        Object.entries(byClassVersion)
          .slice(0, 25)
          .map(([k, v]) => [k, [...v].sort()]),
      ),
    },
    null,
    2,
  ),
);
await prisma.$disconnect();
