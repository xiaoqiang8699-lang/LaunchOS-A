import type { PrismaClient } from '@launchos/database';
import { processSubscriptionLifecycle } from '@launchos/domain';

const LIFECYCLE_MS = 60_000;

export function startSubscriptionLifecycle(prisma: PrismaClient): () => void {
  const tick = () => {
    void processSubscriptionLifecycle(prisma).catch((error) => {
      console.error('subscription lifecycle failed', error instanceof Error ? error.message : error);
    });
  };
  tick();
  const timer = setInterval(tick, LIFECYCLE_MS);
  return () => clearInterval(timer);
}
