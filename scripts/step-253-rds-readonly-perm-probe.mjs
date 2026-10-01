/**
 * Read-only RDS permission probe for Step 25.3 recovery.
 * Target: pgm-bp14j1lljy571v8h
 * Does NOT create/delete/retry/start worker/modify CloudResource.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const TARGET = 'pgm-bp14j1lljy571v8h';

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

const ACTION_MAP = {
  DescribeDBInstances: 'rds:DescribeDBInstances',
  DescribeDatabases: 'rds:DescribeDatabases',
  DescribeAccounts: 'rds:DescribeAccounts',
  DescribeDBInstanceIPArrayList: 'rds:DescribeDBInstanceIPArrayList',
};

function classify(err) {
  const msg = String(err?.message || err || '');
  const code =
    err?.code ||
    err?.data?.Code ||
    (msg.match(/code:\s*(\d+)/i) || [])[1] ||
    null;
  const requestId =
    err?.data?.RequestId ||
    err?.requestId ||
    (msg.match(/request id:\s*([A-F0-9-]+)/i) || [])[1] ||
    null;
  const is403 =
    String(code) === '403' ||
    /Forbidden|not authorized|NoPermission|AccessDenied/i.test(msg);
  return {
    ok: false,
    is403,
    code: code ? String(code) : null,
    requestId,
    message: msg.slice(0, 300),
  };
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
if (!account?.credentialEncrypted) {
  console.log(JSON.stringify({ ok: false, error: 'no ALIYUN ProviderAccount' }, null, 2));
  process.exit(1);
}
const secrets = JSON.parse(decryptCredential(account.credentialEncrypted));
const config = new openapi.$OpenApiUtil.Config({
  accessKeyId: secrets.accessKey,
  accessKeySecret: secrets.secretKey,
});
config.endpoint = 'rds.aliyuncs.com';
const rds = new rdsPkg.default(config);

const probes = [
  {
    name: 'DescribeDBInstances',
    run: async () => {
      const resp = await rds.describeDBInstances(
        new rdsPkg.DescribeDBInstancesRequest({
          regionId: 'cn-hangzhou',
          engine: 'PostgreSQL',
          DBInstanceId: TARGET,
          pageSize: 10,
          pageNumber: 1,
        }),
      );
      const hit = (resp.body?.items?.DBInstance || []).find(
        (x) => x.DBInstanceId === TARGET,
      );
      return {
        found: Boolean(hit),
        status: hit?.DBInstanceStatus || null,
        description: hit?.DBInstanceDescription || null,
      };
    },
  },
  {
    name: 'DescribeDatabases',
    run: async () => {
      const resp = await rds.describeDatabases(
        new rdsPkg.DescribeDatabasesRequest({
          DBInstanceId: TARGET,
          pageSize: 100,
          pageNumber: 1,
        }),
      );
      const dbs = (resp.body?.databases?.Database || []).map((d) => d.DBName);
      return { databaseCount: dbs.length, databases: dbs };
    },
  },
  {
    name: 'DescribeAccounts',
    run: async () => {
      const resp = await rds.describeAccounts(
        new rdsPkg.DescribeAccountsRequest({
          DBInstanceId: TARGET,
          pageSize: 100,
          pageNumber: 1,
        }),
      );
      const accounts = (resp.body?.accounts?.DBInstanceAccount || []).map((a) => ({
        name: a.AccountName,
        type: a.AccountType,
        status: a.AccountStatus,
      }));
      return { accountCount: accounts.length, accounts };
    },
  },
  {
    name: 'DescribeDBInstanceIPArrayList',
    run: async () => {
      const resp = await rds.describeDBInstanceIPArrayList(
        new rdsPkg.DescribeDBInstanceIPArrayListRequest({
          DBInstanceId: TARGET,
        }),
      );
      const arrays = (resp.body?.items?.DBInstanceIPArray || []).map((x) => {
        const raw = String(x.securityIPList || x.SecurityIPList || '');
        const ips = raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        return {
          name: x.DBInstanceIPArrayName,
          ipCount: ips.length,
          // do not print full IPs
          hasEntries: ips.length > 0,
        };
      });
      return { arrayCount: arrays.length, arrays };
    },
  },
];

const results = [];
for (const probe of probes) {
  try {
    const detail = await probe.run();
    results.push({
      api: probe.name,
      ramAction: ACTION_MAP[probe.name],
      ok: true,
      detail,
    });
  } catch (err) {
    const info = classify(err);
    results.push({
      api: probe.name,
      ramAction: ACTION_MAP[probe.name],
      ...info,
    });
  }
}

const failed = results.filter((r) => !r.ok);
const missingActions = [...new Set(failed.map((r) => r.ramAction))];
const allOk = failed.length === 0;

console.log(
  JSON.stringify(
    {
      target: TARGET,
      allOk,
      missingRamActions: missingActions,
      results,
    },
    null,
    2,
  ),
);

await prisma.$disconnect();
process.exit(allOk ? 0 : 2);
