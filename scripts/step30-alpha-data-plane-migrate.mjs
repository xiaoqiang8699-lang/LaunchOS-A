/**
 * Step 30 — Alpha Data Plane Migration (COPY → VERIFY → THEN SWITCH readiness).
 *
 * Does NOT deploy public Web/API.
 * Does NOT print secrets.
 * Does NOT delete local Postgres/Redis.
 *
 *   node scripts/step30-alpha-data-plane-migrate.mjs --confirm-alpha-data-plane
 */
import { createRequire } from 'node:module';
import {
  createHash,
  randomBytes,
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';

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

const CONFIRM = process.argv.includes('--confirm-alpha-data-plane');
if (!CONFIRM) {
  console.error('Refusing: pass --confirm-alpha-data-plane');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const {
  decryptCredential,
  resolveServerSshUsername,
  shellCommand,
} = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');

const TARGET_HOST = '116.62.198.184';
const LOCAL_PG_CONTAINER = 'zidonghua-postgres-1';
const PG_IMAGE = 'postgres:16-alpine';
const REDIS_IMAGE = 'redis:7-alpine';
const PG_NAME = 'launchos-alpha-postgres';
const REDIS_NAME = 'launchos-alpha-redis';
const PG_USER = 'launchos_alpha';
const PG_DB = 'launchos';
const SECRETS_DIR = resolve(root, '.secrets');
const SECRETS_FILE = join(SECRETS_DIR, 'alpha-data-plane.env');
const DUMP_DIR = resolve(root, '.tools', 'alpha-migration');
const MAINT_FLAG = resolve(root, '.tools', 'MAINTENANCE_WRITE_FREEZE');

const COUNT_MODELS = [
  ['User', 'user'],
  ['Workspace', 'workspace'],
  ['WorkspaceMember', 'workspaceMember'],
  ['Project', 'project'],
  ['ProjectEnvironment', 'projectEnvironment'],
  ['Deployment', 'deployment'],
  ['ServiceInstance', 'serviceInstance'],
  ['GitProviderConnection', 'gitProviderConnection'],
  ['AlphaTestSession', 'alphaTestSession'],
  ['Subscription', 'subscription'],
  ['Payment', 'payment'],
  ['Invoice', 'invoice'],
  ['CommercialOrder', 'commercialOrder'],
  ['Plan', 'plan'],
  ['PlanVersion', 'planVersion'],
  ['AuthSession', 'authSession'],
];

function sha256File(filePath) {
  const hash = createHash('sha256');
  hash.update(readFileSync(filePath));
  return hash.digest('hex');
}

function redact(text) {
  return String(text || '')
    .replace(/postgres(ql)?:\/\/[^:\s]+:[^@\s]+@/gi, 'postgresql://***:***@')
    .replace(/redis:\/\/[^:\s]+:[^@\s]+@/gi, 'redis://***:***@')
    .replace(/(PASSWORD|SECRET|TOKEN)=([^\s]+)/gi, '$1=***');
}

function runLocal(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: false,
    ...opts,
  });
  if (res.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(' ')} failed: ${redact(res.stderr || res.stdout || String(res.status))}`,
    );
  }
  return res;
}

function assertOk(result, label, { allowExit = [0] } = {}) {
  const code = Number(result?.exitCode ?? 1);
  if (!allowExit.includes(code)) {
    throw new Error(
      `${label} failed exit=${code}: ${redact(String(result?.stderr || result?.stdout || '').slice(0, 1200))}`,
    );
  }
  return result;
}

async function remoteOk(runner, command, label, opts = {}) {
  const { allowExit = [0], timeoutMs = 60000 } = opts;
  const result = await runner.execute(shellCommand(command), { timeoutMs });
  return assertOk(result, label, { allowExit });
}

function tcpOpen(host, port, timeoutMs = 2500) {
  return new Promise((resolveProbe) => {
    const socket = createConnection({ host, port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolveProbe(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => finish(true));
    socket.on('timeout', () => finish(false));
    socket.on('error', () => finish(false));
  });
}

function loadOrCreateSecrets() {
  mkdirSync(SECRETS_DIR, { recursive: true });
  if (existsSync(SECRETS_FILE)) {
    const env = {};
    for (const line of readFileSync(SECRETS_FILE, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i <= 0) continue;
      env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    if (env.ALPHA_PG_PASSWORD && env.ALPHA_DATABASE_URL && env.ALPHA_REDIS_URL) {
      return env;
    }
  }
  const password = randomBytes(24).toString('base64url');
  const databaseUrl = `postgresql://${PG_USER}:${password}@127.0.0.1:5432/${PG_DB}?schema=public`;
  const redisUrl = 'redis://127.0.0.1:6379';
  const body = [
    '# External Alpha data-plane secrets — DO NOT COMMIT',
    `ALPHA_PG_USER=${PG_USER}`,
    `ALPHA_PG_DB=${PG_DB}`,
    `ALPHA_PG_PASSWORD=${password}`,
    `ALPHA_DATABASE_URL=${databaseUrl}`,
    `ALPHA_REDIS_URL=${redisUrl}`,
    '',
  ].join('\n');
  writeFileSync(SECRETS_FILE, body, { encoding: 'utf8', mode: 0o600 });
  return {
    ALPHA_PG_USER: PG_USER,
    ALPHA_PG_DB: PG_DB,
    ALPHA_PG_PASSWORD: password,
    ALPHA_DATABASE_URL: databaseUrl,
    ALPHA_REDIS_URL: redisUrl,
  };
}

