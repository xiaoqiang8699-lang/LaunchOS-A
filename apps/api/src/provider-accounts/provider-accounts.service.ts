import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import {

  AlibabaCloudDnsProvider,

  assertSystemDnsRootDomain,

  testDnsProviderConnection,

} from '@launchos/domain';

import { maskAccessKeyId, MASKED_SECRET } from '@launchos/shared';

import { PrismaService } from '../database/prisma.service';

import {

  decryptProviderSecrets,

  encryptProviderSecrets,

  type ProviderSecrets,

} from '../security/credential-cipher';

import { WorkspaceAccessService } from '../workspaces/workspace-access.service';

import {

  ALIYUN_DNS_PROVIDER_TYPE,

  ALIYUN_PROVIDER_TYPE,

  type CreateProviderAccountDto,

} from './dto/create-provider-account.dto';



const accountSelect = {

  id: true,

  workspaceId: true,

  providerId: true,

  label: true,

  region: true,

  status: true,

  credentialEncrypted: true,

  createdAt: true,

  updatedAt: true,

  provider: {

    select: {

      id: true,

      name: true,

      type: true,

    },

  },

} as const;



@Injectable()

export class ProviderAccountsService {

  constructor(

    private readonly prisma: PrismaService,

    private readonly workspaceAccess: WorkspaceAccessService,

  ) {}



  async create(userId: string, dto: CreateProviderAccountDto) {

    const membership = await this.workspaceAccess.requireCurrentWorkspace(userId);

    this.workspaceAccess.requireWriteAccess(membership.role);



    const providerType = dto.providerType;

    const secrets = readSecrets(dto);

    const provider = await this.prisma.provider.upsert({

      where: { type: providerType },

      update: { name: providerDisplayName(providerType) },

      create: {

        name: providerDisplayName(providerType),

        type: providerType,

      },

    });



    const existing = await this.prisma.providerAccount.findUnique({

      where: {

        workspaceId_providerId: {

          workspaceId: membership.workspace.id,

          providerId: provider.id,

        },

      },

    });

    if (existing) {

      throw new ConflictException('Provider account already exists');

    }



    const credentialEncrypted = encryptProviderSecrets(secrets);

    decryptProviderSecrets(credentialEncrypted);



    const created = await this.prisma.providerAccount.create({

      data: {

        workspaceId: membership.workspace.id,

        providerId: provider.id,

        label: dto.label?.trim() || null,

        region: dto.region?.trim() || defaultRegion(providerType),

        credentialEncrypted,

        status: providerType === ALIYUN_DNS_PROVIDER_TYPE ? 'PENDING' : 'ACTIVE',

      },

      select: accountSelect,

    });



    return toPublicAccount(created);

  }



  async list(userId: string) {

    const membership = await this.workspaceAccess.requireCurrentWorkspace(userId);

    const accounts = await this.prisma.providerAccount.findMany({

      where: { workspaceId: membership.workspace.id },

      orderBy: { createdAt: 'asc' },

      select: accountSelect,

    });

    return accounts.map(toPublicAccount);

  }



  async verifyDnsConnection(userId: string, accountId: string, rootDomain: string) {

    const membership = await this.workspaceAccess.requireCurrentWorkspace(userId);

    this.workspaceAccess.requireWriteAccess(membership.role);



    const account = await this.prisma.providerAccount.findFirst({

      where: { id: accountId, workspaceId: membership.workspace.id },

      include: { provider: true },

    });

    if (!account) {

      throw new NotFoundException('Provider account not found');

    }

    if (account.provider.type !== ALIYUN_DNS_PROVIDER_TYPE) {

      throw new BadRequestException('仅 ALIYUN_DNS 账户支持 DNS 凭证验证');

    }



    const config = await this.prisma.systemDomainConfig.findFirst({

      orderBy: { createdAt: 'asc' },

      select: { rootDomain: true },

    });

    const systemRoot = config?.rootDomain?.trim();

    if (!systemRoot) {

      throw new BadRequestException('SystemDomainConfig 未配置根域名');

    }

    assertSystemDnsRootDomain(rootDomain, systemRoot);



    const secrets = await this.decryptSecrets(account.credentialEncrypted);

    const provider = new AlibabaCloudDnsProvider(secrets, systemRoot);

    const result = await testDnsProviderConnection(provider, systemRoot);



    await this.prisma.providerAccount.update({

      where: { id: account.id },

      data: {

        status: result.ok ? 'VERIFIED' : 'FAILED',

      },

    });



    if (result.ok) {

      await this.prisma.systemDomainConfig.updateMany({

        where: { rootDomain: systemRoot },

        data: { dnsProviderVerifiedAt: new Date() },

      });

    }



    return {

      ok: result.ok,

      message: result.message,

      status: result.ok ? 'VERIFIED' : 'FAILED',

      recordCount: result.recordCount,

      detail: result.detail,

    };

  }



