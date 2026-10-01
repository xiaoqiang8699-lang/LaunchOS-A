/**
 * Step 29 Phase 2 — Public Entry orchestration order, lock, audit names (no apply).
 */
import { STEP29_GATEWAY_WHITELIST } from './gateway-access.js';

export const PUBLIC_ENTRY_EXECUTION_STEPS = [
  'preflight',
  'install_or_prepare_gateway_runtime',
  'install_or_reuse_certificate',
  'create_api_gateway_route',
  'localhost_api_gateway_verification',
  'prepare_web_build_time_public_api_config',
  'build_new_web_artifact_and_docker_image',
  'deploy_new_web_revision',
  'verify_new_web_localhost_health',
  'create_web_gateway_route',
  'localhost_host_header_route_verification',
  'create_or_update_api_dns',
  'create_or_update_web_dns',
  'wait_dns_propagation',
  'verify_public_https_api',
  'verify_public_https_web',
  'activate_access_entry',
] as const;

export type PublicEntryExecutionStep = (typeof PUBLIC_ENTRY_EXECUTION_STEPS)[number];

export const PUBLIC_ENTRY_AUDIT_EVENTS = [
  'GATEWAY_INSTALL_STARTED',
  'GATEWAY_INSTALL_COMPLETED',
  'CERTIFICATE_INSTALL_STARTED',
  'CERTIFICATE_INSTALL_COMPLETED',
  'GATEWAY_ROUTE_APPLIED',
  'DNS_CHANGE_STARTED',
  'DNS_CHANGE_COMPLETED',
  'PUBLIC_ENTRY_VERIFY_STARTED',
  'PUBLIC_ENTRY_ACTIVE',
] as const;

export function publicEntryLockKey(projectId: string, serverInstanceId: string): string {
  return `public-entry:${projectId}:${serverInstanceId}`;
}

export function defaultPublicEntryLockKey(): string {
  return publicEntryLockKey(
    STEP29_GATEWAY_WHITELIST.projectId,
    STEP29_GATEWAY_WHITELIST.serverInstanceId,
  );
}

/** Access entry lifecycle for Step 29. */
export const PUBLIC_ENTRY_STATUS_FLOW = [
  'ACCESS_ENTRY_PENDING',
  'GATEWAY_PENDING',
  'CERT_PENDING',
  'DNS_PENDING',
  'READY_FOR_DNS',
  'VERIFYING',
  'ACTIVE',
  'FAILED',
] as const;

export function assertExecutionOrderIndex(step: PublicEntryExecutionStep): number {
  const idx = PUBLIC_ENTRY_EXECUTION_STEPS.indexOf(step);
  if (idx < 0) throw new Error(`unknown public entry step: ${step}`);
  return idx;
}

/** DNS must not run before local API route verification. */
export function dnsAllowedAfter(completedSteps: PublicEntryExecutionStep[]): boolean {
  return (
    completedSteps.includes('localhost_api_gateway_verification') &&
    completedSteps.includes('create_api_gateway_route')
  );
}