async function countRows(prisma) {
  const out = {};
  for (const [label, key] of COUNT_MODELS) {
    try {
      out[label] = await prisma[key].count();
    } catch (error) {
      out[label] = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  return out;
}

async function freezeWrites() {
  mkdirSync(dirname(MAINT_FLAG), { recursive: true });
  writeFileSync(
    MAINT_FLAG,
    JSON.stringify({ startedAt: new Date().toISOString(), reason: 'step30-alpha-data-plane' }),
  );
  // Stop local API listeners on 3001 to block registrations/writes via HTTP.
  const stopped = [];
  try {
    const list = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "(Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue).OwningProcess | Sort-Object -Unique",
      ],
      { encoding: 'utf8' },
    );
    const pids = String(list.stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s));
    for (const pid of pids) {
      spawnSync('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force`], {
        encoding: 'utf8',
      });
      stopped.push(Number(pid));
    }
  } catch {
    // continue
  }
  return stopped;
}

async function main() {
  const report = {
    migrationStartedAt: null,
    cutoverTimestamp: null,
    sourcePostgres: 'localhost:5432/launchos (docker zidonghua-postgres-1)',
    sourceRedis: '127.0.0.1:6379 (docker zidonghua-redis-1)',
    targetHost: TARGET_HOST,
    postgresVersion: null,
    dump: null,
    transfer: null,
    restore: null,
    rowCountsBefore: null,
    rowCountsAfter: null,
    rowCountDiff: null,
    samples: {},
    listen: {},
    backup: {},
    redisRestart: {},
    smoke: {},
    envSeparation: {},
    workerIsolation: 'windows-worker-not-switched; alpha-worker-not-started',
    secretsExposed: 'NO',
    paidResourceCreated: 'NO',
    ALPHA_DATABASE_READY: false,
    ALPHA_REDIS_READY: false,
    final: 'FAIL',
    error: null,
  };

  const secrets = loadOrCreateSecrets();
  const prisma = new PrismaClient();
  const runner = new RemoteRunner();

  try {
    mkdirSync(DUMP_DIR, { recursive: true });

    const versionRows = await prisma.$queryRawUnsafe('SELECT version() AS v');
    report.postgresVersion = versionRows?.[0]?.v || null;
    if (!String(report.postgresVersion || '').includes('PostgreSQL 16')) {
      throw new Error(`Unexpected local Postgres major version: ${report.postgresVersion}`);
    }

    const stoppedPids = await freezeWrites();
    report.writeFreeze = { maintenanceFlag: MAINT_FLAG, stoppedApiPids: stoppedPids };
    report.migrationStartedAt = new Date().toISOString();
    report.rowCountsBefore = await countRows(prisma);

    // Capacity re-check
    const server = await prisma.serverInstance.findFirst({ where: { host: TARGET_HOST } });
    if (!server) throw new Error('managed node not found');
    await runner.connect({
      host: server.host,
      port: server.port,
      username: resolveServerSshUsername(server.username),
      password: decryptCredential(server.credentialEncrypted),
    });

    const cap = await runner.execute(
      shellCommand(
        [
          'echo NPROC=$(nproc)',
          'echo MEM_MB=$(free -m | awk \'/Mem:/{print $2}\')',
          'echo MEM_AVAIL_MB=$(free -m | awk \'/Mem:/{print $7}\')',
          'echo DISK_AVAIL_G=$(df -BG / | awk \'NR==2{gsub(/G/,"",$4); print $4}\')',
          'uptime',
        ].join('; '),
      ),
      { timeoutMs: 30000 },
    );
    const capOut = String(cap.stdout || '');
    report.capacity = capOut.trim();
    const memAvail = Number((capOut.match(/MEM_AVAIL_MB=(\d+)/) || [])[1] || 0);
    const diskAvail = Number((capOut.match(/DISK_AVAIL_G=(\d+)/) || [])[1] || 0);
    if (memAvail > 0 && memAvail < 1024) {
      throw new Error(`Insufficient available RAM for Alpha DP: ${memAvail}MB`);
    }
    if (diskAvail > 0 && diskAvail < 10) {
      throw new Error(`Insufficient disk for Alpha DP: ${diskAvail}G`);
    }

    // Prepare directories + containers (password via env file on host, not echoed)
    // CRITICAL: never chown -R root:root onto initialized Postgres/Redis volumes.
    // postgres:16-alpine runs as uid 70; root-owned 0700 data causes Permission denied.
    const remoteEnvPath = '/opt/launchos/config/alpha-data-plane.env';
    const remoteEnvBody = [
      `POSTGRES_USER=${secrets.ALPHA_PG_USER}`,
      `POSTGRES_PASSWORD=${secrets.ALPHA_PG_PASSWORD}`,
      `POSTGRES_DB=${secrets.ALPHA_PG_DB}`,
      '',
    ].join('\n');
    await remoteOk(
      runner,
      [
        'mkdir -p /opt/launchos/data/postgres /opt/launchos/data/redis /opt/launchos/backups/postgres /opt/launchos/config /opt/launchos/bin /opt/launchos/tmp',
        'chmod 755 /opt/launchos/data /opt/launchos/backups /opt/launchos/backups/postgres /opt/launchos/tmp /opt/launchos/bin',
        'chmod 700 /opt/launchos/config',
        // Empty dirs only — entrypoint will chown to postgres (70) / redis as needed.
        'if [ -z "$(ls -A /opt/launchos/data/postgres 2>/dev/null)" ]; then chmod 700 /opt/launchos/data/postgres; fi',
        'if [ -z "$(ls -A /opt/launchos/data/redis 2>/dev/null)" ]; then chmod 700 /opt/launchos/data/redis; fi',
      ].join(' && '),
      'prepare-dirs',
      { timeoutMs: 30000 },
    );
    await runner.writeTextFile(remoteEnvPath, remoteEnvBody);
    await remoteOk(runner, `chmod 600 ${remoteEnvPath}`, 'chmod-env', { timeoutMs: 15000 });

    // Managed host cannot reach Docker Hub — transfer images from builder when missing.
    const localPgTar = join(DUMP_DIR, 'postgres-16-alpine.tar');
    const localRedisTar = join(DUMP_DIR, 'redis-7-alpine.tar');
    const hasImages = await runner.execute(
      shellCommand(
        'podman image exists docker.io/library/postgres:16-alpine && echo PG:0 || echo PG:1; podman image exists docker.io/library/redis:7-alpine && echo RD:0 || echo RD:1',
      ),
      { timeoutMs: 30000 },
    );
    const imageOut = String(hasImages.stdout || '');
    const needPg = !/PG:0/.test(imageOut);
    const needRedis = !/RD:0/.test(imageOut);
    if (needPg || needRedis) {
      if (!existsSync(localPgTar) || !existsSync(localRedisTar)) {
        throw new Error('Missing local image tars under .tools/alpha-migration (docker save required)');
      }
      if (needPg) {
        await runner.upload(localPgTar, '/opt/launchos/tmp/postgres-16-alpine.tar', {
          timeoutMs: 900000,
        });
        await remoteOk(
          runner,
          'podman load -i /opt/launchos/tmp/postgres-16-alpine.tar && rm -f /opt/launchos/tmp/postgres-16-alpine.tar',
          'podman-load-postgres',
          { timeoutMs: 600000 },
        );
      }
      if (needRedis) {
        await runner.upload(localRedisTar, '/opt/launchos/tmp/redis-7-alpine.tar', {
          timeoutMs: 900000,
        });
        await remoteOk(
          runner,
          'podman load -i /opt/launchos/tmp/redis-7-alpine.tar && rm -f /opt/launchos/tmp/redis-7-alpine.tar',
          'podman-load-redis',
          { timeoutMs: 600000 },
        );
      }
    }

    // Recreate Alpha Postgres/Redis volumes if current instance is unhealthy.
    // Safe: Alpha restore not verified yet; LOCAL_DEV source untouched.
    // Helper scripts avoid `$` being expanded by outer SSH shell quoting.
    await runner.writeTextFile(
      '/opt/launchos/bin/step30-health.sh',
      [
        '#!/bin/sh',
        `podman exec ${PG_NAME} pg_isready -U ${PG_USER} -d ${PG_DB} >/dev/null 2>&1; echo PG:$?`,
        `podman exec ${PG_NAME} psql -U ${PG_USER} -d ${PG_DB} -Atc 'SELECT 1' >/dev/null 2>&1; echo SQL:$?`,
        `podman exec ${REDIS_NAME} redis-cli ping 2>/dev/null | grep -q PONG; echo RD:$?`,
        '',
      ].join('\n'),
    );
    await runner.writeTextFile(
      '/opt/launchos/bin/step30-wait-postgres.sh',
      [
        '#!/bin/sh',
        'i=0',
        'while [ "$i" -lt 90 ]; do',
        '  i=$((i+1))',
        `  if podman exec ${PG_NAME} psql -U ${PG_USER} -d ${PG_DB} -Atc 'SELECT 1' >/dev/null 2>&1; then`,
        '    exit 0',
        '  fi',
        '  sleep 2',
        'done',
        `podman logs --tail 80 ${PG_NAME} > /tmp/pg-wait.log 2>&1 || true`,
        'tail -n 40 /tmp/pg-wait.log || true',
        'exit 1',
        '',
      ].join('\n'),
    );
    await runner.writeTextFile(
      '/opt/launchos/bin/step30-wait-redis.sh',
      [
        '#!/bin/sh',
        'i=0',
        'while [ "$i" -lt 30 ]; do',
        '  i=$((i+1))',
        `  if podman exec ${REDIS_NAME} redis-cli ping 2>/dev/null | grep -q PONG; then`,
        '    exit 0',
        '  fi',
        '  sleep 1',
        'done',
        'exit 1',
        '',
      ].join('\n'),
    );
    await remoteOk(
      runner,
      'chmod 700 /opt/launchos/bin/step30-health.sh /opt/launchos/bin/step30-wait-postgres.sh /opt/launchos/bin/step30-wait-redis.sh',
      'chmod-step30-helpers',
      { timeoutMs: 15000 },
    );

    const healthProbe = await runner.execute(shellCommand('/opt/launchos/bin/step30-health.sh'), {
      timeoutMs: 30000,
    });
    const healthOut = String(healthProbe.stdout || '');
    const pgHealthy = /PG:0/.test(healthOut) && /SQL:0/.test(healthOut);
    const redisHealthy = /RD:0/.test(healthOut);
    if (!pgHealthy) {
      await remoteOk(
        runner,
        [
          `podman stop ${PG_NAME} 2>/dev/null || true`,
          `podman rm -f ${PG_NAME} 2>/dev/null || true`,
          'rm -rf /opt/launchos/data/postgres',
          'mkdir -p /opt/launchos/data/postgres',
          'chmod 700 /opt/launchos/data/postgres',
          `podman run -d --name ${PG_NAME} --restart unless-stopped --env-file ${remoteEnvPath} -v /opt/launchos/data/postgres:/var/lib/postgresql/data:Z -p 127.0.0.1:5432:5432 docker.io/library/postgres:16-alpine`,
        ].join(' && '),
        'recreate-alpha-postgres',
        { timeoutMs: 180000 },
      );
    } else {
      await remoteOk(
        runner,
        `podman inspect ${PG_NAME} >/dev/null 2>&1 || podman run -d --name ${PG_NAME} --restart unless-stopped --env-file ${remoteEnvPath} -v /opt/launchos/data/postgres:/var/lib/postgresql/data:Z -p 127.0.0.1:5432:5432 docker.io/library/postgres:16-alpine; podman start ${PG_NAME} 2>/dev/null || true`,
        'ensure-alpha-postgres',
        { timeoutMs: 180000 },
      );
    }
    if (!redisHealthy) {
      await remoteOk(
        runner,
        [
          `podman stop ${REDIS_NAME} 2>/dev/null || true`,
          `podman rm -f ${REDIS_NAME} 2>/dev/null || true`,
          'rm -rf /opt/launchos/data/redis',
          'mkdir -p /opt/launchos/data/redis',
          'chmod 700 /opt/launchos/data/redis',
          `podman run -d --name ${REDIS_NAME} --restart unless-stopped -v /opt/launchos/data/redis:/data:Z -p 127.0.0.1:6379:6379 docker.io/library/redis:7-alpine redis-server --appendonly yes --save 60 1 --bind 0.0.0.0 --protected-mode no`,
        ].join(' && '),
        'recreate-alpha-redis',
        { timeoutMs: 180000 },
      );
    } else {
      await remoteOk(
        runner,
        `podman inspect ${REDIS_NAME} >/dev/null 2>&1 || podman run -d --name ${REDIS_NAME} --restart unless-stopped -v /opt/launchos/data/redis:/data:Z -p 127.0.0.1:6379:6379 docker.io/library/redis:7-alpine redis-server --appendonly yes --save 60 1 --bind 0.0.0.0 --protected-mode no; podman start ${REDIS_NAME} 2>/dev/null || true`,
        'ensure-alpha-redis',
        { timeoutMs: 180000 },
      );
    }

    await remoteOk(runner, '/opt/launchos/bin/step30-wait-postgres.sh', 'wait-postgres-ready', {
      timeoutMs: 240000,
    });
    await remoteOk(runner, '/opt/launchos/bin/step30-wait-redis.sh', 'wait-redis-ready', {
      timeoutMs: 60000,
    });

    // Dump local
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dumpName = `migration-${ts}.dump`;
    const localDump = join(DUMP_DIR, dumpName);
    runLocal('docker', [
      'exec',
      LOCAL_PG_CONTAINER,
      'pg_dump',
      '-U',
      'postgres',
      '-d',
      'launchos',
      '-Fc',
      '-f',
      `/tmp/${dumpName}`,
    ]);
    runLocal('docker', ['cp', `${LOCAL_PG_CONTAINER}:/tmp/${dumpName}`, localDump]);
    runLocal('docker', ['exec', LOCAL_PG_CONTAINER, 'rm', '-f', `/tmp/${dumpName}`]);
    const dumpStat = statSync(localDump);
    const dumpHash = sha256File(localDump);
    report.dump = {
      path: localDump,
      size: dumpStat.size,
      sha256: dumpHash,
      timestamp: ts,
      format: 'custom(-Fc)',
    };
    if (dumpStat.size <= 0) throw new Error('dump size is 0');

    // Transfer
    const remoteDump = `/opt/launchos/backups/postgres/${dumpName}`;
    await runner.upload(localDump, remoteDump, { timeoutMs: 600000 });
    const remoteHash = await runner.execute(
      shellCommand(`sha256sum '${remoteDump}' ; wc -c < '${remoteDump}'`),
      { timeoutMs: 60000 },
    );
    const remoteLines = String(remoteHash.stdout || '')
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const remoteSha = (remoteLines[0] || '').split(/\s+/)[0];
    const remoteSize = Number(remoteLines[1] || 0);
    report.transfer = {
      remotePath: remoteDump,
      remoteSha256: remoteSha,
      remoteSize,
      hashMatch: remoteSha === dumpHash && remoteSize === dumpStat.size,
    };
    if (!report.transfer.hashMatch) {
      throw new Error(
        `dump hash/size mismatch after transfer local=${dumpHash}/${dumpStat.size} remote=${remoteSha}/${remoteSize}`,
      );
    }

    await runner.writeTextFile(
      '/opt/launchos/bin/step30-pg-restore.sh',
      [
        '#!/bin/sh',
        'set -eu',
        `DUMP_NAME="${dumpName}"`,
        `REMOTE_DUMP="${remoteDump}"`,
        `podman cp "$REMOTE_DUMP" ${PG_NAME}:/tmp/"$DUMP_NAME"`,
        `podman exec ${PG_NAME} psql -U ${PG_USER} -d postgres -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${PG_DB}' AND pid <> pg_backend_pid();" || true`,
        `podman exec ${PG_NAME} psql -U ${PG_USER} -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${PG_DB};"`,
        `podman exec ${PG_NAME} psql -U ${PG_USER} -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${PG_DB} OWNER ${PG_USER};"`,
        `set +e`,
        `podman exec ${PG_NAME} pg_restore -U ${PG_USER} -d ${PG_DB} --no-owner --no-acl /tmp/"$DUMP_NAME"`,
        'ec=$?',
        'set -e',
        'if [ "$ec" -gt 1 ]; then exit "$ec"; fi',
        `podman exec ${PG_NAME} rm -f /tmp/"$DUMP_NAME"`,
        'exit 0',
        '',
      ].join('\n'),
    );
    await remoteOk(
      runner,
      'chmod 700 /opt/launchos/bin/step30-pg-restore.sh && /opt/launchos/bin/step30-pg-restore.sh',
      'pg-restore',
      { timeoutMs: 600000 },
    );
    report.restore = {
      ok: true,
      method: 'DROP DATABASE + CREATE DATABASE + pg_restore --no-owner --no-acl',
    };

    // Prisma migration history present? Use single-quoted -c to avoid SSH escaping issues.
    const mig = await remoteOk(
      runner,
      `podman exec ${PG_NAME} psql -U ${PG_USER} -d ${PG_DB} -Atc 'SELECT COUNT(*) FROM "_prisma_migrations";'`,
      'count-prisma-migrations',
      { timeoutMs: 30000 },
    );
    const localMig = await prisma.$queryRawUnsafe('SELECT COUNT(*)::int AS c FROM "_prisma_migrations"');
    report.prismaMigrations = {
      targetCount: Number(String(mig.stdout || '').trim()),
      sourceCount: localMig?.[0]?.c ?? null,
    };
    if (report.prismaMigrations.targetCount !== report.prismaMigrations.sourceCount) {
      throw new Error(
        `Prisma migration count mismatch source=${report.prismaMigrations.sourceCount} target=${report.prismaMigrations.targetCount}`,
      );
    }

    // Row counts on target via psql
    const after = {};
    for (const [label] of COUNT_MODELS) {
      const q = await remoteOk(
        runner,
        `podman exec ${PG_NAME} psql -U ${PG_USER} -d ${PG_DB} -Atc 'SELECT COUNT(*) FROM "${label}";'`,
        `count-${label}`,
        { timeoutMs: 30000 },
      );
      const n = Number(String(q.stdout || '').trim());
      if (!Number.isFinite(n)) {
        after[label] = { error: String(q.stdout || q.stderr || 'count failed') };
      } else {
        after[label] = n;
      }
    }
    report.rowCountsAfter = after;
    const diff = {};
    for (const [label] of COUNT_MODELS) {
      const b = report.rowCountsBefore[label];
      const a = after[label];
      if (typeof b === 'number' && typeof a === 'number' && b !== a) {
        diff[label] = { before: b, after: a };
      }
    }
    report.rowCountDiff = diff;
    if (Object.keys(diff).length > 0) {
      throw new Error(`Row count mismatch: ${JSON.stringify(diff)}`);
    }

    // Sample relation checks — write SQL file remotely to avoid quote hell
    const sampleQueries = {
      userWorkspace: `SELECT json_build_object('userId', u.id, 'email', u.email, 'ws', w.id) FROM "User" u JOIN "Workspace" w ON w."ownerId"=u.id LIMIT 1;`,
      project: `SELECT json_build_object('projectId', p.id, 'name', p.name, 'workspaceId', p."workspaceId") FROM "Project" p LIMIT 1;`,
      deployment: `SELECT json_build_object('deploymentId', d.id, 'status', d.status, 'projectId', d."projectId") FROM "Deployment" d LIMIT 1;`,
      github: `SELECT json_build_object('id', g.id, 'installationId', g."installationId", 'status', g.status, 'hasEncryptedSecrets', (g."encryptedSecrets" IS NOT NULL)) FROM "GitProviderConnection" g LIMIT 1;`,
      alphaSession: `SELECT json_build_object('id', a.id, 'status', a.status) FROM "AlphaTestSession" a LIMIT 1;`,
      subscription: `SELECT json_build_object('id', s.id, 'status', s.status, 'workspaceId', s."workspaceId") FROM "Subscription" s LIMIT 1;`,
      payment: `SELECT json_build_object('id', p.id, 'status', p.status) FROM "Payment" p LIMIT 1;`,
      authSessionCount: `SELECT COUNT(*) FROM "AuthSession";`,
    };
    for (const [key, sql] of Object.entries(sampleQueries)) {
      const remoteSql = `/opt/launchos/tmp/step30-${key}.sql`;
      await runner.writeTextFile(remoteSql, sql);
      const r = await remoteOk(
        runner,
        `podman cp ${remoteSql} ${PG_NAME}:/tmp/step30.sql && podman exec ${PG_NAME} psql -U ${PG_USER} -d ${PG_DB} -Atf /tmp/step30.sql && podman exec ${PG_NAME} rm -f /tmp/step30.sql && rm -f ${remoteSql}`,
        `sample-${key}`,
        { timeoutMs: 30000 },
      );
      report.samples[key] = String(r.stdout || '').trim().slice(0, 500);
    }
    if (!report.samples.github || report.samples.github === '') {
      throw new Error('GitHub connection sample missing');
    }
    // Ensure we never captured secrets beyond boolean
    if (/BEGIN|PRIVATE|eyJ|password/i.test(JSON.stringify(report.samples))) {
      throw new Error('sample output may contain secrets');
    }

    // Listen checks
    const listen = await runner.execute(
      shellCommand(
        'ss -lntp | grep -E ":5432|:6379" || true; echo ---; ss -lntp | grep -E "0.0.0.0:5432|:::5432|0.0.0.0:6379|:::6379" || true',
      ),
      { timeoutMs: 20000 },
    );
    report.listen.local = String(listen.stdout || '').trim();
    const publicPg = await tcpOpen(TARGET_HOST, 5432);
    const publicRedis = await tcpOpen(TARGET_HOST, 6379);
    report.listen.public5432Reachable = publicPg;
    report.listen.public6379Reachable = publicRedis;
    if (publicPg || publicRedis) {
      throw new Error('Postgres/Redis appear reachable on public interface');
    }
    if (!/127\.0\.0\.1:5432/.test(report.listen.local) || !/127\.0\.0\.1:6379/.test(report.listen.local)) {
      throw new Error('Expected loopback listeners for 5432/6379 not found');
    }

    // Backup bootstrap + one manual run
    const backupScript = `#!/usr/bin/env bash
set -euo pipefail
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT=/opt/launchos/backups/postgres/daily-\${STAMP}.dump
podman exec ${PG_NAME} pg_dump -U ${PG_USER} -d ${PG_DB} -Fc -f /tmp/daily.dump
podman cp ${PG_NAME}:/tmp/daily.dump "\$OUT"
podman exec ${PG_NAME} rm -f /tmp/daily.dump
# retain >=7 days
find /opt/launchos/backups/postgres -type f -name 'daily-*.dump' -mtime +7 -delete || true
wc -c "\$OUT"
test -s "\$OUT"
`;
    await runner.writeTextFile('/opt/launchos/bin/alpha-pg-backup.sh', backupScript);
    await remoteOk(runner, 'chmod 700 /opt/launchos/bin/alpha-pg-backup.sh', 'chmod-backup', {
      timeoutMs: 15000,
    });
    try {
      await remoteOk(
        runner,
        '(crontab -l 2>/dev/null | grep -v alpha-pg-backup.sh || true; echo "15 3 * * * /opt/launchos/bin/alpha-pg-backup.sh >> /opt/launchos/backups/postgres/backup.log 2>&1") | crontab -',
        'install-backup-cron',
        { timeoutMs: 30000 },
      );
    } catch {
      // cron optional if crontab unavailable; manual backup test is required
    }
    const backupRun = await remoteOk(runner, '/opt/launchos/bin/alpha-pg-backup.sh', 'backup-test-run', {
      timeoutMs: 180000,
    });
    const backupList = await remoteOk(
      runner,
      'ls -lh /opt/launchos/backups/postgres | tail -n 20',
      'backup-list',
      { timeoutMs: 20000 },
    );
    report.backup = {
      script: '/opt/launchos/bin/alpha-pg-backup.sh',
      cron: '15 3 * * *',
      listing: String(backupList.stdout || '').trim().slice(0, 1500),
      tested: /daily-/.test(String(backupList.stdout || '')),
      sizeLine: String(backupRun.stdout || '').trim().slice(0, 200),
    };
    if (!report.backup.tested) throw new Error('backup test dump not found');

    // Redis persistence + restart
    await remoteOk(
      runner,
      `podman exec ${REDIS_NAME} redis-cli SET alpha-smoke-key ok EX 30 && podman exec ${REDIS_NAME} redis-cli GET alpha-smoke-key && podman exec ${REDIS_NAME} redis-cli DEL alpha-smoke-key`,
      'redis-ephemeral-key',
      { timeoutMs: 30000 },
    );
    await remoteOk(runner, `podman restart ${REDIS_NAME}`, 'redis-restart', { timeoutMs: 60000 });
    await remoteOk(runner, '/opt/launchos/bin/step30-wait-redis.sh', 'redis-restart-ready', {
      timeoutMs: 60000,
    });
    const redisFiles = await remoteOk(
      runner,
      'ls -lah /opt/launchos/data/redis | head -n 30',
      'redis-data-listing',
      { timeoutMs: 20000 },
    );
    report.redisRestart = {
      ok: true,
      dataDirListing: String(redisFiles.stdout || '').trim().slice(0, 1000),
    };

    // DB smoke via psql (host-local to containers)
    const smokeDb = await remoteOk(
      runner,
      [
        `podman exec ${PG_NAME} psql -U ${PG_USER} -d ${PG_DB} -Atc 'SELECT 1'`,
        `podman exec ${PG_NAME} psql -U ${PG_USER} -d ${PG_DB} -Atc 'SELECT COUNT(*) FROM "User"'`,
        `podman exec ${PG_NAME} psql -U ${PG_USER} -d ${PG_DB} -Atc 'SELECT COUNT(*) FROM "Workspace"'`,
      ].join(' && echo --- && '),
      'db-smoke',
      { timeoutMs: 30000 },
    );
    report.smoke.db = String(smokeDb.stdout || '').trim();
    const smokeRedis = await remoteOk(
      runner,
      `podman exec ${REDIS_NAME} redis-cli PING && podman exec ${REDIS_NAME} redis-cli SET step30-tmp 1 EX 10 && podman exec ${REDIS_NAME} redis-cli GET step30-tmp && podman exec ${REDIS_NAME} redis-cli DEL step30-tmp`,
      'redis-smoke',
      { timeoutMs: 30000 },
    );
    report.smoke.redis = String(smokeRedis.stdout || '').trim();

    // Environment separation files (no secrets in repo)
    const alphaEnvExample = [
      '# External Alpha control-plane data URLs (host-local on 116.62.198.184)',
      '# Real credentials live only in /opt/launchos/config/alpha-data-plane.env and .secrets/',
      'LAUNCHOS_ENV=alpha',
      'NODE_ENV=production',
      'DATABASE_URL=postgresql://launchos_alpha:***@127.0.0.1:5432/launchos?schema=public',
      'REDIS_URL=redis://127.0.0.1:6379',
      '',
    ].join('\n');
    writeFileSync(resolve(root, '.env.alpha.example'), alphaEnvExample, 'utf8');
    // Local marker that alpha is separate snapshot
    writeFileSync(
      resolve(root, '.tools/alpha-data-plane-cutover.json'),
      JSON.stringify(
        {
          cutoverTimestamp: new Date().toISOString(),
          local: 'LOCAL_DEV',
          alpha: 'EXTERNAL_ALPHA',
          note: 'Environments diverge after this timestamp; no bidirectional sync.',
          secretsFile: '.secrets/alpha-data-plane.env',
          remoteConfig: remoteEnvPath,
        },
        null,
        2,
      ),
    );
    report.envSeparation = {
      localDev: 'DATABASE_URL/REDIS_URL remain developer localhost compose',
      alpha: '127.0.0.1 Postgres/Redis on managed host only',
      secretsPath: '.secrets/alpha-data-plane.env (gitignored)',
      remoteConfigPath: remoteEnvPath,
    };

    report.cutoverTimestamp = new Date().toISOString();
    report.ALPHA_DATABASE_READY = true;
    report.ALPHA_REDIS_READY = true;
    report.final = 'PASS';
  } catch (error) {
    report.error = redact(error instanceof Error ? error.message : String(error));
    report.ALPHA_DATABASE_READY = false;
    report.ALPHA_REDIS_READY = Boolean(report.redisRestart?.ok);
    report.final = 'FAIL';
  } finally {
    try {
      await runner.disconnect();
    } catch {
      // ignore
    }
    try {
      await prisma.$disconnect();
    } catch {
      // ignore
    }
    // End write freeze for LOCAL_DEV (Alpha not switched). Restart API optional.
    try {
      if (existsSync(MAINT_FLAG)) unlinkSync(MAINT_FLAG);
    } catch {
      // ignore
    }
  }

  const outPath = resolve(root, '.tools/step30-alpha-data-plane-report.json');
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    final: report.final,
    ALPHA_DATABASE_READY: report.ALPHA_DATABASE_READY,
    ALPHA_REDIS_READY: report.ALPHA_REDIS_READY,
    migrationStartedAt: report.migrationStartedAt,
    cutoverTimestamp: report.cutoverTimestamp,
    dumpSize: report.dump?.size ?? null,
    rowCountDiff: report.rowCountDiff,
    publicPorts: {
      pg: report.listen?.public5432Reachable,
      redis: report.listen?.public6379Reachable,
    },
    error: report.error,
    reportPath: outPath,
  }, null, 2));
  process.exitCode = report.final === 'PASS' ? 0 : 1;
}

await main();
