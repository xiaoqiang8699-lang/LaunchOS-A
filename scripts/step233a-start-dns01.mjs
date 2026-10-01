import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
}

const dbRequire = createRequire(join(root, 'packages/database/package.json'));
const sharedRequire = createRequire(join(root, 'packages/shared/package.json'));
const rrRequire = createRequire(join(root, 'packages/remote-runner/package.json'));
const { PrismaClient, ApplicationSslStatus } = dbRequire('./generated/client');
const { decryptCredential } = sharedRequire('./dist/index.js');
const { RemoteRunner } = rrRequire('./dist/index.js');

const ZONE = 'zsaos.com';
const WILDCARD = `*.${ZONE}`;
const ACCOUNT_EMAIL = `ssl-admin@${ZONE}`;

const DNS_API = `#!/usr/bin/env sh
dns_launchospause_add() {
  fulldomain="$1"
  txtvalue="$2"
  mkdir -p /opt/launchos-tls
  umask 077
  printf '%s\\n' "$fulldomain" > /opt/launchos-tls/pending-challenge-domain.txt
  printf '%s\\n' "$txtvalue" > /opt/launchos-tls/pending-challenge-txt.txt
  chmod 600 /opt/launchos-tls/pending-challenge-domain.txt /opt/launchos-tls/pending-challenge-txt.txt
  echo "LaunchOS ACME challenge saved; pausing before CA validation." >&2
  return 1
}
dns_launchospause_rm() {
  return 0
}
`;

const prisma = new PrismaClient();
const runner = new RemoteRunner();
const tmp = mkdtempSync(join(tmpdir(), 'launchos-acme-'));

