import { BadRequestException, Injectable } from '@nestjs/common';
import {
  CloudResourceStatus,
  CloudResourceType,
  Prisma,
} from '@launchos/database';
import {
  ALIYUN_PROVIDER_TYPE,
  createCloudProvider,
  instanceTypesForPlan,
} from '@launchos/providers';
import { PrismaService } from '../database/prisma.service';
import { ProviderAccountsService } from '../provider-accounts/provider-accounts.service';
import {
  ALIYUN_PROVIDER_TYPE as ALIYUN_ACCOUNT_TYPE,
  MOCK_PROVIDER_TYPE,
} from '../provider-accounts/dto/create-provider-account.dto';
import { encryptCredential, encryptProviderSecrets } from '../security/credential-cipher';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import type { CreateCloudResourceDto } from './dto/create-cloud-resource.dto';

const resourceSelect = {
  id: true,
  workspaceId: true,
  projectId: true,
  providerId: true,
  type: true,
  externalId: true,
  providerResourceId: true,
  publicIp: true,
  region: true,
  instanceType: true,
  status: true,
  metadata: true,
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
export class CloudResourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaceAccess: WorkspaceAccessService,
    private readonly providerAccounts: ProviderAccountsService,
  ) {}

  async create(userId: string, dto: CreateCloudResourceDto) {
    const membership = await this.workspaceAccess.requireCurrentWorkspace(userId);
    this.workspaceAccess.requireWriteAccess(membership.role);

    const type = dto.type ?? CloudResourceType.SERVER;
    if (type !== CloudResourceType.SERVER) {
      throw new BadRequestException('Only SERVER resources are supported');
    }

    const account = await this.prisma.providerAccount.findFirst({
      where: {
        workspaceId: membership.workspace.id,
        status: 'ACTIVE',
        provider: { type: MOCK_PROVIDER_TYPE },
      },
      include: { provider: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!account) {
      throw new BadRequestException('No Mock provider account in this workspace');
    }

    const region = dto.region?.trim() || account.region || 'local';
    const cloud = createCloudProvider(account.provider.type);
    const server = await cloud.createServer({ region });

    return sanitizeResource(
      await this.prisma.cloudResource.create({
      data: {
        workspaceId: membership.workspace.id,
        providerId: account.providerId,
        type: CloudResourceType.SERVER,
        externalId: server.externalId,
        providerResourceId: server.externalId,
        publicIp: server.ip,
        instanceType: server.instanceType || 'mock.local',
        status: CloudResourceStatus.RUNNING,
        region: server.region,
        metadata: {
          provider: account.provider.type,
        },
      },
      select: resourceSelect,
    }),
    );
  }

  async createFromRecommendation(userId: string, projectId: string) {
    const { membership, project } = await this.workspaceAccess.requireProjectAccess(
      userId,
      projectId,
    );
    this.workspaceAccess.requireWriteAccess(membership.role);

    const recommendation = await this.prisma.resourceRecommendation.findFirst({
      where: { projectId: project.id },
      orderBy: { createdAt: 'desc' },
      include: { plan: true },
    });
    if (!recommendation) {
      throw new BadRequestException('Resource recommendation is required');
    }

    const existing = await this.prisma.cloudResource.findFirst({
      where: {
        projectId: project.id,
        type: CloudResourceType.SERVER,
        status: { in: [CloudResourceStatus.CREATING, CloudResourceStatus.RUNNING] },
      },
      orderBy: { createdAt: 'desc' },
      select: resourceSelect,
    });
    if (existing) {
      return sanitizeResource(existing);
    }

    const account = await this.requireAliyunAccount(membership.workspace.id);
    const secrets = await this.providerAccounts.decryptSecrets(account.credentialEncrypted);
    const region = account.region?.trim() || 'cn-hangzhou';
    const instanceType = instanceTypesForPlan(recommendation.plan.cpu, recommendation.plan.memory);
    const diskSizeGb = parseDiskGb(recommendation.plan.storage);

    const created = await this.prisma.cloudResource.create({
      data: {
        workspaceId: membership.workspace.id,
        projectId: project.id,
        providerId: account.providerId,
        type: CloudResourceType.SERVER,
        externalId: 'pending',
        providerResourceId: null,
        publicIp: null,
        instanceType,
        region,
        status: CloudResourceStatus.CREATING,
        metadata: {
          provider: ALIYUN_PROVIDER_TYPE,
          planName: recommendation.plan.name,
          recommendationId: recommendation.id,
        },
      },
      select: resourceSelect,
    });

    try {
      const cloud = createCloudProvider(ALIYUN_PROVIDER_TYPE, {
        accessKey: secrets.accessKey,
        secretKey: secrets.secretKey,
        region,
      });
      const server = await cloud.createServer({
        region,
        name: `launchos-${project.slug}`.slice(0, 64),
        instanceType,
        diskSizeGb,
      });
      const status = mapServerStatus(server.status);
      return sanitizeResource(
        await this.prisma.cloudResource.update({
        where: { id: created.id },
        data: {
          externalId: server.externalId,
          providerResourceId: server.externalId,
          publicIp: server.ip,
          instanceType: server.instanceType || instanceType,
          region: server.region,
          status,
          metadata: withSshMetadata(
            {
              provider: ALIYUN_PROVIDER_TYPE,
              planName: recommendation.plan.name,
              recommendationId: recommendation.id,
            },
            server,
          ) as Prisma.InputJsonObject,
        },
        select: resourceSelect,
      }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create server';
      await this.prisma.cloudResource.update({
        where: { id: created.id },
        data: {
          status: CloudResourceStatus.FAILED,
          metadata: {
            provider: ALIYUN_PROVIDER_TYPE,
            planName: recommendation.plan.name,
            recommendationId: recommendation.id,
            error: message,
          },
        },
      });
      throw new BadRequestException(message);
    }
  }

  async list(userId: string) {
    const membership = await this.workspaceAccess.requireCurrentWorkspace(userId);
    return (await this.prisma.cloudResource.findMany({
      where: { workspaceId: membership.workspace.id },
      orderBy: { createdAt: 'desc' },
      select: resourceSelect,
    })).map(sanitizeResource);
  }

  async listByProject(userId: string, projectId: string) {
    const { project } = await this.workspaceAccess.requireProjectAccess(userId, projectId);
    return (await this.prisma.cloudResource.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: 'desc' },
      select: resourceSelect,
    })).map(sanitizeResource);
  }

  private async requireAliyunAccount(workspaceId: string) {
    const existing = await this.prisma.providerAccount.findFirst({
      where: {
        workspaceId,
        status: 'ACTIVE',
        provider: { type: ALIYUN_ACCOUNT_TYPE },
      },
      include: { provider: true },
      orderBy: { createdAt: 'asc' },
    });
    if (existing) {
      return existing;
    }

    const accessKey = process.env.ALIYUN_ACCESS_KEY_ID?.trim();
    const secretKey = process.env.ALIYUN_ACCESS_KEY_SECRET?.trim();
    const region = process.env.ALIYUN_REGION?.trim() || 'cn-hangzhou';
    if (!accessKey || !secretKey) {
      throw new BadRequestException('Aliyun provider account is required');
    }

    const provider = await this.prisma.provider.upsert({
      where: { type: ALIYUN_ACCOUNT_TYPE },
      update: { name: 'Alibaba Cloud' },
      create: {
        name: 'Alibaba Cloud',
        type: ALIYUN_ACCOUNT_TYPE,
      },
    });

    return this.prisma.providerAccount.create({
      data: {
        workspaceId,
        providerId: provider.id,
        region,
        credentialEncrypted: encryptProviderSecrets({ accessKey, secretKey }),
        status: 'ACTIVE',
      },
      include: { provider: true },
    });
  }
}

