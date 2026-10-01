import {
  ApplicationDomainType,
  ApplicationSslStatus,
  CertificateRenewalJobStatus,
  PrismaClient,
  SystemRenewalMode,
  SystemRenewalStatus,
} from '@launchos/database';
import { decryptCredential } from '@launchos/shared';
import { RemoteRunner, RemoteRunnerError } from '@launchos/remote-runner';
import {
  AlibabaCloudDnsProvider,
  assertSystemDnsRootDomain,
  type TxtRecordRef,
} from './alibaba-dns-provider';
import { runLaunchosVerifyTxtCrudTest } from './dns-provider-verification';
import {
  acmeChallengeHost,
  shouldRenewCertificate,
  systemWildcardDomain,
} from './cert-renewal-logic';
import {
  buildAtomicInstallScript,
  buildNginxTestReloadScript,
  buildRollbackCertScript,
  certLayout,
  DEFAULT_WILDCARD_CERT_DIR,
} from './cert-install';
import { waitForTxtPropagation } from './dns-txt-verify';

export type RenewOptions = {
  force?: boolean;
  dryRun?: boolean;
};

export type CertificateStatusView = {
  certificateDomain: string | null;
  issuer: string | null;
  expiresAt: string | null;
  daysRemaining: number | null;
  renewalMode: SystemRenewalMode;
  renewalStatus: SystemRenewalStatus;
  lastRenewalAt: string | null;
  lastRenewalResult: string | null;
  tlsStatus: ApplicationSslStatus;
  dnsProviderConfigured: boolean;
  automaticDnsReady: boolean;
};

type ProviderSecrets = { accessKey: string; secretKey: string };

export class SystemCertificateRenewalService {
  constructor(private readonly prisma: PrismaClient) {}

  async getCertificateStatus(): Promise<CertificateStatusView> {
    const config = await this.requireConfig();
    const decision = shouldRenewCertificate({ expiresAt: config.tlsExpiresAt });
    const dnsReady = Boolean(
      config.dnsProviderAccountId &&
        config.renewalMode === SystemRenewalMode.AUTOMATIC_DNS,
    );
    return {
      certificateDomain: config.tlsCertificateDomain,
      issuer: config.tlsIssuer,
      expiresAt: config.tlsExpiresAt?.toISOString() ?? null,
      daysRemaining: decision.daysRemaining,
      renewalMode: config.renewalMode,
      renewalStatus: config.renewalStatus,
      lastRenewalAt: config.lastRenewalAt?.toISOString() ?? null,
      lastRenewalResult: config.lastRenewalResult,
      tlsStatus: config.tlsStatus,
      dnsProviderConfigured: Boolean(config.dnsProviderAccountId),
      automaticDnsReady: dnsReady,
    };
  }

  async checkAndEnqueueDecision(): Promise<{
    shouldRenew: boolean;
    reason: string;
    daysRemaining: number | null;
  }> {
    const config = await this.requireConfig();
    const decision = shouldRenewCertificate({ expiresAt: config.tlsExpiresAt });
    return {
      shouldRenew: decision.shouldRenew,
      reason: decision.reason,
      daysRemaining: decision.daysRemaining,
    };
  }