try {
  const server = await prisma.serverInstance.findUnique({
    where: { id: process.env.LAUNCHOS_GATEWAY_SERVER_ID },
  });
  await runner.connect({
    host: server.host,
    port: server.port,
    username: server.username,
    password: decryptCredential(server.credentialEncrypted),
    readyTimeoutMs: 25_000,
  });

  // Kill only leftover LaunchOS ACME helpers from prior timed-out session (not nginx).
  await runner.execute(
    [
      'set +e',
      'pkill -f "acme.sh --register-account -m ssl-admin@zsaos.com" 2>/dev/null || true',
      'pkill -f "acme.sh --issue -d \\*.zsaos.com" 2>/dev/null || true',
      'pkill -f "acme.sh --issue -d \'\\*.zsaos.com\'" 2>/dev/null || true',
      'pkill -f "user-agent acme.sh" 2>/dev/null || true',
      'sleep 1',
      'ps aux | grep -E "[a]cme.sh|[u]ser-agent acme" | head || echo no_acme_procs',
      'echo ===NET===',
      'curl -sS -o /dev/null -w "le_nonce:%{http_code} time:%{time_total}\\n" --max-time 25 -I https://acme-v02.api.letsencrypt.org/directory || echo le_fail',
      'curl -sS -o /dev/null -w "zerossl:%{http_code} time:%{time_total}\\n" --max-time 25 -I https://acme.zerossl.com/v2/DV90 || echo zerossl_fail',
      'curl -sS -o /dev/null -w "app_http:%{http_code}\\n" --max-time 12 http://real-server-1789445560584.zsaos.com/',
      'curl -sS -o /dev/null -w "apex_https:%{http_code}\\n" --max-time 12 https://zsaos.com/',
    ].join('\n'),
    { timeoutMs: 90_000 },
  ).then((r) => console.log('CLEANUP', r.stdout));

  const localApi = join(tmp, 'dns_launchospause.sh');
  writeFileSync(localApi, DNS_API, { encoding: 'utf8', mode: 0o755 });
  await runner.upload(localApi, '/root/.acme.sh/dnsapi/dns_launchospause.sh', { timeoutMs: 60_000 });
  await runner.execute(
    'chmod 755 /root/.acme.sh/dnsapi/dns_launchospause.sh; rm -f /opt/launchos-tls/pending-challenge-*.txt',
    { timeoutMs: 15_000 },
  );

  // Prefer Let's Encrypt; fall back to ZeroSSL if LE directory unreachable.
  const issue = await runner.execute(
    [
      'set +e',
      'export LE_WORKING_DIR=/root/.acme.sh',
      'CA=letsencrypt',
      'curl -fsS --max-time 20 -I https://acme-v02.api.letsencrypt.org/directory >/dev/null 2>&1 || CA=zerossl',
      'echo USING_CA:$CA',
      'if [ "$CA" = "letsencrypt" ]; then',
      `  /root/.acme.sh/acme.sh --register-account -m ${ACCOUNT_EMAIL} --server letsencrypt >/tmp/launchos-acme-account.log 2>&1 || true`,
      `  /root/.acme.sh/acme.sh --issue -d '${WILDCARD}' --dns dns_launchospause --server letsencrypt --force >/tmp/launchos-acme-issue.log 2>&1`,
      'else',
      `  /root/.acme.sh/acme.sh --register-account -m ${ACCOUNT_EMAIL} --server zerossl >/tmp/launchos-acme-account.log 2>&1 || true`,
      `  /root/.acme.sh/acme.sh --issue -d '${WILDCARD}' --dns dns_launchospause --server zerossl --force >/tmp/launchos-acme-issue.log 2>&1`,
      'fi',
      'echo ISSUE_EXIT:$?',
      'tail -n 50 /tmp/launchos-acme-issue.log',
      'echo ===FILES===',
      'ls -la /opt/launchos-tls/',
      'test -f /opt/launchos-tls/pending-challenge-txt.txt && echo TXT_OK || echo TXT_MISSING',
    ].join('\n'),
    { timeoutMs: 300_000 },
  );
  console.log('ISSUE', issue.stdout.slice(-2000));

  const readChallenge = await runner.execute(
    [
      'set -e',
      'test -f /opt/launchos-tls/pending-challenge-domain.txt',
      'test -f /opt/launchos-tls/pending-challenge-txt.txt',
      'echo CHALLENGE_DOMAIN="$(cat /opt/launchos-tls/pending-challenge-domain.txt)"',
      'echo CHALLENGE_TXT="$(cat /opt/launchos-tls/pending-challenge-txt.txt)"',
    ].join('\n'),
    { timeoutMs: 30_000 },
  );
  if (readChallenge.exitCode !== 0) {
    throw new Error(`challenge missing: ${issue.stdout.slice(-1200)}`);
  }

  const challengeDomain = readChallenge.stdout.match(/CHALLENGE_DOMAIN=(.+)/)?.[1]?.trim();
  const challengeTxt = readChallenge.stdout.match(/CHALLENGE_TXT=(.+)/)?.[1]?.trim();
  if (!challengeDomain || !challengeTxt) throw new Error('parse challenge failed');

  const hostRecord = challengeDomain.endsWith(`.${ZONE}`)
    ? challengeDomain.slice(0, -(`.${ZONE}`.length))
    : challengeDomain;

  const config = await prisma.systemDomainConfig.findFirst({ orderBy: { createdAt: 'asc' } });
  await prisma.systemDomainConfig.update({
    where: { id: config.id },
    data: {
      tlsStatus: ApplicationSslStatus.PENDING,
      tlsCertificateDomain: WILDCARD,
      tlsIssuer: null,
      tlsExpiresAt: null,
      tlsLastVerifiedAt: null,
      tlsManager: 'acme.sh',
      tlsCertPathHint: '/opt/launchos-tls/certs',
    },
  });
  await prisma.applicationDomain.updateMany({
    where: { type: 'SYSTEM', domain: { endsWith: `.${ZONE}` } },
    data: { sslStatus: ApplicationSslStatus.PENDING },
  });

  const post = await runner.execute(
    [
      'curl -sS -o /dev/null -w "app:%{http_code}\\n" --max-time 12 http://real-server-1789445560584.zsaos.com/',
      'curl -sS -o /dev/null -w "apex:%{http_code}\\n" --max-time 12 https://zsaos.com/',
      'curl -sS -o /dev/null -w "www:%{http_code}\\n" --max-time 12 https://www.zsaos.com/',
      'grep -n "listen\\|server_name\\|ssl_" /www/server/panel/vhost/nginx/launchos-wildcard-zsaos-com.conf | head',
    ].join('\n'),
    { timeoutMs: 60_000 },
  );

  const updated = await prisma.systemDomainConfig.findFirst({ orderBy: { createdAt: 'asc' } });
  const sslRows = await prisma.applicationDomain.findMany({
    where: { type: 'SYSTEM', domain: { endsWith: `.${ZONE}` } },
    select: { domain: true, sslStatus: true },
  });

  console.log(
    JSON.stringify(
      {
        certificateManager: 'acme.sh',
        wildcardDomain: WILDCARD,
        challengeGenerated: true,
        dnsTxt: {
          type: 'TXT',
          host: hostRecord,
          fullName: challengeDomain,
          value: challengeTxt,
          ttl: '阿里云默认或较短（建议 600）',
        },
        systemTls: {
          tlsStatus: updated.tlsStatus,
          tlsCertificateDomain: updated.tlsCertificateDomain,
          tlsManager: updated.tlsManager,
        },
        applicationSslStatus: sslRows.map((r) => r.sslStatus),
        postCheck: post.stdout.trim(),
        modifiedApexOrWww: false,
        modifiedWildcardA: false,
      },
      null,
      2,
    ),
  );
} finally {
  await runner.disconnect().catch(() => undefined);
  await prisma.$disconnect();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
