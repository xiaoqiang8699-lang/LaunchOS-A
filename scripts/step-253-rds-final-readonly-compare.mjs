/**
 * Final read-only compare of two Aliyun RDS instances.
 * Does NOT create / modify / delete / retry / start worker.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
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

const KEEP = 'pgm-bp14j1lljy571v8h';
const ORPHAN = 'pgm-bp189242upo9udy4';
const IDS = [KEEP, ORPHAN];
const CR_ID = 'cmu4110xm0001ric027vr0tc3';
const SYSTEM_DBS = new Set(['postgres', 'template0', 'template1']);
const SYSTEM_ACCTS = new Set([
  'postgres',
  'aurora',
  'replicator',
  'pg_admin',
  'system_info',
  'aliyun_root',
]);

function mask(id) {
  if (!id) return null;
  const s = String(id);
  return s.length <= 10 ? `${s.slice(0, 3)}***` : `${s.slice(0, 8)}***${s.slice(-4)}`;
}

function maskIps(list) {
  if (!list) return null;
  return String(list)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((ip) => {
      if (ip.includes('/')) {
        const [a, p] = ip.split('/');
        const parts = a.split('.');
        if (parts.length === 4) return `${parts[0]}.${parts[1]}.***.***/${p}`;
        return `***${ip.slice(-6)}`;
      }
      const parts = ip.split('.');
      if (parts.length === 4) return `${parts[0]}.${parts[1]}.***.***`;
      return '***';
    });
}

const { PrismaClient } = require(resolve(root, 'packages/database/generated/client'));
const { decryptCredential } = require(resolve(root, 'packages/shared/dist/index.js'));
const requireP = createRequire(resolve(root, 'packages/providers/package.json'));
const rdsPkg = requireP('@alicloud/rds20140815');
const openapi = requireP('@alicloud/openapi-core');
const prisma = new PrismaClient();

const account = await prisma.providerAccount.findFirst({
  where: { status: 'ACTIVE', provider: { type: 'ALIYUN' } },
  orderBy: { createdAt: 'asc' },
});
if (!account?.credentialEncrypted) throw new Error('no ALIYUN account');
const secrets = JSON.parse(decryptCredential(account.credentialEncrypted));
const config = new openapi.$OpenApiUtil.Config({
  accessKeyId: secrets.accessKey,
  accessKeySecret: secrets.secretKey,
});
config.endpoint = 'rds.aliyuncs.com';
const rds = new rdsPkg.default(config);

async function probe(id) {
  const listResp = await rds.describeDBInstances(
    new rdsPkg.DescribeDBInstancesRequest({
      regionId: 'cn-hangzhou',
      engine: 'PostgreSQL',
      DBInstanceId: id,
      pageSize: 10,
      pageNumber: 1,
    }),
  );
  const listed =
    (listResp.body?.items?.DBInstance || []).find((x) => x.DBInstanceId === id) || {};

  const attrResp = await rds.describeDBInstanceAttribute(
    new rdsPkg.DescribeDBInstanceAttributeRequest({ DBInstanceId: id }),
  );
  const a = attrResp.body?.items?.DBInstanceAttribute?.[0] || {};

  let databases = [];
  let databasesError = null;
  try {
    const dbResp = await rds.describeDatabases(
      new rdsPkg.DescribeDatabasesRequest({
        DBInstanceId: id,
        pageSize: 100,
        pageNumber: 1,
      }),
    );
    databases = (dbResp.body?.databases?.Database || []).map((d) => ({
      name: d.DBName,
      status: d.DBStatus,
      characterSetName: d.CharacterSetName,
    }));
  } catch (e) {
    databasesError = String(e?.message || e).slice(0, 240);
  }

  let accounts = [];
  let accountsError = null;
  try {
    const acResp = await rds.describeAccounts(
      new rdsPkg.DescribeAccountsRequest({
        DBInstanceId: id,
        pageSize: 100,
        pageNumber: 1,
      }),
    );
    accounts = (acResp.body?.accounts?.DBInstanceAccount || []).map((x) => ({
      name: x.AccountName,
      type: x.AccountType,
      status: x.AccountStatus,
      privileges: (x.databasePrivileges?.DatabasePrivilege || []).map((p) => ({
        db: p.DBName,
        privilege: p.AccountPrivilege,
      })),
    }));
  } catch (e) {
    accountsError = String(e?.message || e).slice(0, 240);
  }

  let whitelist = [];
  let whitelistError = null;
  try {
    const ipResp = await rds.describeDBInstanceIPArrayList(
      new rdsPkg.DescribeDBInstanceIPArrayListRequest({ DBInstanceId: id }),
    );
    whitelist = (ipResp.body?.items?.DBInstanceIPArray || []).map((x) => {
      const raw = x.securityIPList || x.SecurityIPList || '';
      return {
        name: x.DBInstanceIPArrayName,
        attribute: x.DBInstanceIPArrayAttribute || null,
        ipCount: String(raw)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean).length,
        ipsMasked: maskIps(raw),
      };
    });
  } catch (e) {
    whitelistError = String(e?.message || e).slice(0, 240);
  }

  let network = [];
  let networkError = null;
  try {
    const netResp = await rds.describeDBInstanceNetInfo(
      new rdsPkg.DescribeDBInstanceNetInfoRequest({ DBInstanceId: id }),
    );
    network = (netResp.body?.DBInstanceNetInfos?.DBInstanceNetInfo || []).map((n) => ({
      ipType: n.IPType,
      connectionStringMasked: n.ConnectionString
        ? `${String(n.ConnectionString).slice(0, 14)}***`
        : null,
      port: n.Port || null,
      vpcIdMasked: mask(n.VPCId || n.VpcId),
      vSwitchMasked: mask(n.VSwitchId),
    }));
  } catch (e) {
    networkError = String(e?.message || e).slice(0, 240);
  }

  const userDatabases = databases
    .filter((d) => d.name && !SYSTEM_DBS.has(d.name))
    .map((d) => d.name);
  const userAccounts = accounts
    .filter((x) => x.name && !SYSTEM_ACCTS.has(String(x.name).toLowerCase()))
    .map((x) => ({
      name: x.name,
      type: x.type,
      status: x.status,
      privileges: x.privileges,
    }));

  const createTime =
    listed.createTime ||
    listed.CreateTime ||
    a.createTime ||
    a.CreateTime ||
    a.creationTime ||
    a.CreationTime ||
    null;

  return {
    DBInstanceId: id,
    status: a.DBInstanceStatus || listed.DBInstanceStatus || null,
    createTime,
    engine: a.Engine || listed.engine || listed.Engine || null,
    engineVersion:
      a.EngineVersion || listed.engineVersion || listed.EngineVersion || null,
    region: a.regionId || a.RegionId || listed.regionId || listed.RegionId || null,
    zone: a.zoneId || a.ZoneId || listed.zoneId || listed.ZoneId || null,
    instanceClass: a.DBInstanceClass || listed.DBInstanceClass || null,
    vpcIdMasked: mask(a.vpcId || a.VpcId || listed.vpcId || listed.VpcId),
    vSwitchIdMasked: mask(
      a.vSwitchId || a.VSwitchId || listed.vSwitchId || listed.VSwitchId,
    ),
    description:
      a.DBInstanceDescription || listed.DBInstanceDescription || null,
    payType: a.PayType || listed.PayType || null,
    category: a.Category || listed.Category || null,
    databasesAll: databases.map((d) => d.name),
    userDatabases,
    databasesError,
    accountsAll: accounts.map((x) => ({
      name: x.name,
      type: x.type,
      status: x.status,
      privileges: x.privileges,
    })),
    userAccounts,
    accountsError,
    whitelist,
    whitelistError,
    network,
    networkError,
  };
}

const keep = await probe(KEEP);
const orphan = await probe(ORPHAN);

const target = await prisma.cloudResource.findUnique({
  where: { id: CR_ID },
  select: {
    id: true,
    type: true,
    status: true,
    providerResourceId: true,
    externalId: true,
    metadata: true,
  },
});

const directRefs = await prisma.cloudResource.findMany({
  where: {
    OR: [{ providerResourceId: { in: IDS } }, { externalId: { in: IDS } }],
  },
  select: {
    id: true,
    status: true,
    providerResourceId: true,
    externalId: true,
    type: true,
  },
});

const dc = await prisma.databaseConnection.findMany({
  where: {
    OR: [
      { cloudResourceId: CR_ID },
      { host: { contains: 'bp14j1lljy571v8h' } },
      { host: { contains: 'bp189242upo9udy4' } },
      { host: { contains: 'pgm-bp14' } },
      { host: { contains: 'pgm-bp18' } },
    ],
  },
  select: {
    id: true,
    name: true,
    status: true,
    host: true,
    port: true,
    databaseName: true,
    username: true,
    source: true,
    cloudResourceId: true,
  },
});

const allDbCr = await prisma.cloudResource.findMany({
  where: { type: 'DATABASE' },
  select: {
    id: true,
    status: true,
    providerResourceId: true,
    externalId: true,
    metadata: true,
  },
});
const metadataHits = [];
for (const row of allDbCr) {
  const blob = JSON.stringify(row.metadata || {});
  const mentions = IDS.filter(
    (id) =>
      row.providerResourceId === id ||
      row.externalId === id ||
      blob.includes(id),
  );
  if (mentions.length) {
    metadataHits.push({
      cloudResourceId: row.id,
      status: row.status,
      providerResourceId: row.providerResourceId,
      externalId: row.externalId,
      mentions,
    });
  }
}

const meta =
  target?.metadata && typeof target.metadata === 'object' && !Array.isArray(target.metadata)
    ? target.metadata
    : {};

console.log(
  JSON.stringify(
    {
      keep,
      orphan,
      launchos: {
        targetCloudResource: {
          id: target?.id || null,
          status: target?.status || null,
          providerResourceId: target?.providerResourceId || null,
          externalId: target?.externalId || null,
          resourceKind: meta.resourceKind || null,
          operationId: meta.operationId || null,
          databaseName: meta.databaseName || null,
          username: meta.username || null,
          phase: meta.phase || null,
        },
        cloudResourcesBoundToEitherId: directRefs,
        databaseConnections: dc.map((c) => ({
          id: c.id,
          name: c.name,
          status: c.status,
          hostMasked: c.host ? `${String(c.host).slice(0, 16)}***` : null,
          port: c.port,
          databaseName: c.databaseName,
          username: c.username,
          source: c.source,
          cloudResourceId: c.cloudResourceId,
        })),
        metadataHits,
      },
    },
    null,
    2,
  ),
);

await prisma.$disconnect();
