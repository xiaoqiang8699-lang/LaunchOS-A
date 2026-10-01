import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import { existsSync } from 'node:fs';

import { WorkspaceRole, SystemRenewalMode } from '@launchos/database';

import {

  assertSystemDnsRootDomain,

  runLaunchosVerifyTxtCrudTest,

  SystemCertificateRenewalService,

  SystemDomainService,

  testDnsProviderConnection,

} from '@launchos/domain';

import { maskAccessKeyId, MASKED_SECRET } from '@launchos/shared';

import { PrismaService } from '../database/prisma.service';

import { ProviderAccountsService } from '../provider-accounts/provider-accounts.service';

import { decryptProviderSecrets } from '../security/credential-cipher';

import { SystemCertQueueService } from '../queue/system-cert-queue.service';

import { WorkspaceAccessService } from '../workspaces/workspace-access.service';



@Injectable()

export class SystemDomainApiService {

  private readonly core: SystemDomainService;

  private readonly certs: SystemCertificateRenewalService;



  constructor(

    private readonly prisma: PrismaService,

    private readonly workspaceAccess: WorkspaceAccessService,

    private readonly systemCertQueue: SystemCertQueueService,

    private readonly providerAccounts: ProviderAccountsService,

  ) {

    this.core = new SystemDomainService(prisma);

    this.certs = new SystemCertificateRenewalService(prisma);

  }



  async getStatus(userId: string) {

    await this.requireOwner(userId);

    return this.core.getStatus();

  }



  async verify(userId: string) {

    await this.requireOwner(userId);

    return this.core.verify();

  }



  async deployGateway(userId: string, primaryPath: string, fallbackPath: string) {

    await this.requireOwner(userId);

    const path = existsSync(primaryPath)

      ? primaryPath

      : existsSync(fallbackPath)

        ? fallbackPath

        : primaryPath;

    return this.core.deployGateway(path);

  }



  async syncRoutes(userId: string) {

    await this.requireOwner(userId);

    const table = await this.core.syncGatewayRoutes();

    return { ok: true, routes: Object.keys(table.routes).length, updatedAt: table.updatedAt };

  }



  async getCertificate(userId: string) {

    await this.requireOwner(userId);

    return this.certs.getCertificateStatus();

  }



  async getDnsProviderConfig(userId: string) {

    await this.requireOwner(userId);

    const config = await this.requireSystemConfig();

    let accountView: Record<string, unknown> | null = null;

    if (config.dnsProviderAccountId) {

      const account = await this.prisma.providerAccount.findUnique({

        where: { id: config.dnsProviderAccountId },

        include: { provider: true },

      });

      if (account?.credentialEncrypted) {

        let accessKeyMasked: string | null = null;

        try {

          const secrets = decryptProviderSecrets(account.credentialEncrypted);

          accessKeyMasked = maskAccessKeyId(secrets.accessKey);

        } catch {

          accessKeyMasked = null;

        }

        accountView = {

          id: account.id,

          label: account.label,

          status: account.status,

          providerType: account.provider.type,

          accessKeyMasked,

          secretMasked: MASKED_SECRET,

        };

      }

    }

    return {

      rootDomain: config.rootDomain,

      dnsProvider: config.dnsProvider,

      dnsProviderAccountId: config.dnsProviderAccountId,

      renewalMode: config.renewalMode,

      dnsProviderVerifiedAt: config.dnsProviderVerifiedAt?.toISOString() ?? null,

      dnsProviderTxtTestAt: config.dnsProviderTxtTestAt?.toISOString() ?? null,

      providerAccount: accountView,

      canEnableAutomatic:

        Boolean(config.dnsProviderAccountId) &&

        accountView?.status === 'VERIFIED' &&

        Boolean(config.dnsProviderTxtTestAt),

    };

  }



  async bindDnsProvider(userId: string, providerAccountId: string) {

    const membership = await this.requireOwner(userId);

    const config = await this.requireSystemConfig();



    const account = await this.providerAccounts.getByIdForWorkspace(

      providerAccountId,

      membership.workspace.id,

    );

    if (!account) {

      throw new NotFoundException('ProviderAccount 不存在');

    }

    if (account.provider.type !== 'ALIYUN_DNS') {

      throw new BadRequestException('系统 DNS 仅可绑定 ALIYUN_DNS 类型账户');

    }



    await this.prisma.systemDomainConfig.update({

      where: { id: config.id },

      data: {

        dnsProvider: 'ALIYUN',

        dnsProviderAccountId: account.id,

        renewalMode: SystemRenewalMode.MANUAL_DNS,

        dnsProviderVerifiedAt: account.status === 'VERIFIED' ? config.dnsProviderVerifiedAt : null,

        dnsProviderTxtTestAt: null,

      },

    });



    return this.getDnsProviderConfig(userId);

  }