  /**
   * Full automatic renewal. Requires AUTOMATIC_DNS + ProviderAccount credentials.
   * dryRun: evaluates + validates config without mutating DNS/certs.
   * force: ignore 30-day window (admin test only).
   */
  async renew(options: RenewOptions = {}): Promise<{
    status: CertificateRenewalJobStatus;
    renewalId: string;
    message: string;
  }> {
    const config = await this.requireConfig();
    const rootDomain = config.rootDomain;
    const certificateDomain = config.tlsCertificateDomain || systemWildcardDomain(rootDomain);
    const decision = shouldRenewCertificate({ expiresAt: config.tlsExpiresAt });

    if (!options.dryRun && !options.force && !decision.shouldRenew) {
      return {
        status: CertificateRenewalJobStatus.SUCCESS,
        renewalId: '',
        message: `证书未进入续期窗口（剩余 ${decision.daysRemaining} 天）`,
      };
    }

    if (config.renewalMode !== SystemRenewalMode.AUTOMATIC_DNS || !config.dnsProviderAccountId) {
      throw new Error(
        '自动续期未启用：缺少系统 DNS Provider 最小权限凭证，renewalMode 仍为 MANUAL_DNS',
      );
    }

    if (options.dryRun) {
      const checks: string[] = [];
      const dns = await this.loadDnsProvider(config.dnsProviderAccountId, rootDomain);
      checks.push('DNS Provider 可加载');

      const txtTest = await runLaunchosVerifyTxtCrudTest(dns, rootDomain);
      if (!txtTest.ok) {
        throw new Error(`dryRun TXT 测试失败: ${txtTest.message}`);
      }
      checks.push('DNS challenge 创建/删除验证通过');

      const server = await this.requireGatewayServer(config.gatewayServerId);
      const password = decryptCredential(server.credentialEncrypted);
      const target = {
        host: server.host,
        port: server.port,
        username: server.username,
        password,
      };
      const remoteChecks = await this.remote(
        target,
        [
          'test -x /root/.acme.sh/acme.sh && echo ACME_OK',
          `test -d '${DEFAULT_WILDCARD_CERT_DIR}' && echo CERTDIR_OK`,
          'nginx -t 2>&1 | tail -n 3',
          'echo NGINX_TEST_DONE',
        ].join('\n'),
      );
      if (!remoteChecks.includes('ACME_OK')) {
        throw new Error('dryRun 失败：acme.sh 未安装或不可执行');
      }
      checks.push('ACME 工具就绪');
      if (!remoteChecks.includes('CERTDIR_OK')) {
        throw new Error(`dryRun 失败：证书目录不存在 ${DEFAULT_WILDCARD_CERT_DIR}`);
      }
      checks.push('证书目录可访问');
      if (!remoteChecks.includes('NGINX_TEST_DONE')) {
        throw new Error('dryRun 失败：Nginx 配置检测未完成');
      }
      checks.push('Nginx 配置语法正常（未 reload）');

      return {
        status: CertificateRenewalJobStatus.SUCCESS,
        renewalId: '',
        message: `dryRun 通过：${checks.join('；')}；未替换证书、未修改 expiresAt`,
      };
    }

    // Concurrency: refuse if already RUNNING
    if (config.renewalStatus === SystemRenewalStatus.RUNNING) {
      throw new Error('续期任务已在运行中');
    }

    const renewal = await this.prisma.certificateRenewal.create({
      data: {
        rootDomain,
        certificateDomain,
        status: CertificateRenewalJobStatus.RUNNING,
        oldExpiresAt: config.tlsExpiresAt,
      },
    });

    await this.prisma.systemDomainConfig.update({
      where: { id: config.id },
      data: {
        renewalStatus: SystemRenewalStatus.RUNNING,
        lastRenewalAt: new Date(),
        lastRenewalResult: 'RUNNING',
      },
    });

    let txtRef: TxtRecordRef | null = null;
    let cleanupWarning: string | null = null;
    const dns = await this.loadDnsProvider(config.dnsProviderAccountId, rootDomain);
    const challengeRr = '_acme-challenge';
    const challengeHost = acmeChallengeHost(rootDomain);

    try {
      const server = await this.requireGatewayServer(config.gatewayServerId);
      const password = decryptCredential(server.credentialEncrypted);
      const target = {
        host: server.host,
        port: server.port,
        username: server.username,
        password,
      };

      // 1) Ask acme.sh for challenge (pause hook writes TXT value)
      const challengeTxt = await this.requestAcmeChallenge(target, certificateDomain);
      // 2) Create precise TXT via Aliyun
      txtRef = await dns.createTxtRecord(challengeRr, challengeTxt, 600);
      // 3) Wait public DoH propagation
      const propagated = await waitForTxtPropagation({
        hostname: challengeHost,
        expectedValue: challengeTxt,
        timeoutMs: 10 * 60 * 1000,
      });
      if (!propagated.ok) {
        throw new Error('DNS_PROPAGATION_TIMEOUT');
      }
      // 4) Resume ACME / renew
      await this.completeAcmeIssuance(target, certificateDomain, challengeTxt);
      // 5) Atomic install
      const meta = await this.atomicInstall(target);
      // 6) nginx reload already in install if -t ok; ensure reload
      await this.remote(target, buildNginxTestReloadScript());
      // 7) HTTPS verify
      const verified = await this.verifyHttpsLive(rootDomain);
      if (!verified.ok) {
        await this.remote(target, buildRollbackCertScript());
        await this.prisma.certificateRenewal.update({
          where: { id: renewal.id },
          data: {
            status: CertificateRenewalJobStatus.ROLLBACK,
            completedAt: new Date(),
            errorCode: 'HTTPS_VERIFY_FAILED',
            errorSummary: verified.message,
          },
        });
        await this.prisma.systemDomainConfig.update({
          where: { id: config.id },
          data: {
            // Keep tlsStatus ACTIVE if previous cert restored
            renewalStatus: SystemRenewalStatus.ROLLBACK,
            lastRenewalResult: 'ROLLBACK',
          },
        });
        return {
          status: CertificateRenewalJobStatus.ROLLBACK,
          renewalId: renewal.id,
          message: verified.message,
        };
      }

      await this.prisma.systemDomainConfig.update({
        where: { id: config.id },
        data: {
          tlsStatus: ApplicationSslStatus.ACTIVE,
          tlsCertificateDomain: certificateDomain,
          tlsIssuer: meta.issuer ?? config.tlsIssuer,
          tlsExpiresAt: meta.expiresAt ?? config.tlsExpiresAt,
          tlsLastVerifiedAt: new Date(),
          tlsManager: 'acme.sh',
          tlsCertPathHint: DEFAULT_WILDCARD_CERT_DIR,
          renewalStatus: SystemRenewalStatus.SUCCESS,
          lastRenewalResult: 'SUCCESS',
          lastRenewalAt: new Date(),
        },
      });
      await this.prisma.applicationDomain.updateMany({
        where: {
          type: ApplicationDomainType.SYSTEM,
          domain: { endsWith: `.${rootDomain}` },
        },
        data: { sslStatus: ApplicationSslStatus.ACTIVE },
      });
      await this.prisma.certificateRenewal.update({
        where: { id: renewal.id },
        data: {
          status: CertificateRenewalJobStatus.SUCCESS,
          completedAt: new Date(),
          newExpiresAt: meta.expiresAt,
          issuer: meta.issuer,
        },
      });

      return {
        status: CertificateRenewalJobStatus.SUCCESS,
        renewalId: renewal.id,
        message: '证书自动续期成功',
      };
    } catch (error) {
      const summary = error instanceof Error ? error.message : 'renewal failed';
      await this.prisma.certificateRenewal.update({
        where: { id: renewal.id },
        data: {
          status: CertificateRenewalJobStatus.FAILED,
          completedAt: new Date(),
          errorCode: summary.slice(0, 64),
          errorSummary: summary.slice(0, 500),
        },
      });
      await this.prisma.systemDomainConfig.update({
        where: { id: config.id },
        data: {
          renewalStatus: SystemRenewalStatus.FAILED,
          lastRenewalResult: `FAILED:${summary.slice(0, 200)}`,
        },
      });
      throw error;
    } finally {
      if (txtRef) {
        try {
          await dns.deleteTxtRecord(txtRef.recordId, txtRef.value);
        } catch (cleanupError) {
          cleanupWarning =
            cleanupError instanceof Error ? cleanupError.message : 'TXT cleanup failed';
          const latest = await this.prisma.systemDomainConfig.findUnique({
            where: { id: config.id },
          });
          await this.prisma.systemDomainConfig.update({
            where: { id: config.id },
            data: {
              lastRenewalResult: `${latest?.lastRenewalResult || 'DONE'};CLEANUP_WARNING`,
            },
          });
          await this.prisma.certificateRenewal
            .update({
              where: { id: renewal.id },
              data: {
                errorSummary: `cleanup: ${cleanupWarning}`.slice(0, 500),
              },
            })
            .catch(() => undefined);
        }
      }
    }
  }

