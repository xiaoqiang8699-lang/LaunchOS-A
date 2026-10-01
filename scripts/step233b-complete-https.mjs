/**
 * Step 23.3B — TXT check → resume acme.sh → install cert → nginx 443 → verify → HTTP redirect
 * Never prints private keys or credentials.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
}

const dbRequire = createRequire(join(root, 'packages/database/package.json'));
const sharedRequire = createRequire(join(root, 'packages/shared/package.json'));
const rrRequire = createRequire(join(root, 'packages/remote-runner/package.json'));
const { PrismaClient, ApplicationSslStatus, ApplicationDomainType } = dbRequire('./generated/client');
const { decryptCredential } = sharedRequire('./dist/index.js');
const { RemoteRunner } = rrRequire('./dist/index.js');

const ZONE = 'zsaos.com';
const WILDCARD = `*.${ZONE}`;
const EXPECTED_TXT = 'FTWgZhs-JrFLG7qVU91rnXopI4GXwy4vEImk4pRt1QQ';
const APP = `real-server-1789445560584.${ZONE}`;
const CERT_DIR = '/www/server/panel/vhost/cert/launchos-wildcard-zsaos';
const VHOST = '/www/server/panel/vhost/nginx/launchos-wildcard-zsaos-com.conf';
const NGINX = '/www/server/nginx/sbin/nginx';

async function dohTxt(name) {
  const urls = [
    `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=TXT`,
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`,
  ];
  const values = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(12_000),
      });
      const json = await res.json();
      for (const ans of json.Answer || []) {
        if (ans.type === 16 && typeof ans.data === 'string') {
          values.push(ans.data.replace(/^"|"$/g, '').replace(/" "/g, ''));
        }
      }
    } catch {
      // try next
    }
  }
  return [...new Set(values)];
}

function curl(args) {
  const r = spawnSync('curl.exe', ['-sS', '--max-time', '20', ...args], { encoding: 'utf8' });
  return { exit: r.status, out: r.stdout || '', err: (r.stderr || '').slice(0, 300) };
}

const prisma = new PrismaClient();
const runner = new RemoteRunner();
const tmp = mkdtempSync(join(tmpdir(), 'launchos-233b-'));

try {
  // 1) Public TXT check
  const txtValues = await dohTxt(`_acme-challenge.${ZONE}`);
  const txtOk = txtValues.some((v) => v.includes(EXPECTED_TXT));
  if (!txtOk) {
    console.log(
      JSON.stringify(
        {
          stopped: true,
          message: 'TXT 公网尚未可见，保持 PENDING，不继续 ACME。',
          txtValues,
          expected: EXPECTED_TXT,
        },
        null,
        2,
      ),
    );
    process.exitCode = 0;
  } else {
    const server = await prisma.serverInstance.findUnique({
      where: { id: process.env.LAUNCHOS_GATEWAY_SERVER_ID },
    });
    if (!server) throw new Error('missing gateway server');
    await runner.connect({
      host: server.host,
      port: server.port,
      username: server.username,
      password: decryptCredential(server.credentialEncrypted),
      readyTimeoutMs: 25_000,
    });

    // Ensure pause DNS api now succeeds (TXT already published) so renew can complete.
    const dnsApi = `#!/usr/bin/env sh
dns_launchospause_add() {
  fulldomain="$1"
  txtvalue="$2"
  mkdir -p /opt/launchos-tls
  umask 077
  printf '%s\\n' "$fulldomain" > /opt/launchos-tls/pending-challenge-domain.txt
  printf '%s\\n' "$txtvalue" > /opt/launchos-tls/pending-challenge-txt.txt
  chmod 600 /opt/launchos-tls/pending-challenge-domain.txt /opt/launchos-tls/pending-challenge-txt.txt
  expected="${EXPECTED_TXT}"
  if [ "$txtvalue" != "$expected" ]; then
    echo "NEW_CHALLENGE_TXT=$txtvalue" > /opt/launchos-tls/new-challenge-txt.txt
    echo "Challenge TXT changed; refusing to continue." >&2
    return 1
  fi
  # TXT already published manually — allow CA validation to proceed.
  return 0
}
dns_launchospause_rm() {
  return 0
}
`;
    writeFileSync(join(tmp, 'dns_launchospause.sh'), dnsApi, { mode: 0o755 });
    await runner.upload(join(tmp, 'dns_launchospause.sh'), '/root/.acme.sh/dnsapi/dns_launchospause.sh', {
      timeoutMs: 60_000,
    });
    await runner.execute('chmod 755 /root/.acme.sh/dnsapi/dns_launchospause.sh', { timeoutMs: 15_000 });

    // Resume same domain order via --renew (manual dns mode). If invalid, --issue with same dns.
    const issue = await runner.execute(
      [
        'set +e',
        'export LE_WORKING_DIR=/root/.acme.sh',
        'rm -f /opt/launchos-tls/new-challenge-txt.txt',
        // Prefer renew to continue existing ZeroSSL order; fall back to issue.
        `/root/.acme.sh/acme.sh --renew -d '${WILDCARD}' --yes-I-know-dns-manual-mode-enough-go-ahead-please --force > /tmp/launchos-acme-renew.log 2>&1`,
        'RENEW_EXIT=$?',
        'if [ $RENEW_EXIT -ne 0 ]; then',
        `  /root/.acme.sh/acme.sh --issue -d '${WILDCARD}' --dns dns_launchospause --server zerossl --force > /tmp/launchos-acme-issue2.log 2>&1`,
        '  ISSUE_EXIT=$?',
        'else',
        '  ISSUE_EXIT=0',
        'fi',
        'echo RENEW_EXIT:$RENEW_EXIT',
        'echo ISSUE_EXIT:$ISSUE_EXIT',
        'if [ -f /opt/launchos-tls/new-challenge-txt.txt ]; then echo NEW_TXT_DETECTED; cat /opt/launchos-tls/new-challenge-txt.txt; fi',
        'echo ===RENEW_TAIL===',
        'tail -n 60 /tmp/launchos-acme-renew.log 2>/dev/null',
        'echo ===ISSUE_TAIL===',
        'tail -n 60 /tmp/launchos-acme-issue2.log 2>/dev/null',
        'echo ===CERT_LOC===',
        `ls -la /root/.acme.sh/${WILDCARD}_ecc/ 2>/dev/null | sed 's/\\.key$/.key[redacted-name]/' || ls -la /root/.acme.sh/*.zsaos.com_ecc/ 2>/dev/null | head`,
      ].join('\n'),
      { timeoutMs: 420_000 },
    );

    if (/NEW_TXT_DETECTED/.test(issue.stdout)) {
      const newTxt = issue.stdout.match(/NEW_CHALLENGE_TXT=(.+)/)?.[1]?.trim();
      console.log(
        JSON.stringify(
          {
            stopped: true,
            message: '原 ACME challenge TXT 已变化，需人工更新 DNS。未继续验证。',
            newTxt,
            logTail: issue.stdout.slice(-1500),
          },
          null,
          2,
        ),
      );
    } else {
      const issuedOk =
        /Cert success|Your cert is in|Download cert success|证书.*成功|SUCCESS/i.test(issue.stdout) ||
        issue.stdout.includes('ISSUE_EXIT:0');

      // Install cert files to isolated directory (copy fullchain + key without echoing key)
      const install = await runner.execute(
        [
          'set -e',
          `ACME_DIR="/root/.acme.sh/*.zsaos.com_ecc"`,
          'test -f "$ACME_DIR/fullchain.cer"',
          'test -f "$ACME_DIR/*.zsaos.com.key"',
          `mkdir -p ${CERT_DIR}`,
          'chmod 700 /www/server/panel/vhost/cert/launchos-wildcard-zsaos || true',
          `cp -f "$ACME_DIR/fullchain.cer" ${CERT_DIR}/fullchain.pem`,
          `cp -f "$ACME_DIR/*.zsaos.com.key" ${CERT_DIR}/privkey.pem`,
          `chmod 644 ${CERT_DIR}/fullchain.pem`,
          `chmod 600 ${CERT_DIR}/privkey.pem`,
          // Cert metadata without dumping private key
          `openssl x509 -in ${CERT_DIR}/fullchain.pem -noout -issuer -dates -ext subjectAltName 2>/dev/null | sed 's/\\\\n/ /g'`,
          'echo INSTALL_OK',
        ].join('\n'),
        { timeoutMs: 60_000 },
      );

      if (install.exitCode !== 0 || !issuedOk && !/INSTALL_OK/.test(install.stdout)) {
        // If install failed, check whether cert actually exists after ISSUE_EXIT:0
        const probe = await runner.execute(
          'ls -la "/root/.acme.sh/*.zsaos.com_ecc/" 2>&1 | head -n 20; echo ---; tail -n 80 /tmp/launchos-acme-issue2.log 2>/dev/null; echo ---; tail -n 80 /tmp/launchos-acme-renew.log 2>/dev/null',
          { timeoutMs: 30_000 },
        );
        throw new Error(
          `certificate issue/install failed.\nISSUE:\n${issue.stdout.slice(-2000)}\nINSTALL:\n${install.stdout}\n${install.stderr}\nPROBE:\n${probe.stdout}`,
        );
      }

      // Parse openssl metadata
      const issuer = install.stdout.match(/issuer=(.+)/i)?.[1]?.trim() || null;
      const notBefore = install.stdout.match(/notBefore=(.+)/i)?.[1]?.trim() || null;
      const notAfter = install.stdout.match(/notAfter=(.+)/i)?.[1]?.trim() || null;
      const san = install.stdout.match(/DNS:[^\n]+/i)?.[0] || install.stdout;

      // Write nginx conf: HTTP + HTTPS, no forced redirect yet
      const nginxConf = `# Managed by LaunchOS — wildcard apps only. Do not put apex/www here.
server {
    listen 80;
    server_name *.${ZONE};

    location / {
        proxy_pass http://127.0.0.1:9080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
    }
}

server {
    listen 443 ssl;
    http2 on;
    server_name *.${ZONE};

    ssl_certificate     ${CERT_DIR}/fullchain.pem;
    ssl_certificate_key ${CERT_DIR}/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 10m;

    location / {
        proxy_pass http://127.0.0.1:9080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
    }
}
`;
      writeFileSync(join(tmp, 'wildcard.conf'), nginxConf, 'utf8');
      // Backup existing conf then upload
      await runner.execute(`cp -f ${VHOST} ${VHOST}.bak.233b || true`, { timeoutMs: 15_000 });
      await runner.upload(join(tmp, 'wildcard.conf'), VHOST, { timeoutMs: 60_000 });

      const test = await runner.execute(`${NGINX} -t 2>&1`, { timeoutMs: 30_000 });
      if (test.exitCode !== 0) {
        await runner.execute(`cp -f ${VHOST}.bak.233b ${VHOST}; ${NGINX} -t 2>&1`, {
          timeoutMs: 30_000,
        });
        throw new Error(`nginx -t failed; restored backup. ${test.stderr || test.stdout}`);
      }
      const reload = await runner.execute(`${NGINX} -s reload 2>&1`, { timeoutMs: 30_000 });
      if (reload.exitCode !== 0) {
        throw new Error(`nginx reload failed: ${reload.stderr || reload.stdout}`);
      }

      // Verify apex/www still their own certs; HTTPS app with full verify (no -k)
      const apex = curl(['-o', 'NUL', '-w', '%{http_code} %{ssl_verify_result}', `https://${ZONE}/`]);
      const www = curl([
        '-o',
        'NUL',
        '-w',
        '%{http_code} %{ssl_verify_result}',
        `https://www.${ZONE}/`,
      ]);
      const apexCert = curl(['-vI', `https://${ZONE}/`]);
      const appHttps = curl([
        '-w',
        '\nHTTP:%{http_code}\nVERIFY:%{ssl_verify_result}\n',
        `https://${APP}/`,
      ]);
      const unknown = `not-exist-${randomBytes(3).toString('hex')}.${ZONE}`;
      const unknownHttps = curl([
        '-w',
        '\nHTTP:%{http_code}\nVERIFY:%{ssl_verify_result}\n',
        `https://${unknown}/`,
      ]);

      const appOk =
        /HTTP:200/.test(appHttps.out) &&
        /VERIFY:0/.test(appHttps.out) &&
        /Node\.js Getting Started on Heroku/i.test(appHttps.out);
      const unknownOk =
        /HTTP:404/.test(unknownHttps.out) &&
        /VERIFY:0/.test(unknownHttps.out) &&
        /没有找到这个应用/.test(unknownHttps.out);
      const apexOk = apex.out.startsWith('200') && apex.out.includes(' 0');
      const wwwOk = www.out.startsWith('200') && www.out.includes(' 0');

      if (!appOk || !unknownOk || !apexOk || !wwwOk) {
        console.log(
          JSON.stringify(
            {
              stopped: true,
              message: 'HTTPS 验收未全部通过，未更新 ACTIVE，未做 HTTP→HTTPS 跳转。',
              apex: apex.out,
              www: www.out,
              appHttps: {
                verify: (appHttps.out.match(/VERIFY:\d+/) || [])[0],
                http: (appHttps.out.match(/HTTP:\d+/) || [])[0],
                hasHeroku: /Node\.js Getting Started on Heroku/i.test(appHttps.out),
                snippet: appHttps.out.replace(/\nHTTP:\d+\nVERIFY:\d+\n?/, '').slice(0, 160),
                err: appHttps.err,
              },
              unknownHttps: {
                host: unknown,
                verify: (unknownHttps.out.match(/VERIFY:\d+/) || [])[0],
                http: (unknownHttps.out.match(/HTTP:\d+/) || [])[0],
                isGatewayNotFound: /没有找到这个应用/.test(unknownHttps.out),
                err: unknownHttps.err,
              },
              issuer,
              notAfter,
              san: String(san).slice(0, 300),
            },
            null,
            2,
          ),
        );
      } else {
        // Update TLS ACTIVE
        const expiresAt = notAfter ? new Date(notAfter) : null;
        const config = await prisma.systemDomainConfig.findFirst({ orderBy: { createdAt: 'asc' } });
        await prisma.systemDomainConfig.update({
          where: { id: config.id },
          data: {
            tlsStatus: ApplicationSslStatus.ACTIVE,
            tlsCertificateDomain: WILDCARD,
            tlsIssuer: issuer,
            tlsExpiresAt: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
            tlsLastVerifiedAt: new Date(),
            tlsManager: 'acme.sh',
            tlsCertPathHint: CERT_DIR,
          },
        });
        await prisma.applicationDomain.updateMany({
          where: {
            type: ApplicationDomainType.SYSTEM,
            domain: { endsWith: `.${ZONE}` },
          },
          data: { sslStatus: ApplicationSslStatus.ACTIVE },
        });

        // HTTP → HTTPS redirect for wildcard only
        const redirectConf = `# Managed by LaunchOS — wildcard apps only. Do not put apex/www here.
server {
    listen 80;
    server_name *.${ZONE};
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name *.${ZONE};

    ssl_certificate     ${CERT_DIR}/fullchain.pem;
    ssl_certificate_key ${CERT_DIR}/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 10m;

    location / {
        proxy_pass http://127.0.0.1:9080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
    }
}
`;
        writeFileSync(join(tmp, 'wildcard-redirect.conf'), redirectConf, 'utf8');
        await runner.upload(join(tmp, 'wildcard-redirect.conf'), VHOST, { timeoutMs: 60_000 });
        const test2 = await runner.execute(`${NGINX} -t 2>&1`, { timeoutMs: 30_000 });
        if (test2.exitCode !== 0) {
          // restore previous dual HTTP+HTTPS conf
          writeFileSync(join(tmp, 'wildcard.conf'), nginxConf, 'utf8');
          await runner.upload(join(tmp, 'wildcard.conf'), VHOST, { timeoutMs: 60_000 });
          await runner.execute(`${NGINX} -t 2>&1; ${NGINX} -s reload 2>&1`, { timeoutMs: 30_000 });
          throw new Error(`redirect conf nginx -t failed: ${test2.stdout}`);
        }
        await runner.execute(`${NGINX} -s reload 2>&1`, { timeoutMs: 30_000 });

        const httpRedirect = curl([
          '-o',
          'NUL',
          '-w',
          '%{http_code} %{redirect_url}',
          `http://${APP}/`,
        ]);
        const httpFollow = curl([
          '-L',
          '-w',
          '\nHTTP:%{http_code}\nVERIFY:%{ssl_verify_result}\n',
          `http://${APP}/`,
        ]);
        const unknownHttp = `not-exist-${randomBytes(3).toString('hex')}.${ZONE}`;
        const unknownRedirect = curl([
          '-L',
          '-w',
          '\nHTTP:%{http_code}\nVERIFY:%{ssl_verify_result}\n',
          `http://${unknownHttp}/`,
        ]);

        // acme.sh cron check + mark renewal mode file
        const renewal = await runner.execute(
          [
            'set +e',
            'crontab -l 2>/dev/null | grep -F ".acme.sh" | head -n 3 || echo NO_ACME_CRON',
            'echo MANUAL_DNS > /opt/launchos-tls/renewal-mode.txt',
            'chmod 600 /opt/launchos-tls/renewal-mode.txt',
            // apex still ok
            'curl -sS -o /dev/null -w "apex:%{http_code}\\n" --max-time 12 https://zsaos.com/',
            'curl -sS -o /dev/null -w "www:%{http_code}\\n" --max-time 12 https://www.zsaos.com/',
          ].join('\n'),
          { timeoutMs: 60_000 },
        );

        const cfg = await prisma.systemDomainConfig.findFirst({ orderBy: { createdAt: 'asc' } });
        const domains = await prisma.applicationDomain.findMany({
          where: { type: 'SYSTEM', domain: { endsWith: `.${ZONE}` } },
          select: { domain: true, sslStatus: true, dnsStatus: true },
        });

        console.log(
          JSON.stringify(
            {
              txtPublic: true,
              txtValues,
              acmePassed: true,
              certificateIssued: true,
              issuer,
              certificateDomain: WILDCARD,
              validFrom: notBefore,
              expiresAt: notAfter,
              sanHint: String(san).slice(0, 200),
              nginx443: true,
              nginxT: true,
              apexHttps: apex.out,
              wwwHttps: www.out,
              apexCertSnippet: (apexCert.err + apexCert.out).match(/subject:.*|issuer:.*|SSL certificate verify ok/gi)?.slice(0, 6),
              appHttps: {
                url: `https://${APP}`,
                http: '200',
                verify: 0,
                realNodeApp: true,
              },
              unknownHttps: {
                host: unknown,
                http: 404,
                verify: 0,
                gatewayNotFound: true,
              },
              systemTls: {
                tlsStatus: cfg.tlsStatus,
                tlsCertificateDomain: cfg.tlsCertificateDomain,
                tlsIssuer: cfg.tlsIssuer,
                tlsExpiresAt: cfg.tlsExpiresAt,
                tlsLastVerifiedAt: cfg.tlsLastVerifiedAt,
                tlsManager: cfg.tlsManager,
              },
              applicationDomains: domains,
              frontendVisitUrl: `https://${APP}`,
              httpRedirect: httpRedirect.out,
              httpFollowHasApp: /Node\.js Getting Started on Heroku/i.test(httpFollow.out),
              unknownHttpRedirect: {
                host: unknownHttp,
                gatewayNotFound: /没有找到这个应用/.test(unknownRedirect.out),
                verify: (unknownRedirect.out.match(/VERIFY:\d+/) || [])[0],
                http: (unknownRedirect.out.match(/HTTP:\d+/) || [])[0],
              },
              renewalMode: 'MANUAL_DNS',
              acmeCron: renewal.stdout.includes('NO_ACME_CRON') ? 'missing_or_not_listed' : 'present',
              privateKey: 'saved_on_server_only',
              postApexWww: renewal.stdout.match(/apex:\d+|www:\d+/g),
            },
            null,
            2,
          ),
        );
      }
    }
  }
} finally {
  await runner.disconnect().catch(() => undefined);
  await prisma.$disconnect();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