  async verifyDnsProvider(userId: string) {

    await this.requireOwner(userId);

    const config = await this.requireSystemConfig();

    if (!config.dnsProviderAccountId) {

      throw new BadRequestException('请先绑定 DNS ProviderAccount');

    }



    const account = await this.prisma.providerAccount.findUnique({

      where: { id: config.dnsProviderAccountId },

      include: { provider: true },

    });

    if (!account?.credentialEncrypted) {

      throw new BadRequestException('ProviderAccount 缺少凭证');

    }



    assertSystemDnsRootDomain(config.rootDomain, config.rootDomain);

    const provider = this.providerAccounts.buildDnsProvider(account, config.rootDomain);

    const result = await testDnsProviderConnection(provider, config.rootDomain);



    await this.prisma.providerAccount.update({

      where: { id: account.id },

      data: { status: result.ok ? 'VERIFIED' : 'FAILED' },

    });

    if (result.ok) {

      await this.prisma.systemDomainConfig.update({

        where: { id: config.id },

        data: { dnsProviderVerifiedAt: new Date() },

      });

    }



    return {

      ok: result.ok,

      message: result.message,

      detail: result.detail,

    };

  }



  async runDnsTxtTest(userId: string) {

    await this.requireOwner(userId);

    const config = await this.requireSystemConfig();

    if (!config.dnsProviderAccountId) {

      throw new BadRequestException('请先绑定 DNS ProviderAccount');

    }



    const account = await this.prisma.providerAccount.findUnique({

      where: { id: config.dnsProviderAccountId },

      include: { provider: true },

    });

    if (!account) {

      throw new NotFoundException('ProviderAccount 不存在');

    }

    if (account.status !== 'VERIFIED') {

      throw new BadRequestException('请先完成 DNS 凭证只读验证');

    }



    assertSystemDnsRootDomain(config.rootDomain, config.rootDomain);

    const provider = this.providerAccounts.buildDnsProvider(account, config.rootDomain);

    const result = await runLaunchosVerifyTxtCrudTest(provider, config.rootDomain);



    if (result.ok) {

      await this.prisma.systemDomainConfig.update({

        where: { id: config.id },

        data: { dnsProviderTxtTestAt: new Date() },

      });

    }



    return {

      ok: result.ok,

      message: result.message,

      hostname: result.hostname,

      rr: result.rr,

      steps: result.steps.map((step) => ({

        step: step.step,

        ok: step.ok,

        message: step.message,

      })),

      detail: result.ok

        ? undefined

        : result.steps.find((step) => !step.ok && step.detail)?.detail,

    };

  }



  async enableAutomaticDns(userId: string) {

    await this.requireOwner(userId);

    const config = await this.requireSystemConfig();

    if (!config.dnsProviderAccountId) {

      throw new BadRequestException('请先绑定 DNS ProviderAccount');

    }

    if (!config.dnsProviderVerifiedAt) {

      throw new BadRequestException('请先完成 DNS 凭证只读验证');

    }

    if (!config.dnsProviderTxtTestAt) {

      throw new BadRequestException('请先完成受控 TXT CRUD 测试');

    }



    const account = await this.prisma.providerAccount.findUnique({

      where: { id: config.dnsProviderAccountId },

    });

    if (account?.status !== 'VERIFIED') {

      throw new BadRequestException('ProviderAccount 状态必须为 VERIFIED');

    }



    await this.prisma.systemDomainConfig.update({

      where: { id: config.id },

      data: {

        dnsProvider: 'ALIYUN',

        renewalMode: SystemRenewalMode.AUTOMATIC_DNS,

      },

    });



    return this.getDnsProviderConfig(userId);

  }



  async renewCertificate(

    userId: string,

    options: { force?: boolean; dryRun?: boolean } = {},

  ) {

    await this.requireOwner(userId);

    const status = await this.certs.getCertificateStatus();

    if (!status.dnsProviderConfigured || status.renewalMode !== 'AUTOMATIC_DNS') {

      throw new BadRequestException(

        '自动续期未配置：请先绑定最小权限 ALIYUN_DNS ProviderAccount，并完成验证后将 renewalMode 设为 AUTOMATIC_DNS',

      );

    }

    const config = await this.prisma.systemDomainConfig.findFirst({

      orderBy: { createdAt: 'asc' },

      select: { rootDomain: true },

    });

    if (!config) {

      throw new BadRequestException('SystemDomainConfig 不存在');

    }



    if (options.dryRun) {

      return this.certs.renew({ dryRun: true, force: options.force });

    }



    const queued = await this.systemCertQueue.enqueueRenew({

      rootDomain: config.rootDomain,

      force: options.force,

      dryRun: false,

    });

    return {

      queued: queued.queued,

      jobId: queued.jobId,

      message: queued.queued

        ? '续期任务已入队'

        : '续期任务已在队列中（同根域名去重）',

    };

  }



  /** Used by apps start/stop without owner check — internal sync */

  async syncRoutesInternal() {

    return this.core.syncGatewayRoutes();

  }



  private async requireSystemConfig() {

    const config = await this.prisma.systemDomainConfig.findFirst({

      orderBy: { createdAt: 'asc' },

    });

    if (!config) {

      throw new BadRequestException('SystemDomainConfig 不存在');

    }

    return config;

  }



  private async requireOwner(userId: string) {

    const membership = await this.workspaceAccess.requireCurrentWorkspace(userId);

    if (membership.role !== WorkspaceRole.OWNER && membership.role !== WorkspaceRole.ADMIN) {

      throw new ForbiddenException('仅工作区管理员可管理平台域名');

    }

    return membership;

  }

}