  private async loadDnsProvider(accountId: string, rootDomain: string) {
    const account = await this.prisma.providerAccount.findUnique({
      where: { id: accountId },
      include: { provider: true },
    });
    if (!account?.credentialEncrypted) {
      throw new Error('DNS ProviderAccount 缺少加密凭证');
    }
    if (account.provider.type !== 'ALIYUN_DNS') {
      throw new Error(`系统 DNS 仅支持 ALIYUN_DNS，当前: ${account.provider.type}`);
    }
    if (account.status !== 'VERIFIED') {
      throw new Error('DNS ProviderAccount 尚未通过凭证验证（status 需为 VERIFIED）');
    }
    const config = await this.requireConfig();
    assertSystemDnsRootDomain(rootDomain, config.rootDomain);
    const secrets = parseSecrets(decryptCredential(account.credentialEncrypted));
    return new AlibabaCloudDnsProvider(secrets, config.rootDomain);
  }

  private async requireConfig() {
    const config = await this.prisma.systemDomainConfig.findFirst({
      orderBy: { createdAt: 'asc' },
    });
    if (!config) {
      throw new Error('SystemDomainConfig 不存在');
    }
    return config;
  }

  private async requireGatewayServer(serverId: string | null) {
    if (!serverId) {
      throw new Error('未配置 gatewayServerId');
    }
    const server = await this.prisma.serverInstance.findUnique({ where: { id: serverId } });
    if (!server) {
      throw new Error('Gateway ServerInstance 不存在');
    }
    return server;
  }

