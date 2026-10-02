import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ActivationProjectionService } from './activation-projection.service';

@Injectable()
export class ActivationBackfillService {
  private readonly logger = new Logger(ActivationBackfillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly projection: ActivationProjectionService,
  ) {}

  async backfillAll(limit = 2000) {
    const users = await this.prisma.user.findMany({
      select: { id: true },
      take: limit,
      orderBy: { createdAt: 'asc' },
    });

    let processed = 0;
    let activated = 0;
    let blocked = 0;
    let atRisk = 0;
    let errors = 0;

    for (const u of users) {
      try {
        const state = await this.projection.projectUser(u.id);
        processed += 1;
        if (!state) continue;
        if (state.status === 'ACTIVATED') activated += 1;
        else if (state.status === 'BLOCKED') blocked += 1;
        else if (state.status === 'AT_RISK') atRisk += 1;
      } catch (error) {
        errors += 1;
        this.logger.warn(
          `backfill user ${u.id}: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      }
    }

    return {
      scanned: users.length,
      processed,
      activated,
      blocked,
      atRisk,
      errors,
      idempotent: true,
      note: '未修改 Deployment 历史，未触发部署/消息/支付。',
    };
  }
}
