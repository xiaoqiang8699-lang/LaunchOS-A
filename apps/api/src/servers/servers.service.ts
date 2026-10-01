import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ServerScope } from '@launchos/database';
import { RemoteDockerRuntime, RuntimeError } from '@launchos/runtime';
import { PrismaService } from '../database/prisma.service';
import { decryptCredential, encryptCredential } from '../security/credential-cipher';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import type { CreateServerDto } from './dto/create-server.dto';

const publicSelect = {
  id: true,
  workspaceId: true,
  name: true,
  host: true,
  port: true,
  username: true,
  provider: true,
  status: true,
  dockerStatus: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class ServersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaceAccess: WorkspaceAccessService,
  ) {}

  async create(userId: string, dto: CreateServerDto) {
    const membership = await this.workspaceAccess.requireCurrentWorkspace(userId);
    this.workspaceAccess.requireWriteAccess(membership.role);

    const server = await this.prisma.serverInstance.create({
      data: {
        workspaceId: membership.workspace.id,
        scope: ServerScope.WORKSPACE_OWNED,
        name: dto.name.trim(),
        host: dto.host.trim(),
        port: dto.port ?? 22,
        username: dto.username.trim(),
        credentialEncrypted: encryptCredential(dto.password),
        provider: dto.provider?.trim() || 'CUSTOM',
        status: 'CREATED',
        dockerStatus: 'UNKNOWN',
      },
      select: publicSelect,
    });
    return server;
  }

  async list(userId: string) {
    const membership = await this.workspaceAccess.requireCurrentWorkspace(userId);
    return this.prisma.serverInstance.findMany({
      where: {
        workspaceId: membership.workspace.id,
        scope: ServerScope.WORKSPACE_OWNED,
      },
      orderBy: { createdAt: 'desc' },
      select: publicSelect,
    });
  }

  async getById(userId: string, id: string) {
    await this.requireServer(userId, id);
    const server = await this.prisma.serverInstance.findUnique({
      where: { id },
      select: publicSelect,
    });
    if (!server) {
      throw new NotFoundException('服务器不存在');
    }
    return server;
  }

  async remove(userId: string, id: string) {
    const { membership } = await this.requireServer(userId, id);
    this.workspaceAccess.requireWriteAccess(membership.role);
    await this.prisma.serverInstance.delete({ where: { id } });
  }

  async testConnection(userId: string, id: string) {
    const { membership } = await this.requireServer(userId, id);
    this.workspaceAccess.requireWriteAccess(membership.role);

    const record = await this.prisma.serverInstance.findUnique({
      where: { id },
    });
    if (!record) {
      throw new NotFoundException('服务器不存在');
    }

    try {
      const runtime = new RemoteDockerRuntime({
        host: record.host,
        port: record.port,
        username: record.username,
        password: decryptCredential(record.credentialEncrypted),
      });
      const probe = await runtime.probe();
      const updated = await this.prisma.serverInstance.update({
        where: { id },
        data: {
          status: probe.canDeploy ? 'CONNECTED' : 'CONNECTED',
          dockerStatus: probe.dockerStatus,
        },
        select: publicSelect,
      });
      return {
        ...updated,
        osVersion: probe.osVersion,
        dockerVersion: probe.dockerVersion,
        connected: probe.connected,
        diagnosis: {
          stage: probe.stage,
          canDeploy: probe.canDeploy,
          summary: probe.summary,
          checks: probe.checks,
          technicalDetail: probe.technicalDetail ?? null,
        },
      };
    } catch (error) {
      await this.prisma.serverInstance.update({
        where: { id },
        data: {
          status: 'UNREACHABLE',
          dockerStatus: 'ERROR',
        },
      });
      const technical =
        error instanceof RuntimeError
          ? error.message
          : error instanceof Error
            ? error.message
            : '连接失败';
      const updated = await this.prisma.serverInstance.findUniqueOrThrow({
        where: { id },
        select: publicSelect,
      });
      return {
        ...updated,
        osVersion: '',
        dockerVersion: null,
        connected: false,
        diagnosis: {
          stage: 'ssh' as const,
          canDeploy: false,
          summary: '服务器无法连接',
          checks: [
            '服务器无法连接',
            '请检查：IP',
            '请检查：端口',
            '请检查：账号',
            '请检查：密码',
            '请检查：防火墙',
          ],
          technicalDetail: technical,
        },
      };
    }
  }

  private async requireServer(userId: string, id: string) {
    const server = await this.prisma.serverInstance.findUnique({
      where: { id },
      select: { id: true, workspaceId: true, scope: true },
    });
    if (!server || !server.workspaceId || server.scope !== ServerScope.WORKSPACE_OWNED) {
      throw new NotFoundException('服务器不存在');
    }
    const membership = await this.workspaceAccess.requireWorkspaceMembership(
      userId,
      server.workspaceId,
    );
    return { server, membership };
  }
}
