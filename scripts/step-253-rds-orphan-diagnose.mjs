/**
 * Read-only emergency RDS diagnosis for Step 25.3.
 * Does NOT create/retry/delete/modify any cloud resources.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const CLOUD_RESOURCE_ID = 'cmu4110xm0001ric027vr0tc3';

function loadDotEnv(path) {
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
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
  } catch {
    // optional
  }
}

loadDotEnv(resolve(root, '.env'));

const { PrismaClient } = require(resolve(root, 'packages/database/generated/client'));
const { Queue } = require(resolve(root, 'apps/worker/node_modules/bullmq'));
const {
  getRedisConnection,
  decryptCredential,
  redactSecrets,
  DATABASE_PROVISION_QUEUE,
  databaseProvisionJobId,
} = require(resolve(root, 'packages/shared/dist/index.js'));
const {
  AlibabaCloudDatabaseProvider,
  listRdsInstancesByDescription,
} = require(resolve(root, 'packages/providers/dist/index.js'));

function safe(text) {
  if (text == null) return null;
  return redactSecrets(String(text))
    .replace(/ClientToken=[^&\s]+/gi, 'ClientToken=[REDACTED]')
    .replace(/postgres:\/\/[^:\s]+:[^@\s]+@/gi, 'postgres://[REDACTED]@')
    .slice(0, 800);
}

function maskId(id) {
  if (!id) return null;
  const s = String(id);
  if (s.length <= 8) return `${s.slice(0, 2)}***`;
  return `${s.slice(0, 6)}***${s.slice(-4)}`;
}

const prisma = new PrismaClient();
const queue = new Queue(DATABASE_PROVISION_QUEUE, { connection: getRedisConnection() });

try {
  const resource = await prisma.cloudResource.findUnique({
    where: { id: CLOUD_RESOURCE_ID },
    include: { provider: true },
  });
  if (!resource) {
    console.log('CloudResource not found');
    process.exitCode = 1;
  } else {
    const meta =
      resource.metadata && typeof resource.metadata === 'object' && !Array.isArray(resource.metadata)
        ? resource.metadata
        : {};
    const operationId = meta.operationId || null;
    const clientToken = operationId ? String(operationId).slice(0, 64) : null;

    console.log('\n=== 1. CloudResource ===');
    console.log(
      JSON.stringify(
        {
          cloudResourceId: resource.id,
          status: resource.status,
          phase: meta.phase || null,
          operationId,
          clientToken,
          providerResourceId: resource.providerResourceId,
          createdAt: resource.createdAt,
          updatedAt: resource.updatedAt,
          lastErrorCode: meta.errorCode || null,
          providerErrorCode: meta.providerErrorCode || null,
          providerRequestId: meta.providerRequestId || null,
          lastErrorMessage: safe(meta.errorMessage || meta.technicalMessage),
          retryingAt: meta.retryingAt || null,
          attemptStartedAt: meta.attemptStartedAt || null,
          databaseName: meta.databaseName || null,
          region: resource.region || meta.region || null,
          recentPhases: Array.isArray(meta.phases) ? meta.phases.slice(-12) : [],
        },
        null,
        2,
      ),
    );

    console.log('\n=== 2. BullMQ job ===');
    const jobId = databaseProvisionJobId(CLOUD_RESOURCE_ID);
    const job = await queue.getJob(jobId);
    if (!job) {
      console.log(JSON.stringify({ jobId, found: false }, null, 2));
    } else {
      const state = await job.getState();
      console.log(
        JSON.stringify(
          {
            jobId: job.id,
            state,
            attemptsMade: job.attemptsMade,
            processedOn: job.processedOn ? new Date(job.processedOn).toISOString() : null,
            finishedOn: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
            failedReason: safe(job.failedReason),
            dataOperationId: job.data?.operationId || null,
            expectedClientToken: job.data?.operationId
              ? String(job.data.operationId).slice(0, 64)
              : null,
          },
          null,
          2,
        ),
      );
    }

    const workers = await queue.getWorkers();
    console.log(
      '\n=== 3. Workers ===\n' +
        JSON.stringify(
          {
            liveWorkers: workers.length,
            workers: workers.map((w) => ({ id: w.id, addr: w.addr, age: w.age, name: w.name })),
            counts: await queue.getJobCounts('waiting', 'active', 'failed', 'completed', 'delayed'),
          },
          null,
          2,
        ),
    );

    console.log('\n=== 4. Aliyun RDS (read-only Describe) ===');
    const account = await prisma.providerAccount.findFirst({
      where: {
        workspaceId: resource.workspaceId,
        status: 'ACTIVE',
        provider: { type: 'ALIYUN' },
      },
      include: { provider: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!account?.credentialEncrypted) {
      console.log('No ALIYUN credentials for describe');
    } else {
      const secrets = JSON.parse(decryptCredential(account.credentialEncrypted));
      const region = resource.region || meta.region || 'cn-hangzhou';
      const provider = new AlibabaCloudDatabaseProvider({
        accessKey: secrets.accessKey,
        secretKey: secrets.secretKey,
        region,
      });

      // Broad list via provider helper + attribute for bound id
      let listed = [];
      try {
        listed = await listRdsInstancesByDescription(
          provider,
          region,
          `launchos-${meta.databaseName || 'launchos'}`.slice(0, 40),
        );
      } catch (err) {
        console.log('listByDescription failed:', safe(err instanceof Error ? err.message : err));
      }

      const requireFromProviders = createRequire(
        resolve(root, 'packages/providers/package.json'),
      );
      const rdsPkg = requireFromProviders('@alicloud/rds20140815');
      const { $OpenApiUtil } = requireFromProviders('@alicloud/openapi-core');
      const config = new $OpenApiUtil.Config({
        accessKeyId: secrets.accessKey,
        accessKeySecret: secrets.secretKey,
      });
      config.endpoint = 'rds.aliyuncs.com';
      const rds = new rdsPkg.default(config);
      const resp = await rds.describeDBInstances(
        new rdsPkg.DescribeDBInstancesRequest({
          regionId: region,
          engine: 'PostgreSQL',
          pageSize: 30,
          pageNumber: 1,
        }),
      );
      const items = resp.body?.items?.DBInstance || [];
      const mapped = items.map((item) => ({
        DBInstanceId: item.DBInstanceId,
        status: item.DBInstanceStatus,
        region: item.RegionId,
        zone: item.ZoneId,
        createTime: item.CreateTime,
        description: item.DBInstanceDescription,
        engine: item.Engine,
        engineVersion: item.EngineVersion,
        vpcIdMasked: maskId(item.VpcId),
        category: item.Category,
        payType: item.PayType,
      }));
      // Sort by createTime desc
      mapped.sort((a, b) => String(b.createTime || '').localeCompare(String(a.createTime || '')));
      console.log(JSON.stringify({ region, count: mapped.length, instances: mapped.slice(0, 10) }, null, 2));

      if (resource.providerResourceId) {
        try {
          const st = await provider.getInstanceStatus(resource.providerResourceId);
          console.log(
            '\nBound providerResourceId status:',
            JSON.stringify(
              {
                providerResourceId: resource.providerResourceId,
                status: st.rawStatus || st.status,
              },
              null,
              2,
            ),
          );
        } catch (err) {
          console.log('bound describe failed:', safe(err instanceof Error ? err.message : err));
        }
      }

      // Correlate
      const expectedDescPrefix = `launchos-${meta.databaseName || ''}`.slice(0, 64);
      const byDesc = mapped.filter(
        (i) =>
          i.description &&
          (i.description.includes('launchos') ||
            (meta.databaseName && i.description.includes(String(meta.databaseName)))),
      );
      const byBound = mapped.find((i) => i.DBInstanceId === resource.providerResourceId) || null;
      console.log('\n=== 5. Correlation ===');
      console.log(
        JSON.stringify(
          {
            expectedDescriptionPrefix: expectedDescPrefix,
            boundMatch: byBound,
            launchosNamed: byDesc,
            listedHelper: Array.isArray(listed) ? listed.slice?.(0, 10) || listed : listed,
          },
          null,
          2,
        ),
      );
    }
  }
} finally {
  await prisma.$disconnect().catch(() => undefined);
  await queue.close().catch(() => undefined);
}