function parseDiskGb(storage: string): number {
  const parsed = Number.parseInt(storage, 10);
  if (!Number.isFinite(parsed) || parsed < 40) {
    return 40;
  }
  return parsed;
}

function mapServerStatus(status: string): CloudResourceStatus {
  if (status === 'RUNNING') {
    return CloudResourceStatus.RUNNING;
  }
  if (status === 'STOPPED') {
    return CloudResourceStatus.STOPPED;
  }
  if (status === 'FAILED') {
    return CloudResourceStatus.FAILED;
  }
  return CloudResourceStatus.CREATING;
}

function asMetadataRecord(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {};
  }
  return { ...(metadata as Record<string, unknown>) };
}

function publicMetadata(metadata: unknown): Record<string, unknown> {
  const record = asMetadataRecord(metadata);
  delete record.sshPasswordEncrypted;
  return record;
}

function withSshMetadata(
  metadata: Record<string, unknown>,
  server: { username?: string; loginPassword?: string },
): Record<string, unknown> {
  const password = server.loginPassword?.trim();
  if (!password) {
    return metadata;
  }
  return {
    ...metadata,
    sshUsername: server.username?.trim() || 'root',
    sshPort: 22,
    sshPasswordEncrypted: encryptCredential(password),
  };
}

function sanitizeResource<T extends { metadata: unknown }>(resource: T): T & { metadata: Record<string, unknown> } {
  return {
    ...resource,
    metadata: publicMetadata(resource.metadata),
  };
}
