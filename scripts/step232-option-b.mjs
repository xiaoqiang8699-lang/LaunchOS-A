/**
 * Step 23.2 Option B orchestration — no secrets in output.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
}

const dbRequire = createRequire(join(root, 'packages/database/package.json'));
const domainRequire = createRequire(join(root, 'packages/domain/package.json'));
const sharedRequire = createRequire(join(root, 'packages/shared/package.json'));
const rrRequire = createRequire(join(root, 'packages/remote-runner/package.json'));

const { PrismaClient } = dbRequire('./generated/client');
const {
  SystemDomainService,
  GATEWAY_LOOPBACK_HOST,
  GATEWAY_LOOPBACK_PORT,
} = domainRequire('./dist/index.js');
const { decryptCredential } = sharedRequire('./dist/index.js');
const { RemoteRunner } = rrRequire('./dist/index.js');

function redact(s) {
  return String(s ?? '')
    .replace(/password[=:].*/gi, 'password=[redacted]')
    .replace(/Authorization:.*/gi, 'Authorization=[redacted]');
}

async function remoteExec(server, script, timeoutMs = 60_000) {
  const runner = new RemoteRunner();
  try {
    await runner.connect({
      host: server.host,
      port: server.port,
      username: server.username,
      password: decryptCredential(server.credentialEncrypted),
      readyTimeoutMs: 25_000,
    });
    return await runner.execute(script, { timeoutMs });
  } finally {
    await runner.disconnect().catch(() => undefined);
  }
}

async function httpGet(url, headers = {}) {
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(12_000),
    redirect: 'manual',
  });
  const text = await res.text();
  return { status: res.status, body: text.slice(0, 300) };
}

const report = {};

