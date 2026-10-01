import { Injectable } from '@nestjs/common';
import { ServerScope } from '@launchos/database';
import { pickPlatformManagedNode } from '@launchos/shared';
import { PrismaService } from '../database/prisma.service';

export const NO_MANAGED_HOST_AVAILABLE = 'NO_MANAGED_HOST_AVAILABLE';
export const NO_MANAGED_HOST_MESSAGE = '托管资源暂时不可用，请稍后再试。';

@Injectable()
export class ManagedHostingSchedulerService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Choose one LaunchOS platform node.
   * Never looks at a workspace's own ALIYUN or CUSTOM servers.
   */
  async allocate(
    preferServerInstanceId?: string,
  ): Promise<{ serverInstanceId: string } | { code: typeof NO_MANAGED_HOST_AVAILABLE }> {
    const nodes = await this.prisma.serverInstance.findMany({
      where: { scope: ServerScope.PLATFORM_MANAGED },
      orderBy: { updatedAt: 'asc' },
      select: {
        id: true,
        scope: true,
        status: true,
        dockerStatus: true,
        updatedAt: true,
        metadata: true,
      },
    });
    const preferred = preferServerInstanceId
      ? nodes.find((node) => node.id === preferServerInstanceId)
      : undefined;
    const picked = (preferred && pickPlatformManagedNode([preferred])) || pickPlatformManagedNode(nodes);
    if (!picked) {
      return { code: NO_MANAGED_HOST_AVAILABLE };
    }
    return { serverInstanceId: picked.id };
  }
}
