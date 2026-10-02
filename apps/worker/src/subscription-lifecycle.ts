import type { PrismaClient } from '@launchos/database';
import { processSubscriptionLifecycle } from '@launchos/domain';

/**
 * Alpha uses a 60s tick for faster grace/change-request verification.
 * Production cadence may be hourly — ticks remain idempotent either way.
 * Does not touch deployment/cert queues.
 */
const LIFECYCLE_MS = 60_000;

export function startSubscriptionLifecycle(prisma: PrismaClient): () => void {
  const tick = () => {
    void processSubscriptionLifecycle(prisma)
      .then((result) => {
        if (result.processed > 0 || result.changeRequestsApplied > 0) {
          console.log(
            `subscription lifecycle: processed=${result.processed} changeRequests=${result.changeRequestsApplied}`,
          );
        }
      })
      .catch((error) => {
        console.error('subscription lifecycle failed', error instanceof Error ? error.message : error);
      });
  };
  tick();
  const timer = setInterval(tick, LIFECYCLE_MS);
  return () => clearInterval(timer);
}