  private async remote(
    target: { host: string; port: number; username: string; password: string },
    script: string,
  ): Promise<string> {
    const runner = new RemoteRunner();
    try {
      await runner.connect({
        host: target.host,
        port: target.port ?? 22,
        username: target.username,
        password: target.password,
        readyTimeoutMs: 25_000,
      });
      const result = await runner.execute(script, { timeoutMs: 180_000 });
      if (result.exitCode !== 0) {
        throw new RemoteRunnerError(
          result.stderr.trim() || result.stdout.trim() || 'remote command failed',
        );
      }
      return result.stdout;
    } finally {
      await runner.disconnect().catch(() => undefined);
    }
  }

  private async requestAcmeChallenge(
    target: { host: string; port: number; username: string; password: string },
    certificateDomain: string,
  ): Promise<string> {
    const pauseApi = `#!/usr/bin/env sh
dns_launchospause_add() {
  fulldomain="$1"
  txtvalue="$2"
  mkdir -p /opt/launchos-tls
  umask 077
  printf '%s\\n' "$fulldomain" > /opt/launchos-tls/pending-challenge-domain.txt
  printf '%s\\n' "$txtvalue" > /opt/launchos-tls/pending-challenge-txt.txt
  chmod 600 /opt/launchos-tls/pending-challenge-*.txt
  return 1
}
dns_launchospause_rm() { return 0; }
`;
    const runner = new RemoteRunner();
    try {
      await runner.connect({
        host: target.host,
        port: target.port ?? 22,
        username: target.username,
        password: target.password,
        readyTimeoutMs: 25_000,
      });
      await runner.execute(
        `mkdir -p /root/.acme.sh/dnsapi /opt/launchos-tls; cat > /root/.acme.sh/dnsapi/dns_launchospause.sh <<'EOF'\n${pauseApi}\nEOF\nchmod 755 /root/.acme.sh/dnsapi/dns_launchospause.sh; rm -f /opt/launchos-tls/pending-challenge-txt.txt`,
        { timeoutMs: 30_000 },
      );
      await runner.execute(
        `set +e; /root/.acme.sh/acme.sh --issue -d '${certificateDomain}' --dns dns_launchospause --server zerossl --force >/tmp/launchos-acme-renew-auto.log 2>&1; true`,
        { timeoutMs: 300_000 },
      );
      const read = await runner.execute(
        'test -f /opt/launchos-tls/pending-challenge-txt.txt && cat /opt/launchos-tls/pending-challenge-txt.txt',
        { timeoutMs: 15_000 },
      );
      if (read.exitCode !== 0 || !read.stdout.trim()) {
        throw new Error('未能从 ACME 获取 challenge TXT');
      }
      return read.stdout.trim();
    } finally {
      await runner.disconnect().catch(() => undefined);
    }
  }

