/**
 * Step 29 Phase 3B — DNS activation planning, reconcile, propagation, public verify (no writes).
 */
import { ALIYUN_DNS_DEFAULT_TTL, normalizeAliyunDnsTtl } from './alibaba-dns-provider.js';
import { planDnsARecord, type DnsApplyAction, type DnsApplyPlan, type DnsRecordSnapshot } from './dns-apply-plan.js';
import { STEP29_GATEWAY_WHITELIST } from './gateway-access.js';

/** Phase 3A end-state runtime facts for Phase 3B gate (DB remains source of truth at runtime). */
export const STEP29_PHASE3B_BASELINE = {
  projectId: STEP29_GATEWAY_WHITELIST.projectId,
  serverInstanceId: STEP29_GATEWAY_WHITELIST.serverInstanceId,
  publicIp: STEP29_GATEWAY_WHITELIST.publicIp,
  rootDomain: STEP29_GATEWAY_WHITELIST.rootDomain,
  dnsAccountId: 'cmu2b5fx90002ri3kioyvjior',
  certificateId: 'cmu288s0z0000ri40kdli7cd3',
  api: {
    unitId: 'cmu3j272x0005ri7wlxlbajeu',
    serviceInstanceId: 'cmuc66642002hritk6h3cbwhe',
    hostname: 'api-launchos.zsaos.com',
    targetPort: 39000,
    healthPath: '/health',
  },
  web: {
    unitId: 'cmu3j27340007ri7wcno1xrai',
    deploymentId: 'cmucaxab6001rriagcdjoez03',
    serviceInstanceId: 'cmucaxah704r9ritkb30z16uw',
    hostname: 'web-launchos.zsaos.com',
    targetPort: 39002,
    healthPath: '/',
    plannedApiUrl: 'https://api-launchos.zsaos.com',
  },
} as const;

export const DNS_ACTIVATION_EXECUTION_STEPS = [
  'acquire_public_entry_lock',
  'server_baseline_preflight',
  'dns_read_current',
  'apply_api_dns',
  'verify_provider_api_readback',
  'apply_web_dns',
  'verify_provider_web_readback',
  'mark_dns_pending',
  'dns_propagation_check',
  'verify_api_public_https',
  'verify_web_public_https',
  'verify_http_to_https_redirects',
  'mark_gateway_routes_active',
  'mark_access_entry_active',
  'final_security_validation',
  'release_lock',
] as const;

export type DnsActivationExecutionStep = (typeof DNS_ACTIVATION_EXECUTION_STEPS)[number];

export const DNS_ACTIVATION_AUDIT_EVENTS = [
  'DNS_ACTIVATION_STARTED',
  'API_DNS_CREATE_STARTED',
  'API_DNS_CREATE_COMPLETED',
  'WEB_DNS_CREATE_STARTED',
  'WEB_DNS_CREATE_COMPLETED',
  'DNS_PROPAGATION_VERIFIED',
  'API_PUBLIC_HTTPS_VERIFIED',
  'WEB_PUBLIC_HTTPS_VERIFIED',
  'PUBLIC_ENTRY_ACTIVE',
] as const;

export type DnsOwnershipRecord = {
  hostname: string;
  rr: string;
  recordType: 'A';
  providerRecordId: string | null;
  previousValue: string | null;
  desiredValue: string;
  managedByLaunchOS: boolean;
  ttl: number;
};

export type DnsPropagationStrategy = {
  desiredIp: string;
  hostnames: string[];
  pollIntervalMs: number;
  timeoutMs: number;
  checkAuthoritative: true;
  checkPublicResolvers: true;
  timeoutCode: 'DNS_PROPAGATION_TIMEOUT';
};

export type PublicHttpsVerifyPlan = {
  hostname: string;
  url: string;
  method: 'GET';
  requireTlsValid: true;
  requireHostnameMatch: true;
  requireNotExpired: true;
  acceptStatuses: number[];
  successField: string;
};

export type HttpRedirectVerifyPlan = {
  httpUrl: string;
  httpsUrl: string;
  requireHttpsLocation: true;
};