  async getByIdForWorkspace(accountId: string, workspaceId: string) {
    return this.prisma.providerAccount.findFirst({
      where: { id: accountId, workspaceId },
      include: { provider: true },
    });
  }

  /**
   * Probe capabilities for an ALIYUN (cloud) account only — never ALIYUN_DNS.
   */
  async getCapabilities(userId: string, accountId: string) {
    const membership = await this.workspaceAccess.requireCurrentWorkspace(userId);
    const account = await this.prisma.providerAccount.findFirst({
      where: { id: accountId, workspaceId: membership.workspace.id },
      include: { provider: true },
    });
    if (!account) {
      throw new NotFoundException('Provider account not found');
    }
    if (account.provider.type === ALIYUN_DNS_PROVIDER_TYPE) {
      throw new BadRequestException({
        message: 'DNS 账户不用于云资源（ECS/RDS）权限检测，请使用阿里云云资源账户。',
        code: 'WRONG_PROVIDER_TYPE',
      });
    }
    if (account.provider.type !== ALIYUN_PROVIDER_TYPE) {
      throw new BadRequestException('仅阿里云云资源账户支持能力检测');
    }
    if (!account.credentialEncrypted) {
      const { AlibabaCloudCapabilityService } = await import('@launchos/providers');
      const service = new AlibabaCloudCapabilityService();
      return sanitizeCapabilityReport(
        await service.probe({ accessKey: '', secretKey: '', region: account.region || undefined }),
      );
    }
    const secrets = await this.decryptSecrets(account.credentialEncrypted);
    const { AlibabaCloudCapabilityService } = await import('@launchos/providers');
    const service = new AlibabaCloudCapabilityService();
    const report = await service.probe({
      accessKey: secrets.accessKey,
      secretKey: secrets.secretKey,
      region: account.region || undefined,
    });
    return sanitizeCapabilityReport(report);
  }