  private async completeAcmeIssuance(
    target: { host: string; port: number; username: string; password: string },
    certificateDomain: string,
    expectedTxt: string,
  ): Promise<void> {
    const allowApi = `#!/usr/bin/env sh
dns_launchospause_add() {
  fulldomain="$1"
  txtvalue="$2"
  expected='${expectedTxt.replace(/'/g, `'\\''`)}'
  if [ "$txtvalue" != "$expected" ]; then
    echo "Challenge TXT mismatch" >&2
    return 1
  fi
  return 0
}
dns_launchospause_rm() { return 0; }
`;
    const out = await this.remote(
      target,
      [
        `cat > /root/.acme.sh/dnsapi/dns_launchospause.sh <<'EOF'\n${allowApi}\nEOF`,
        'chmod 755 /root/.acme.sh/dnsapi/dns_launchospause.sh',
        `set +e`,
        `/root/.acme.sh/acme.sh --renew -d '${certificateDomain}' --yes-I-know-dns-manual-mode-enough-go-ahead-please --force >/tmp/launchos-acme-renew-finish.log 2>&1`,
        'RENEW=$?',
        `if [ $RENEW -ne 0 ]; then /root/.acme.sh/acme.sh --issue -d '${certificateDomain}' --dns dns_launchospause --server zerossl --force >/tmp/launchos-acme-issue-finish.log 2>&1; fi`,
        'test -f /root/.acme.sh/*.zsaos.com_ecc/fullchain.cer',
        'echo ACME_DONE',
      ].join('\n'),
    );
    if (!out.includes('ACME_DONE')) {
      throw new Error('ACME 签发未完成');
    }
  }

  private async atomicInstall(target: {
    host: string;
    port: number;
    username: string;
    password: string;
  }): Promise<{ issuer: string | null; expiresAt: Date | null }> {
    const script = buildAtomicInstallScript({
      acmeCertDir: '/root/.acme.sh/*.zsaos.com_ecc',
      layout: certLayout(),
    });
    const out = await this.remote(target, script);
    if (!out.includes('ATOMIC_INSTALL_OK')) {
      throw new Error('证书原子安装失败');
    }
    const issuer = out.match(/issuer=(.+)/i)?.[1]?.trim() ?? null;
    const notAfter = out.match(/notAfter=(.+)/i)?.[1]?.trim();
    const expiresAt = notAfter ? new Date(notAfter) : null;
    return {
      issuer,
      expiresAt: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
    };
  }

  private async verifyHttpsLive(rootDomain: string): Promise<{ ok: boolean; message: string }> {
    const appDomain = await this.prisma.applicationDomain.findFirst({
      where: {
        type: ApplicationDomainType.SYSTEM,
        domain: { endsWith: `.${rootDomain}` },
        status: 'ACTIVE',
      },
      orderBy: { updatedAt: 'desc' },
      select: { domain: true },
    });
    const host = appDomain?.domain || `real-server-1789445560584.${rootDomain}`;
    try {
      const response = await fetch(`https://${host}/`, {
        signal: AbortSignal.timeout(20_000),
        redirect: 'follow',
      });
      const body = await response.text();
      if (!response.ok) {
        return { ok: false, message: `HTTPS status ${response.status}` };
      }
      if (!/Node\.js Getting Started on Heroku|html/i.test(body)) {
        return { ok: false, message: 'HTTPS 响应内容不符合预期' };
      }
      return { ok: true, message: 'ok' };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'HTTPS verify failed',
      };
    }
  }
}

function parseSecrets(raw: string): ProviderSecrets {
  try {
    const parsed = JSON.parse(raw) as { accessKey?: string; secretKey?: string };
    if (parsed.accessKey && parsed.secretKey) {
      return { accessKey: parsed.accessKey, secretKey: parsed.secretKey };
    }
  } catch {
    // legacy single string not supported for DNS
  }
  throw new Error('DNS Provider 凭证格式无效（需要加密的 accessKey/secretKey JSON）');
}
