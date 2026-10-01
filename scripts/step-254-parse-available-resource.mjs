/**
 * Parse DescribeAvailableResource tree properly (inherit parent engineVersion).
 * Also probe Local + OnECS product types. No CreateInstance.
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

function asRec(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}
function pick(obj, ...keys) {
  if (!obj) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
}
function arr(obj, ...keys) {
  if (!obj) return [];
  for (const k of keys) {
    const v = obj[k];
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      // sometimes wrapper { X: [...] }
      for (const vv of Object.values(v)) {
        if (Array.isArray(vv)) return vv;
      }
    }
  }
  return [];
}

function normalizeAvailable(body, productType) {
  const out = [];
  const zones = arr(
    asRec(pick(body, 'availableZones', 'AvailableZones')),
    'availableZone',
    'AvailableZone',
  );
  for (const zone of zones) {
    const zoneId = String(pick(zone, 'zoneId', 'ZoneId') || '');
    const engines = arr(
      asRec(pick(zone, 'supportedEngines', 'SupportedEngines')),
      'supportedEngine',
      'SupportedEngine',
    );
    for (const engineNode of engines) {
      const engine = String(pick(engineNode, 'engine', 'Engine') || 'Redis');
      const editions = arr(
        asRec(pick(engineNode, 'supportedEditionTypes', 'SupportedEditionTypes')),
        'supportedEditionType',
        'SupportedEditionType',
      );
      for (const edition of editions) {
        const editionType = String(pick(edition, 'editionType', 'EditionType') || '');
        const seriesList = arr(
          asRec(pick(edition, 'supportedSeriesTypes', 'SupportedSeriesTypes')),
          'supportedSeriesType',
          'SupportedSeriesType',
        );
        for (const series of seriesList) {
          const seriesType = String(pick(series, 'seriesType', 'SeriesType') || '');
          const versions = arr(
            asRec(pick(series, 'supportedEngineVersions', 'SupportedEngineVersions')),
            'supportedEngineVersion',
            'SupportedEngineVersion',
          );
          for (const ver of versions) {
            const engineVersion = String(pick(ver, 'version', 'Version', 'engineVersion', 'EngineVersion') || '');
            const archs = arr(
              asRec(pick(ver, 'supportedArchitectureTypes', 'SupportedArchitectureTypes')),
              'supportedArchitectureType',
              'SupportedArchitectureType',
            );
            for (const arch of archs) {
              const architecture = String(
                pick(arch, 'architecture', 'Architecture', 'architectureType', 'ArchitectureType') || '',
              );
              const shards = arr(
                asRec(pick(arch, 'supportedShardNumbers', 'SupportedShardNumbers')),
                'supportedShardNumber',
                'SupportedShardNumber',
              );
              const shardNodes = shards.length ? shards : [arch];
              for (const shard of shardNodes) {
                const nodeTypes = arr(
                  asRec(pick(shard, 'supportedNodeTypes', 'SupportedNodeTypes')),
                  'supportedNodeType',
                  'SupportedNodeType',
                );
                const nodeList = nodeTypes.length ? nodeTypes : [shard];
                for (const nodeType of nodeList) {
                  const resources = arr(
                    asRec(pick(nodeType, 'availableResources', 'AvailableResources')),
                    'availableResource',
                    'AvailableResource',
                  );
                  for (const res of resources) {
                    const instanceClass = String(
                      pick(res, 'instanceClass', 'InstanceClass') || '',
                    );
                    if (!instanceClass || !engineVersion) continue;
                    const capacity = Number(pick(res, 'capacity', 'Capacity') || 0) || undefined;
                    out.push({
                      engine,
                      engineVersion,
                      instanceClass,
                      architecture: architecture || undefined,
                      storageType: productType || undefined,
                      zoneId: zoneId || undefined,
                      editionType: editionType || undefined,
                      seriesType: seriesType || undefined,
                      capacityMb: capacity,
                      available: true,
                      remark: String(
                        pick(res, 'instanceClassRemark', 'InstanceClassRemark') || '',
                      ).slice(0, 120),
                    });
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return out;
}

const region = 'cn-hangzhou';
const results = {};
for (const productType of ['Local', 'OnECS']) {
  try {
    const response = await kv.describeAvailableResource(
      new Kv.DescribeAvailableResourceRequest({
        regionId: region,
        instanceChargeType: 'PostPaid',
        productType,
        engine: 'Redis',
      }),
    );
    const combos = normalizeAvailable(response.body || {}, productType);
    const small = combos.filter((c) => c.instanceClass === 'redis.master.small.default');
    const master = combos.filter((c) => /^redis\.master\./i.test(c.instanceClass));
    const byClass = {};
    for (const c of combos) {
      byClass[c.instanceClass] ||= new Set();
      byClass[c.instanceClass].add(c.engineVersion);
    }
    results[productType] = {
      comboCount: combos.length,
      masterCount: master.length,
      smallDefault: {
        count: small.length,
        versions: [...new Set(small.map((c) => c.engineVersion))].sort(),
        sample: small.slice(0, 3),
      },
      masterClasses: [...new Set(master.map((c) => c.instanceClass))].sort(),
      masterClassVersions: Object.fromEntries(
        Object.entries(byClass)
          .filter(([k]) => /^redis\.master\./i.test(k))
          .map(([k, v]) => [k, [...v].sort()]),
      ),
      cheapestMaster: master
        .slice()
        .sort((a, b) => (a.capacityMb || 0) - (b.capacityMb || 0))
        .slice(0, 8),
    };
    writeFileSync(
      resolve(root, `.tools/step-254-available-${productType}.json`),
      JSON.stringify({ productType, combos }, null, 2),
    );
  } catch (error) {
    results[productType] = {
      error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
    };
  }
}

console.log(JSON.stringify({ region, results }, null, 2));
await prisma.$disconnect();