  /** Workspace-level Aliyun cloud readiness (ALIYUN only, never DNS). */
  async getAliyunReadiness(userId: string) {
    const membership = await this.workspaceAccess.requireCurrentWorkspace(userId);
    const account = await this.prisma.providerAccount.findFirst({
      where: {
        workspaceId: membership.workspace.id,
        status: 'ACTIVE',
        provider: { type: ALIYUN_PROVIDER_TYPE },
      },
      include: { provider: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!account) {
      return {
        provider: 'ALIYUN' as const,
        credentialsConfigured: false,
        accountId: null,
        message: '未配置阿里云云资源账户（ProviderAccount ALIYUN）',
        capabilities: {
          ecs: { status: 'NOT_CONFIGURED' },
          rds: { status: 'NOT_CONFIGURED', missingCapabilities: ['创建数据库'] },
          vpc: { status: 'NOT_CONFIGURED' },
        },
        labels: [
          { key: 'ecs', label: '云服务器', status: 'NOT_CONFIGURED', statusLabel: '未配置' },
          {
            key: 'rds',
            label: 'PostgreSQL 数据库',
            status: 'NOT_CONFIGURED',
            statusLabel: '未配置',
          },
          { key: 'vpc', label: '网络读取', status: 'NOT_CONFIGURED', statusLabel: '未配置' },
        ],
        rdsCreateBlocked: true,
      };
    }
    const report = await this.getCapabilities(userId, account.id);
    const createStatus =
      (report.capabilities as { rds?: { actions?: { create?: string }; status?: string } }).rds
        ?.actions?.create ||
      (report.capabilities as { rds?: { status?: string } }).rds?.status;
    const rdsCreateBlocked =
      createStatus === 'MISSING_PERMISSION' ||
      createStatus === 'NOT_CONFIGURED' ||
      !report.credentialsConfigured;
    return {
      ...report,
      accountId: account.id,
      rdsCreateBlocked,
    };
  }

  async updateAliyunCredentials(
    userId: string,
    accountId: string,
    body: { accessKey?: string; secretKey?: string; region?: string; label?: string },
  ) {
    const membership = await this.workspaceAccess.requireCurrentWorkspace(userId);
    this.workspaceAccess.requireWriteAccess(membership.role);
    const account = await this.prisma.providerAccount.findFirst({
      where: { id: accountId, workspaceId: membership.workspace.id },
      include: { provider: true },
    });
    if (!account) throw new NotFoundException('Provider account not found');
    if (account.provider.type !== ALIYUN_PROVIDER_TYPE) {
      throw new BadRequestException('仅可更新阿里云云资源账户凭证');
    }
    const data: {
      region?: string;
      label?: string | null;
      credentialEncrypted?: string;
      status?: string;
    } = {};
    if (body.region?.trim()) data.region = body.region.trim();
    if (body.label !== undefined) data.label = body.label.trim() || null;
    if (body.accessKey?.trim() && body.secretKey?.trim()) {
      data.credentialEncrypted = encryptProviderSecrets({
        accessKey: body.accessKey.trim(),
        secretKey: body.secretKey.trim(),
      });
      data.status = 'ACTIVE';
    } else if (body.accessKey || body.secretKey) {
      throw new BadRequestException('更新凭证时需同时提供 AccessKey 与 Secret');
    }
    const updated = await this.prisma.providerAccount.update({
      where: { id: account.id },
      data,
      select: accountSelect,
    });
    return toPublicAccount(updated);
  }

  async decryptSecrets(encrypted: string | null): Promise<ProviderSecrets> {

    if (!encrypted) {

      throw new BadRequestException('Provider account is missing credentials');

    }

    return decryptProviderSecrets(encrypted);

  }



  buildDnsProvider(account: { credentialEncrypted: string | null }, rootDomain: string) {

    const secrets = decryptProviderSecrets(account.credentialEncrypted!);

    return new AlibabaCloudDnsProvider(secrets, rootDomain);

  }

}



function readSecrets(dto: CreateProviderAccountDto): ProviderSecrets {

  if (dto.providerType === ALIYUN_PROVIDER_TYPE || dto.providerType === ALIYUN_DNS_PROVIDER_TYPE) {

    const accessKey = dto.accessKey?.trim();

    const secretKey = dto.secretKey?.trim();

    if (!accessKey || !secretKey) {

      throw new BadRequestException('accessKey and secretKey are required');

    }

    return { accessKey, secretKey };

  }



  const accessKey = dto.accessKey?.trim() || 'mock';

  const secretKey = dto.secretKey?.trim() || dto.credential?.trim();

  if (!secretKey) {

    throw new BadRequestException('credential is required');

  }

  return { accessKey, secretKey };

}



function defaultRegion(type: string): string {

  return type === ALIYUN_PROVIDER_TYPE || type === ALIYUN_DNS_PROVIDER_TYPE

    ? 'cn-hangzhou'

    : 'local';

}



function providerDisplayName(type: string): string {

  if (type === ALIYUN_DNS_PROVIDER_TYPE) {

    return 'Alibaba Cloud DNS';

  }

  return type === ALIYUN_PROVIDER_TYPE ? 'Alibaba Cloud' : 'Mock Provider';

}



function toPublicAccount(account: {

  id: string;

  workspaceId: string;

  providerId: string;

  label: string | null;

  region: string | null;

  status: string;

  credentialEncrypted: string | null;

  createdAt: Date;

  updatedAt: Date;

  provider: { id: string; name: string; type: string };

}) {

  let accessKeyMasked: string | null = null;

  if (account.credentialEncrypted && isDnsOrAliyun(account.provider.type)) {

    try {

      const secrets = decryptProviderSecrets(account.credentialEncrypted);

      accessKeyMasked = maskAccessKeyId(secrets.accessKey);

    } catch {

      accessKeyMasked = null;

    }

  }



  return {

    id: account.id,

    workspaceId: account.workspaceId,

    providerId: account.providerId,

    label: account.label,

    region: account.region,

    status: account.status,

    hasCredential: Boolean(account.credentialEncrypted),

    accessKeyMasked,

    secretMasked: account.credentialEncrypted ? MASKED_SECRET : null,

    createdAt: account.createdAt,

    updatedAt: account.updatedAt,

    provider: account.provider,

  };

}



function isDnsOrAliyun(type: string): boolean {
  return type === ALIYUN_DNS_PROVIDER_TYPE || type === ALIYUN_PROVIDER_TYPE;
}

function sanitizeCapabilityReport(report: {
  provider: string;
  credentialsConfigured: boolean;
  region: string;
  capabilities: Record<string, unknown>;
  labels: Array<{ key: string; label: string; status: string; statusLabel: string }>;
}) {
  // Ensure no credential fields ever leak.
  const json = JSON.stringify(report);
  if (/accessKey|secretKey|credentialEncrypted/i.test(json)) {
    throw new Error('capability report leaked secrets');
  }
  return report;
}

