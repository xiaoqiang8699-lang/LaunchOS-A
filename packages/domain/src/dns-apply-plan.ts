/**
 * Step 29 Phase 2 — DNS apply planning (ALIYUN_DNS), ownership-aware, no blind overwrite.
 */
export type DnsRecordSnapshot = {
  rr: string;
  type: string;
  value: string;
  recordId?: string | null;
  ttl?: number | null;
  managedByLaunchOS?: boolean;
};

export type DnsApplyAction = 'CREATE' | 'UPDATE' | 'NO_CHANGE' | 'DNS_RECORD_CONFLICT';

export type DnsApplyPlan = {
  hostname: string;
  rr: string;
  type: 'A';
  desiredValue: string;
  current: DnsRecordSnapshot | null;
  action: DnsApplyAction;
  previousValue: string | null;
  providerRecordId: string | null;
  managedByLaunchOS: boolean;
};

export function hostnameToRr(hostname: string, rootDomain: string): string {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  const root = rootDomain.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (host === root) return '@';
  if (host.endsWith(`.${root}`)) return host.slice(0, -(root.length + 1));
  return host;
}

/**
 * Plan DNS mutation for a single hostname A record.
 * Conflict if existing A points elsewhere and is not LaunchOS-managed.
 */
export function planDnsARecord(input: {
  hostname: string;
  rootDomain: string;
  desiredIp: string;
  existing: DnsRecordSnapshot | null;
}): DnsApplyPlan {
  const rr = hostnameToRr(input.hostname, input.rootDomain);
  const desired = input.desiredIp.trim();
  const current = input.existing;
  if (!current) {
    return {
      hostname: input.hostname,
      rr,
      type: 'A',
      desiredValue: desired,
      current: null,
      action: 'CREATE',
      previousValue: null,
      providerRecordId: null,
      managedByLaunchOS: true,
    };
  }
  const same =
    String(current.type).toUpperCase() === 'A' && String(current.value).trim() === desired;
  if (same) {
    return {
      hostname: input.hostname,
      rr,
      type: 'A',
      desiredValue: desired,
      current,
      action: 'NO_CHANGE',
      previousValue: current.value,
      providerRecordId: current.recordId || null,
      managedByLaunchOS: current.managedByLaunchOS !== false,
    };
  }
  if (current.managedByLaunchOS === true) {
    return {
      hostname: input.hostname,
      rr,
      type: 'A',
      desiredValue: desired,
      current,
      action: 'UPDATE',
      previousValue: current.value,
      providerRecordId: current.recordId || null,
      managedByLaunchOS: true,
    };
  }
  return {
    hostname: input.hostname,
    rr,
    type: 'A',
    desiredValue: desired,
    current,
    action: 'DNS_RECORD_CONFLICT',
    previousValue: current.value,
    providerRecordId: current.recordId || null,
    managedByLaunchOS: false,
  };
}
