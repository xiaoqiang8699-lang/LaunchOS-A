import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@launchos/database';
import { PrismaService } from '../database/prisma.service';
import { LifecycleAutomationService } from '../lifecycle/lifecycle-automation.service';

export const GROWTH_EVENTS = [
  'USER_REGISTERED',
  'WORKSPACE_CREATED',
  'PROJECT_CREATED',
  'SOURCE_CONNECTED',
  'DEPLOY_STARTED',
  'DEPLOY_SUCCESS',
  'DEPLOY_FAILED',
  'DOMAIN_CONNECTED',
  'PLAN_VIEWED',
  'PLAN_CHANGED',
] as const;

export type GrowthEventType = (typeof GROWTH_EVENTS)[number];

@Injectable()
export class ProductAnalyticsService {
  private readonly logger = new Logger(ProductAnalyticsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: LifecycleAutomationService,
  ) {}

  async track(input: {
    event: GrowthEventType | string;
    userId?: string | null;
    workspaceId?: string | null;
    projectId?: string | null;
    sessionId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      const metadata = sanitizeMetadata(input.metadata ?? {});
      const eventName = String(input.event).slice(0, 80);
      await this.prisma.productEvent.create({
        data: {
          name: eventName,
          userId: input.userId || null,
          workspaceId: input.workspaceId || null,
          projectId: input.projectId || null,
          sessionId: input.sessionId || null,
          metadata: metadata as Prisma.InputJsonValue,
        },
      });
      void this.lifecycle
        .onProductEvent({
          name: eventName,
          userId: input.userId,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          metadata,
        })
        .catch(() => undefined);
    } catch (error) {
      this.logger.warn(
        `track failed for ${input.event}: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }
}

function sanitizeMetadata(input: Record<string, unknown>): Record<string, unknown> {
  const blocked = /password|secret|token|credential|authorization|private.?key|database_url/i;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (blocked.test(key)) continue;
    if (value == null) {
      out[key] = null;
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = typeof value === 'string' ? value.slice(0, 200) : value;
      continue;
    }
  }
  return out;
}
