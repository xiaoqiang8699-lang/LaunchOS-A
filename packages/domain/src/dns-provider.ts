export type DnsRecordType = 'A' | 'CNAME';

export type CreateDnsRecordInput = {
  domain: string;
  type?: DnsRecordType;
  value: string;
};

export type DnsRecordResult = {
  recordId: string;
  domain: string;
  type: DnsRecordType;
  value: string;
  mode: 'mock' | 'manual' | 'live';
};

export type DnsVerificationResult = {
  domain: string;
  verified: boolean;
  mode: 'mock' | 'manual' | 'live';
};

/**
 * Abstraction for system-domain DNS control.
 * Manual mode never pretends success without a real resolve to Gateway public IP.
 */
export interface SystemDomainDnsProvider {
  readonly name: string;
  readonly mode: 'mock' | 'manual' | 'live';
  createSystemDomain(domain: string): Promise<DnsRecordResult>;
  createDnsRecord(input: CreateDnsRecordInput): Promise<DnsRecordResult>;
  verifyDnsRecord(domain: string): Promise<DnsVerificationResult>;
  deleteDnsRecord(recordId: string): Promise<void>;
}

export class ManualSystemDomainDnsProvider implements SystemDomainDnsProvider {
  readonly name = 'manual';
  readonly mode = 'manual' as const;

  async createSystemDomain(domain: string): Promise<DnsRecordResult> {
    return {
      recordId: `manual:${domain}`,
      domain,
      type: 'A',
      value: '',
      mode: 'manual',
    };
  }

  async createDnsRecord(input: CreateDnsRecordInput): Promise<DnsRecordResult> {
    return {
      recordId: `manual:${input.domain}`,
      domain: input.domain,
      type: input.type ?? 'A',
      value: input.value,
      mode: 'manual',
    };
  }

  async verifyDnsRecord(domain: string): Promise<DnsVerificationResult> {
    const { readGatewayPublicIp } = await import('./constants');
    const { verifyHostnamePointsToIp } = await import('./dns-verify');
    const expectedIp = readGatewayPublicIp();
    if (!expectedIp) {
      return { domain, verified: false, mode: 'manual' };
    }
    const lookup = await verifyHostnamePointsToIp(domain, expectedIp);
    return { domain, verified: lookup.matched, mode: 'manual' };
  }

  async deleteDnsRecord(_recordId: string): Promise<void> {
    // no-op until real DNS provider is wired
  }
}

export class MockSystemDomainDnsProvider implements SystemDomainDnsProvider {
  readonly name = 'mock';
  readonly mode = 'mock' as const;

  async createSystemDomain(domain: string): Promise<DnsRecordResult> {
    return {
      recordId: `mock:${domain}`,
      domain,
      type: 'A',
      value: '127.0.0.1',
      mode: 'mock',
    };
  }

  async createDnsRecord(input: CreateDnsRecordInput): Promise<DnsRecordResult> {
    return {
      recordId: `mock:${input.domain}`,
      domain: input.domain,
      type: input.type ?? 'A',
      value: input.value,
      mode: 'mock',
    };
  }

  /** Mock never claims public DNS is ACTIVE. */
  async verifyDnsRecord(domain: string): Promise<DnsVerificationResult> {
    return { domain, verified: false, mode: 'mock' };
  }

  async deleteDnsRecord(_recordId: string): Promise<void> {}
}

export function createSystemDomainDnsProvider(
  kind = process.env.LAUNCHOS_DNS_PROVIDER?.trim().toLowerCase() || 'manual',
): SystemDomainDnsProvider {
  if (kind === 'mock') {
    return new MockSystemDomainDnsProvider();
  }
  return new ManualSystemDomainDnsProvider();
}
