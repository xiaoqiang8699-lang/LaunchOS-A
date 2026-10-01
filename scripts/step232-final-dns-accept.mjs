/**
 * Step 23.2 final public DNS acceptance — no secrets in output.
 * Uses public DNS resolvers + real HTTP (no hosts, no manual Host header).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
}

const dbRequire = createRequire(join(root, 'packages/database/package.json'));
const domainRequire = createRequire(join(root, 'packages/domain/package.json'));
const { PrismaClient } = dbRequire('./generated/client');
const {
  SystemDomainService,
  verifyHostnamePointsToIp,
  verifyWildcardDns,
  toVisitUrls,
} = domainRequire('./dist/index.js');

const EXPECTED_IP = '8.138.113.134';
const APP_HOST = 'real-server-1789445560584.zsaos.com';

function curl(args) {
  const r = spawnSync('curl.exe', ['-sS', '--max-time', '15', ...args], {
    encoding: 'utf8',
  });
  return {
    exit: r.status,
    stdout: r.stdout || '',
    stderr: (r.stderr || '').slice(0, 200),
  };
}

const prisma = new PrismaClient();
try {
  // 1) Real DNS queries via public resolvers (inside verifyHostnamePointsToIp)
  const appDns = await verifyHostnamePointsToIp(APP_HOST, EXPECTED_IP);
  const wildcard = await verifyWildcardDns('zsaos.com', EXPECTED_IP);

  const report = {
    appDns,
    wildcardSamples: wildcard.samples,
    wildcardVerified: wildcard.verified,
  };

  if (!wildcard.verified || !appDns.matched) {
    console.log(
      JSON.stringify(
        {
          ...report,
          stopped: true,
          message: 'DNS 尚未全部解析到 Gateway IP，可能仍在传播。dnsStatus 保持 PENDING，不伪造 ACTIVE。',
          systemDomainConfig: await prisma.systemDomainConfig.findFirst({
            orderBy: { createdAt: 'asc' },
            select: { rootDomain: true, dnsStatus: true, gatewayPublicIp: true },
          }),
        },
        null,
        2,
      ),
    );
  } else {
  // 2) System verify (same logic as POST /api/v1/system-domain/verify)
  const svc = new SystemDomainService(prisma);
  const verifyResult = await svc.verify();

  // 3) Real public HTTP — no Host header override, no IP:8080
  const appHttp = curl(['-w', '\nHTTP:%{http_code}\n', `http://${APP_HOST}/`]);
  const unknownHost = `not-exist-${randomBytes(3).toString('hex')}.zsaos.com`;
  const unknownDns = await verifyHostnamePointsToIp(unknownHost, EXPECTED_IP);
  const unknownHttp = curl(['-w', '\nHTTP:%{http_code}\n', `http://${unknownHost}/`]);
  const apex = curl(['-o', 'NUL', '-w', '%{http_code} %{redirect_url}', 'http://zsaos.com/']);
  const www = curl(['-o', 'NUL', '-w', '%{http_code} %{redirect_url}', 'http://www.zsaos.com/']);

  const cfg = await prisma.systemDomainConfig.findFirst({ orderBy: { createdAt: 'asc' } });
  const zsaosDomains = await prisma.applicationDomain.findMany({
    where: { type: 'SYSTEM', domain: { endsWith: '.zsaos.com' } },
    select: { domain: true, status: true, dnsStatus: true },
  });
  const primary = zsaosDomains.find((d) => d.domain === APP_HOST);
  const visit = primary
    ? toVisitUrls({
        domain: primary.domain,
        status: primary.status,
        dnsStatus: primary.dnsStatus,
      })
    : null;

  console.log(
    JSON.stringify(
      {
        ...report,
        verifyApiEquivalent: {
          message: verifyResult.message,
          dnsStatus: verifyResult.dnsStatus,
          gatewayReachable: verifyResult.gatewayReachable,
          gatewayHealth: verifyResult.gatewayHealth,
          wildcardCheck: verifyResult.wildcardCheck,
          rootDomain: verifyResult.rootDomain,
        },
        systemDomainConfig: {
          rootDomain: cfg?.rootDomain,
          dnsStatus: cfg?.dnsStatus,
          gatewayPublicIp: cfg?.gatewayPublicIp,
          lastVerifiedAt: cfg?.lastVerifiedAt,
        },
        applicationDomainsZsaos: zsaosDomains,
        appHttp: {
          statusLine: (appHttp.stdout.match(/HTTP:\d+/) || [])[0] || null,
          hasHerokuTitle: /Node\.js Getting Started on Heroku/i.test(appHttp.stdout),
          snippet: appHttp.stdout.replace(/\nHTTP:\d+\n?$/, '').slice(0, 180),
          stderr: appHttp.stderr || null,
        },
        unknown: {
          host: unknownHost,
          dns: unknownDns,
          httpStatus: (unknownHttp.stdout.match(/HTTP:\d+/) || [])[0] || null,
          isGatewayNotFound: /没有找到这个应用/.test(unknownHttp.stdout),
          snippet: unknownHttp.stdout.replace(/\nHTTP:\d+\n?$/, '').slice(0, 180),
        },
        apex: apex.stdout,
        www: www.stdout,
        frontendVisit: visit,
        usedHostsFile: false,
        usedManualHostHeader: false,
        protocol: 'http',
      },
      null,
      2,
    ),
  );
  }
} finally {
  await prisma.$disconnect();
}