export type DnsPartialApplyState = {
  status: 'PARTIAL' | 'DNS_PENDING' | 'FAILED';
  apiDnsApplied: boolean;
  webDnsApplied: boolean;
  accessEntryActive: false;
};

export type DnsCreateReconcileResult =
  | { outcome: 'CREATE_NEEDED' }
  | { outcome: 'ALREADY_CORRECT'; providerRecordId: string | null; value: string }
  | { outcome: 'CONFLICT'; currentValue: string; providerRecordId: string | null }
  | { outcome: 'UPDATE_OWNED'; providerRecordId: string | null; previousValue: string };

/**
 * After CREATE timeout: query provider and decide — never blind duplicate CREATE.
 */
export function reconcileDnsCreateAttempt(input: {
  hostname: string;
  rootDomain: string;
  desiredIp: string;
  providerRecords: DnsRecordSnapshot[];
}): DnsCreateReconcileResult {
  const plan = planDnsARecord({
    hostname: input.hostname,
    rootDomain: input.rootDomain,
    desiredIp: input.desiredIp,
    existing: input.providerRecords[0] || null,
  });
  if (plan.action === 'NO_CHANGE') {
    return {
      outcome: 'ALREADY_CORRECT',
      providerRecordId: plan.providerRecordId,
      value: plan.desiredValue,
    };
  }
  if (plan.action === 'CREATE') return { outcome: 'CREATE_NEEDED' };
  if (plan.action === 'UPDATE') {
    return {
      outcome: 'UPDATE_OWNED',
      providerRecordId: plan.providerRecordId,
      previousValue: plan.previousValue || '',
    };
  }
  return {
    outcome: 'CONFLICT',
    currentValue: plan.previousValue || '',
    providerRecordId: plan.providerRecordId,
  };
}

export function buildDnsOwnershipFromPlan(plan: DnsApplyPlan, ttl?: number): DnsOwnershipRecord {
  return {
    hostname: plan.hostname,
    rr: plan.rr,
    recordType: 'A',
    providerRecordId: plan.providerRecordId,
    previousValue: plan.previousValue,
    desiredValue: plan.desiredValue,
    managedByLaunchOS: plan.managedByLaunchOS,
    ttl: normalizeAliyunDnsTtl(ttl ?? ALIYUN_DNS_DEFAULT_TTL),
  };
}

export function dnsPropagationStrategy(desiredIp: string): DnsPropagationStrategy {
  return {
    desiredIp,
    hostnames: [STEP29_PHASE3B_BASELINE.api.hostname, STEP29_PHASE3B_BASELINE.web.hostname],
    pollIntervalMs: 15_000,
    timeoutMs: 8 * 60 * 1000,
    checkAuthoritative: true,
    checkPublicResolvers: true,
    timeoutCode: 'DNS_PROPAGATION_TIMEOUT',
  };
}

export function planApiPublicHttpsVerify(): PublicHttpsVerifyPlan {
  return {
    hostname: STEP29_PHASE3B_BASELINE.api.hostname,
    url: `https://${STEP29_PHASE3B_BASELINE.api.hostname}${STEP29_PHASE3B_BASELINE.api.healthPath}`,
    method: 'GET',
    requireTlsValid: true,
    requireHostnameMatch: true,
    requireNotExpired: true,
    acceptStatuses: [200, 201, 204],
    successField: 'apiPublicHttpsVerified',
  };
}

export function planWebPublicHttpsVerify(): PublicHttpsVerifyPlan {
  return {
    hostname: STEP29_PHASE3B_BASELINE.web.hostname,
    url: `https://${STEP29_PHASE3B_BASELINE.web.hostname}/`,
    method: 'GET',
    requireTlsValid: true,
    requireHostnameMatch: true,
    requireNotExpired: true,
    acceptStatuses: [200, 301, 302, 307, 308],
    successField: 'webPublicHttpsVerified',
  };
}

