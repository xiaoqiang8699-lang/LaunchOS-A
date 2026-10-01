import {
  DATABASE_PROVISION_QUEUE,
  DEPLOYMENT_QUEUE,
  REDIS_PROVISION_QUEUE,
  SERVER_INITIALIZATION_QUEUE,
  SERVER_PROVISION_QUEUE,
  SYSTEM_CERT_QUEUE,
  WORKER_ONLINE_THRESHOLD_MS,
} from './queue';

export type WorkerProfile = 'deployment' | 'provisioning' | 'all';

const DEPLOYMENT_PROFILE_QUEUES = [DEPLOYMENT_QUEUE, SYSTEM_CERT_QUEUE] as const;
const PROVISIONING_PROFILE_QUEUES = [
  DATABASE_PROVISION_QUEUE,
  REDIS_PROVISION_QUEUE,
  SERVER_PROVISION_QUEUE,
  SERVER_INITIALIZATION_QUEUE,
] as const;

export const BILLABLE_PROVISION_QUEUES = [
  SERVER_PROVISION_QUEUE,
  DATABASE_PROVISION_QUEUE,
  REDIS_PROVISION_QUEUE,
] as const;

export function resolveWorkerProfile(raw: string | undefined | null): WorkerProfile {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return 'all';
  if (value === 'deployment' || value === 'provisioning' || value === 'all') {
    return value;
  }
  throw new Error(`WORKER_PROFILE_INVALID:${value}`);
}

export function queuesForWorkerProfile(profile: WorkerProfile): string[] {
  if (profile === 'deployment') return [...DEPLOYMENT_PROFILE_QUEUES];
  if (profile === 'provisioning') return [...PROVISIONING_PROFILE_QUEUES];
  return [...DEPLOYMENT_PROFILE_QUEUES, ...PROVISIONING_PROFILE_QUEUES];
}

export function workerProfileConsumes(profile: WorkerProfile, queue: string): boolean {
  return queuesForWorkerProfile(profile).includes(queue);
}

export function isWorkerHeartbeatFresh(input: {
  status?: string | null;
  lastSeenAt: Date | string | number;
  now?: number;
}): boolean {
  if (String(input.status || '').toUpperCase() === 'OFFLINE') return false;
  const seen = new Date(input.lastSeenAt).getTime();
  if (!Number.isFinite(seen)) return false;
  const now = input.now ?? Date.now();
  return now - seen <= WORKER_ONLINE_THRESHOLD_MS;
}

export function isDeploymentCapableWorker(input: {
  status?: string | null;
  lastSeenAt: Date | string | number;
  queueReady?: { deployment?: boolean } | null;
  now?: number;
}): boolean {
  return isWorkerHeartbeatFresh(input) && input.queueReady?.deployment === true;
}