const prisma = new PrismaClient();
try {
  const svc = new SystemDomainService(prisma);
  const config = await svc.getOrCreateConfig();
  report.configBefore = {
    rootDomain: config.rootDomain,
    gatewayPublicIp: config.gatewayPublicIp,
    gatewayServerId: config.gatewayServerId,
    dnsStatus: config.dnsStatus,
  };

  const serverId = process.env.LAUNCHOS_GATEWAY_SERVER_ID;
  if (!serverId) throw new Error('LAUNCHOS_GATEWAY_SERVER_ID missing');
  const server = await prisma.serverInstance.findUnique({ where: { id: serverId } });
  if (!server || server.host !== '8.138.113.134') {
    throw new Error('Gateway ServerInstance mismatch');
  }
  report.serverInstanceId = server.id;
  report.serverHost = server.host;

  // 1) Precheck apex sites (must stay healthy)
  const apex = await httpGet('http://zsaos.com/');
  const www = await httpGet('http://www.zsaos.com/');
  report.precheckApex = { status: apex.status, snippet: apex.body.slice(0, 120) };
  report.precheckWww = { status: www.status, snippet: www.body.slice(0, 120) };
  if (apex.status < 200 || apex.status >= 500) {
    throw new Error(`zsaos.com precheck unexpected status ${apex.status}`);
  }

  // 2) Build gateway bundle path
  const bundleCandidates = [
    join(root, 'apps/gateway/dist/gateway.cjs'),
    join(root, 'apps/gateway/dist/standalone.js'),
  ];
  let bundle = bundleCandidates.find((p) => existsSync(p));
  if (!bundle) {
    throw new Error('gateway.cjs missing — run gateway build first');
  }
  report.gatewayBundle = bundle.replace(root, '.');

  // 3) Deploy gateway loopback
  const deployed = await svc.deployGateway(bundle);
  report.deployGateway = {
    deployed: deployed.deployed,
    message: deployed.message,
    healthUrl: deployed.result?.healthUrl ?? null,
  };
  if (!deployed.deployed) throw new Error(deployed.message);

  const healthLocal = await remoteExec(
    server,
    `curl -sS -w "\\nHTTP:%{http_code}" http://${GATEWAY_LOOPBACK_HOST}:${GATEWAY_LOOPBACK_PORT}/health`,
  );
  report.localHealth = redact(healthLocal.stdout.trim());

  // 4) Ensure zsaos.com SYSTEM domains + sync routes
  const ensured = await svc.ensureCurrentZoneSystemDomains();
  report.systemDomainsCreated = ensured.domains;
  report.routeKeys = Object.keys(ensured.table.routes);
  report.routeSample = Object.fromEntries(
    Object.entries(ensured.table.routes).map(([k, v]) => [
      k,
      { host: v.host, port: v.port, status: v.status, projectId: v.projectId },
    ]),
  );

  const primaryDomain =
    ensured.domains.find((d) => d.includes('real-server-1789445560584')) ||
    ensured.domains[0] ||
    report.routeKeys.find((k) => ensured.table.routes[k]?.status === 'running');

  if (!primaryDomain) throw new Error('No primary SYSTEM domain for running app');
  report.primaryDomain = primaryDomain;

  // 5) Gateway direct Host test (loopback)
  const gwHostTest = await remoteExec(
    server,
    `curl -sS -D - -o /tmp/lo-gw-body.txt -w "\\nHTTP:%{http_code}" -H "Host: ${primaryDomain}" http://${GATEWAY_LOOPBACK_HOST}:${GATEWAY_LOOPBACK_PORT}/; echo; head -c 180 /tmp/lo-gw-body.txt; echo`,
  );
  report.gatewayHostTest = redact(gwHostTest.stdout.trim()).slice(0, 500);

  // 6) Install nginx wildcard (never touch apex conf)
  const nginx = await svc.installWildcardNginx();
  report.nginx = nginx;
  if (!nginx.installed) throw new Error(nginx.message);

  // 7) Verify apex after reload
  const apexAfter = await httpGet('http://zsaos.com/');
  const wwwAfter = await httpGet('http://www.zsaos.com/');
  report.afterApex = { status: apexAfter.status, snippet: apexAfter.body.slice(0, 120) };
  report.afterWww = { status: wwwAfter.status, snippet: wwwAfter.body.slice(0, 120) };

  // 8) Public IP + Host → app
  const publicApp = await httpGet(`http://${server.host}/`, { Host: primaryDomain });
  report.publicHostApp = {
    status: publicApp.status,
    hasHerokuTitle: /Node\.js Getting Started on Heroku/i.test(publicApp.body),
    snippet: publicApp.body.slice(0, 160),
  };

  // 9) Unknown subdomain
  const unknownHost = `not-exist-${randomBytes(3).toString('hex')}.zsaos.com`;
  const publicUnknown = await httpGet(`http://${server.host}/`, { Host: unknownHost });
  report.publicUnknown = {
    host: unknownHost,
    status: publicUnknown.status,
    isGatewayNotFound: /没有找到这个应用/.test(publicUnknown.body),
    snippet: publicUnknown.body.slice(0, 160),
  };

  // 10) systemd status
  const systemd = await remoteExec(
    server,
    'systemctl is-active launchos-gateway; systemctl is-enabled launchos-gateway; ss -lptn "sport = :9080" | head -n 5',
  );
  report.systemd = redact(systemd.stdout.trim());

  // 11) Confirm DNS still PENDING
  const cfg = await prisma.systemDomainConfig.findFirst({ orderBy: { createdAt: 'asc' } });
  const domains = await prisma.applicationDomain.findMany({
    where: { type: 'SYSTEM', domain: { endsWith: '.zsaos.com' } },
    select: { domain: true, status: true, dnsStatus: true, sslStatus: true },
  });
  const legacy = await prisma.applicationDomain.findMany({
    where: { type: 'SYSTEM', domain: { endsWith: '.launchos.app' } },
    select: { domain: true, status: true, dnsStatus: true },
  });
  report.systemDomainConfig = {
    rootDomain: cfg?.rootDomain,
    gatewayPublicIp: cfg?.gatewayPublicIp,
    gatewayServerId: cfg?.gatewayServerId,
    dnsStatus: cfg?.dnsStatus,
    lastVerifiedAt: cfg?.lastVerifiedAt,
  };
  report.zsaosDomains = domains;
  report.legacyLaunchosAppDomains = legacy;
  report.dnsReminder = {
    type: 'A',
    host: '*',
    value: '8.138.113.134',
    ttl: '阿里云默认',
    doNotTouch: ['@', 'www'],
  };

  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        report,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