export function planHttpRedirectVerifies(): HttpRedirectVerifyPlan[] {
  return [
    {
      httpUrl: `http://${STEP29_PHASE3B_BASELINE.api.hostname}${STEP29_PHASE3B_BASELINE.api.healthPath}`,
      httpsUrl: `https://${STEP29_PHASE3B_BASELINE.api.hostname}${STEP29_PHASE3B_BASELINE.api.healthPath}`,
      requireHttpsLocation: true,
    },
    {
      httpUrl: `http://${STEP29_PHASE3B_BASELINE.web.hostname}/`,
      httpsUrl: `https://${STEP29_PHASE3B_BASELINE.web.hostname}/`,
      requireHttpsLocation: true,
    },
  ];
}

/**
 * Partial apply: API DNS ok, Web DNS fail — never ACTIVE.
 */
export function dnsPartialApplyState(input: {
  apiDnsApplied: boolean;
  webDnsApplied: boolean;
  failed?: boolean;
}): DnsPartialApplyState {
  if (input.failed) {
    return {
      status: 'FAILED',
      apiDnsApplied: input.apiDnsApplied,
      webDnsApplied: input.webDnsApplied,
      accessEntryActive: false,
    };
  }
  if (input.apiDnsApplied !== input.webDnsApplied) {
    return {
      status: 'PARTIAL',
      apiDnsApplied: input.apiDnsApplied,
      webDnsApplied: input.webDnsApplied,
      accessEntryActive: false,
    };
  }
  return {
    status: 'DNS_PENDING',
    apiDnsApplied: input.apiDnsApplied,
    webDnsApplied: input.webDnsApplied,
    accessEntryActive: false,
  };
}

/**
 * Independent GatewayRoute ACTIVE: both public verifies required for both ACTIVE.
 */
export function planGatewayRouteActivation(input: {
  apiPublicHttpsVerified: boolean;
  webPublicHttpsVerified: boolean;
}): { apiGatewayRouteStatus: 'ACTIVE' | 'CONFIGURING'; webGatewayRouteStatus: 'ACTIVE' | 'CONFIGURING' } {
  return {
    apiGatewayRouteStatus: input.apiPublicHttpsVerified ? 'ACTIVE' : 'CONFIGURING',
    webGatewayRouteStatus: input.webPublicHttpsVerified ? 'ACTIVE' : 'CONFIGURING',
  };
}

export function canMarkAccessEntryActive(input: {
  apiDnsPropagated: boolean;
  webDnsPropagated: boolean;
  apiPublicHttpsVerified: boolean;
  webPublicHttpsVerified: boolean;
  httpToHttpsRedirectVerified: boolean;
  certificateValid: boolean;
  apiHealthy: boolean;
  webHealthy: boolean;
  dynamicPortsRemainPrivate: boolean;
}): { ok: boolean; accessEntryStatus: 'ACTIVE' | 'VERIFYING' | 'DNS_PENDING' | 'FAILED' } {
  const all =
    input.apiDnsPropagated &&
    input.webDnsPropagated &&
    input.apiPublicHttpsVerified &&
    input.webPublicHttpsVerified &&
    input.httpToHttpsRedirectVerified &&
    input.certificateValid &&
    input.apiHealthy &&
    input.webHealthy &&
    input.dynamicPortsRemainPrivate;
  if (all) return { ok: true, accessEntryStatus: 'ACTIVE' };
  if (input.apiDnsPropagated || input.webDnsPropagated) {
    return { ok: false, accessEntryStatus: 'VERIFYING' };
  }
  return { ok: false, accessEntryStatus: 'DNS_PENDING' };
}

export function evaluateDnsActivationGate(input: {
  gatewayRunning: boolean;
  port80Listening: boolean;
  port443Listening: boolean;
  certificateValid: boolean;
  certificateCoversApi: boolean;
  certificateCoversWeb: boolean;
  apiLocalHttpsReady: boolean;
  webLocalHttpsReady: boolean;
  apiServiceHealthy: boolean;
  webServiceHealthy: boolean;
  dnsAccountReady: boolean;
  apiDnsAction: DnsApplyAction;
  webDnsAction: DnsApplyAction;
  publicEntryLockReady: boolean;
  dynamicPortsRemainPrivate: boolean;
}): { canActivateDns: boolean; blockers: Array<{ code: string; message: string }> } {
  const blockers: Array<{ code: string; message: string }> = [];
  if (!input.gatewayRunning) blockers.push({ code: 'GATEWAY_NOT_RUNNING', message: 'nginx not running' });
  if (!input.port80Listening) blockers.push({ code: 'PORT_80_NOT_LISTENING', message: '80 not listening' });
  if (!input.port443Listening) blockers.push({ code: 'PORT_443_NOT_LISTENING', message: '443 not listening' });
  if (!input.certificateValid) blockers.push({ code: 'CERTIFICATE_INVALID', message: 'certificate invalid' });
  if (!input.certificateCoversApi) blockers.push({ code: 'CERT_MISSING_API_SAN', message: 'cert does not cover API hostname' });
  if (!input.certificateCoversWeb) blockers.push({ code: 'CERT_MISSING_WEB_SAN', message: 'cert does not cover Web hostname' });
  if (!input.apiLocalHttpsReady) blockers.push({ code: 'API_LOCAL_HTTPS_NOT_READY', message: 'API local HTTPS failed' });
  if (!input.webLocalHttpsReady) blockers.push({ code: 'WEB_LOCAL_HTTPS_NOT_READY', message: 'Web local HTTPS failed' });
  if (!input.apiServiceHealthy) blockers.push({ code: 'API_NOT_HEALTHY', message: 'API SI not RUNNING/HEALTHY' });
  if (!input.webServiceHealthy) blockers.push({ code: 'WEB_NOT_HEALTHY', message: 'Web SI not RUNNING/HEALTHY' });
  if (!input.dnsAccountReady) blockers.push({ code: 'DNS_ACCOUNT_NOT_READY', message: 'ALIYUN_DNS not ready' });
  if (input.apiDnsAction === 'DNS_RECORD_CONFLICT') {
    blockers.push({ code: 'DNS_RECORD_CONFLICT', message: 'API DNS ownership conflict' });
  }
  if (input.webDnsAction === 'DNS_RECORD_CONFLICT') {
    blockers.push({ code: 'DNS_RECORD_CONFLICT', message: 'Web DNS ownership conflict' });
  }
  if (!input.publicEntryLockReady) {
    blockers.push({ code: 'PUBLIC_ENTRY_LOCK_UNAVAILABLE', message: 'public-entry lock not ready' });
  }
  if (!input.dynamicPortsRemainPrivate) {
    blockers.push({ code: 'DYNAMIC_PORTS_PUBLIC', message: 'dynamic ports exposed publicly' });
  }
  return { canActivateDns: blockers.length === 0, blockers };
}

/**
 * Poll public DNS until both hostnames match desired IP or timeout.
 */
export async function waitForDnsPropagation(input: {
  hostnames: string[];
  desiredIp: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  verify: (hostname: string, desiredIp: string) => Promise<{ matched: boolean; addresses: string[]; error?: string }>;
}): Promise<{
  ok: boolean;
  timedOut: boolean;
  results: Array<{ hostname: string; matched: boolean; addresses: string[]; error?: string }>;
  elapsedMs: number;
}> {
  const pollIntervalMs = input.pollIntervalMs ?? 15_000;
  const timeoutMs = input.timeoutMs ?? 8 * 60 * 1000;
  const started = Date.now();
  let last: Array<{ hostname: string; matched: boolean; addresses: string[]; error?: string }> = [];
  while (Date.now() - started < timeoutMs) {
    last = [];
    for (const hostname of input.hostnames) {
      last.push({ hostname, ...(await input.verify(hostname, input.desiredIp)) });
    }
    if (last.every((r) => r.matched)) {
      return { ok: true, timedOut: false, results: last, elapsedMs: Date.now() - started };
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return { ok: false, timedOut: true, results: last, elapsedMs: Date.now() - started };
}

export type { DnsApplyAction, DnsApplyPlan, DnsRecordSnapshot };
