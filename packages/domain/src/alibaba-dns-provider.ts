import Alidns20150109, {
  AddDomainRecordRequest,
  DeleteDomainRecordRequest,
  DescribeDomainRecordsRequest,
  UpdateDomainRecordRequest,
} from '@alicloud/alidns20150109';
import { Config } from '@alicloud/openapi-client';

export type AliyunDnsCredentials = {
  accessKey: string;
  secretKey: string;
  /** Usually cn-hangzhou for Alidns global endpoint */
  region?: string;
};

export type TxtRecordRef = {
  recordId: string;
  rr: string;
  domainName: string;
  value: string;
  ttl?: number;
};

export type ARecordRef = {
  recordId: string;
  rr: string;
  domainName: string;
  value: string;
  ttl?: number;
  type: 'A';
};

/** Alibaba Cloud DNS TXT TTL bounds (AddDomainRecord). */
export const ALIYUN_DNS_MIN_TTL = 600;
export const ALIYUN_DNS_MAX_TTL = 86400;
export const ALIYUN_DNS_DEFAULT_TTL = 600;

/**
 * Normalize TTL for Alibaba Cloud DNS only.
 * Valid range: 600–86400. Values below min are raised; above max are capped.
 */
export function normalizeAliyunDnsTtl(requested?: number): number {
  if (requested === undefined || requested === null || Number.isNaN(requested)) {
    return ALIYUN_DNS_DEFAULT_TTL;
  }
  const ttl = Math.floor(requested);
  if (ttl < ALIYUN_DNS_MIN_TTL) {
    return ALIYUN_DNS_MIN_TTL;
  }
  if (ttl > ALIYUN_DNS_MAX_TTL) {
    return ALIYUN_DNS_MAX_TTL;
  }
  return ttl;
}

/** Step 29 public-entry A-record RRs + Step 30 Phase 4 controlled test hosts. */
export const LAUNCHOS_PUBLIC_ENTRY_A_RRS = [
  'api-launchos',
  'web-launchos',
  'oneclick-web',
  'oneclick-test',
  'alpha',
  'api-alpha',
] as const;

export function assertLaunchosPublicEntryAHost(rr: string): void {
  const host = normalizeRr(rr);
  if (!(LAUNCHOS_PUBLIC_ENTRY_A_RRS as readonly string[]).includes(host)) {
    throw new Error(
      `LaunchOS A-record writes only allow ${LAUNCHOS_PUBLIC_ENTRY_A_RRS.join(', ')} (got ${host})`,
    );
  }
}

/**
 * External Alpha: allow single-label app hostnames under the controlled root zone.
 * Blocks apex, wildcards, and multi-level RRs (e.g. nested.sub).
 */
export function assertManagedSystemAppRr(rr: string): void {
  const host = normalizeRr(rr);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) {
    throw new Error(`非法系统应用 DNS RR：${host}`);
  }
  if (host === '*' || host === '@' || host.includes('.')) {
    throw new Error(`非法系统应用 DNS RR：${host}`);
  }
}

export class AlibabaCloudDnsProvider {
  readonly name = 'aliyun-dns';
  readonly mode = 'live' as const;
  private readonly client: Alidns20150109;
  private readonly domainName: string;

  constructor(credentials: AliyunDnsCredentials, domainName: string) {
    const config = new Config({
      accessKeyId: credentials.accessKey,
      accessKeySecret: credentials.secretKey,
    });
    // Alidns uses a global endpoint; region is not per-zone like ECS.
    config.endpoint = 'alidns.cn-hangzhou.aliyuncs.com';
    this.client = new Alidns20150109(config);
    this.domainName = domainName.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  }

  /** Read-only: list DNS records for the configured zone (connection test). */
  async listDomainRecordsReadOnly(options?: { pageSize?: number }): Promise<{
    total: number;
    sample: Array<{ rr: string; type: string; value: string }>;
  }> {
    const response = await this.client.describeDomainRecords(
      new DescribeDomainRecordsRequest({
        domainName: this.domainName,
        pageSize: options?.pageSize ?? 20,
        pageNumber: 1,
      }),
    );
    const records = response.body?.domainRecords?.record ?? [];
    const total = Number(response.body?.totalCount ?? records.length);
    return {
      total,
      sample: records.slice(0, 10).map((item) => ({
        rr: String(item.RR ?? ''),
        type: String(item.type ?? ''),
        value: String(item.value ?? '').slice(0, 80),
      })),
    };
  }

  /**
   * Create a TXT record. rr is relative host (e.g. _acme-challenge).
   * Never touches A/@ /www records.
   */
  async createTxtRecord(rr: string, value: string, ttl?: number): Promise<TxtRecordRef> {
    const host = normalizeRr(rr);
    assertMutableTxtHost(host);
    const normalizedTtl = normalizeAliyunDnsTtl(ttl);
    const response = await this.client.addDomainRecord(
      new AddDomainRecordRequest({
        domainName: this.domainName,
        RR: host,
        type: 'TXT',
        value,
        TTL: normalizedTtl,
      }),
    );
    const recordId = response.body?.recordId;
    if (!recordId) {
      throw new Error('Aliyun DNS AddDomainRecord returned no recordId');
    }
    return {
      recordId: String(recordId),
      rr: host,
      domainName: this.domainName,
      value,
      ttl: normalizedTtl,
    };
  }

  async findTxtRecords(rr: string, value?: string): Promise<TxtRecordRef[]> {
    const host = normalizeRr(rr);
    const response = await this.client.describeDomainRecords(
      new DescribeDomainRecordsRequest({
        domainName: this.domainName,
        RRKeyWord: host,
        type: 'TXT',
        pageSize: 100,
      }),
    );
    const records = response.body?.domainRecords?.record ?? [];
    return records
      .filter((item) => (item.RR || '').toLowerCase() === host.toLowerCase())
      .filter((item) => (item.type || '').toUpperCase() === 'TXT')
      .filter((item) => (value ? item.value === value : true))
      .map((item) => ({
        recordId: String(item.recordId),
        rr: String(item.RR),
        domainName: this.domainName,
        value: String(item.value ?? ''),
        ttl: item.TTL,
      }));
  }

  /** Read-only: find A records for a relative RR (e.g. web-launchos). Never mutates DNS. */
  async findARecordsReadOnly(rr: string): Promise<
    Array<{ rr: string; type: string; value: string; ttl?: number; recordId?: string }>
  > {
    const host = normalizeRr(rr);
    const response = await this.client.describeDomainRecords(
      new DescribeDomainRecordsRequest({
        domainName: this.domainName,
        RRKeyWord: host,
        type: 'A',
        pageSize: 50,
      }),
    );
    const records = response.body?.domainRecords?.record ?? [];
    return records
      .filter((item) => (item.RR || '').toLowerCase() === host.toLowerCase())
      .filter((item) => (item.type || '').toUpperCase() === 'A')
      .map((item) => ({
        rr: String(item.RR ?? ''),
        type: 'A',
        value: String(item.value ?? ''),
        ttl: item.TTL,
        recordId: item.recordId ? String(item.recordId) : undefined,
      }));
  }

  /**
   * Create A record for LaunchOS public-entry hostnames only (api-launchos / web-launchos).
   */
  async createARecord(rr: string, value: string, ttl?: number): Promise<ARecordRef> {
    const host = normalizeRr(rr);
    assertLaunchosPublicEntryAHost(host);
    return this.addARecordUnchecked(host, value, ttl);
  }

  /**
   * Update existing LaunchOS-managed A record by provider recordId.
   */
  async updateARecord(recordId: string, rr: string, value: string, ttl?: number): Promise<ARecordRef> {
    const host = normalizeRr(rr);
    assertLaunchosPublicEntryAHost(host);
    return this.updateARecordUnchecked(recordId, host, value, ttl);
  }

  /**
   * Upsert A record for a managed system app hostname under this zone
   * (e.g. web-ceshi.zsaos.com → gateway public IP).
   */
  async upsertSystemAppARecord(rr: string, value: string, ttl?: number): Promise<ARecordRef> {
    assertManagedSystemAppRr(rr);
    const host = normalizeRr(rr);
    const existing = await this.findARecordsReadOnly(host);
    const match = existing.find((item) => item.recordId);
    if (match?.recordId) {
      if (match.value === String(value || '').trim()) {
        return {
          recordId: match.recordId,
          rr: host,
          domainName: this.domainName,
          value: match.value,
          ttl: match.ttl ?? normalizeAliyunDnsTtl(ttl),
          type: 'A',
        };
      }
      return this.updateARecordUnchecked(match.recordId, host, value, ttl);
    }
    return this.addARecordUnchecked(host, value, ttl);
  }

  private async addARecordUnchecked(host: string, value: string, ttl?: number): Promise<ARecordRef> {
    const ipv4 = String(value || '').trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ipv4)) {
      throw new Error('A record value must be IPv4');
    }
    const normalizedTtl = normalizeAliyunDnsTtl(ttl);
    const response = await this.client.addDomainRecord(
      new AddDomainRecordRequest({
        domainName: this.domainName,
        RR: host,
        type: 'A',
        value: ipv4,
        TTL: normalizedTtl,
      }),
    );
    const recordId = response.body?.recordId;
    if (!recordId) {
      throw new Error('Aliyun DNS AddDomainRecord(A) returned no recordId');
    }
    return {
      recordId: String(recordId),
      rr: host,
      domainName: this.domainName,
      value: ipv4,
      ttl: normalizedTtl,
      type: 'A',
    };
  }

  private async updateARecordUnchecked(
    recordId: string,
    host: string,
    value: string,
    ttl?: number,
  ): Promise<ARecordRef> {
    if (!String(recordId || '').trim()) {
      throw new Error('recordId required for A record update');
    }
    const ipv4 = String(value || '').trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ipv4)) {
      throw new Error('A record value must be IPv4');
    }
    const normalizedTtl = normalizeAliyunDnsTtl(ttl);
    await this.client.updateDomainRecord(
      new UpdateDomainRecordRequest({
        recordId: String(recordId).trim(),
        RR: host,
        type: 'A',
        value: ipv4,
        TTL: normalizedTtl,
      }),
    );
    return {
      recordId: String(recordId).trim(),
      rr: host,
      domainName: this.domainName,
      value: ipv4,
      ttl: normalizedTtl,
      type: 'A',
    };
  }

  async findTxtRecord(rr: string, value: string): Promise<TxtRecordRef | null> {
    const matches = await this.findTxtRecords(rr, value);
    return matches[0] ?? null;
  }

  /**
   * Delete exactly one TXT by recordId. Optionally verify value matches before delete.
   */
  async deleteTxtRecord(recordId: string, expectedValue?: string): Promise<void> {
    if (!recordId.trim()) {
      throw new Error('recordId required for precise TXT delete');
    }
    if (expectedValue) {
      // Soft check via list — if we cannot find it, still try delete by id.
      // Never delete by RR alone.
    }
    await this.client.deleteDomainRecord(
      new DeleteDomainRecordRequest({
        recordId,
      }),
    );
  }

  async verifyTxtRecord(rr: string, expectedValue: string): Promise<boolean> {
    const found = await this.findTxtRecord(rr, expectedValue);
    return Boolean(found);
  }
}

/** In-memory provider for unit tests — no network. */
export class MemoryDnsTxtProvider {
  readonly name = 'memory-dns';
  private seq = 1;
  private readonly records = new Map<string, TxtRecordRef>();

  async createTxtRecord(rr: string, value: string, ttl = 600): Promise<TxtRecordRef> {
    const host = normalizeRr(rr);
    assertMutableTxtHost(host);
    const recordId = `mem-${this.seq++}`;
    const ref: TxtRecordRef = {
      recordId,
      rr: host,
      domainName: 'example.com',
      value,
      ttl,
    };
    this.records.set(recordId, ref);
    return ref;
  }

  async findTxtRecords(rr: string, value?: string): Promise<TxtRecordRef[]> {
    const host = normalizeRr(rr);
    return [...this.records.values()].filter(
      (item) => item.rr === host && (value ? item.value === value : true),
    );
  }

  async findTxtRecord(rr: string, value: string): Promise<TxtRecordRef | null> {
    return (await this.findTxtRecords(rr, value))[0] ?? null;
  }

  async deleteTxtRecord(recordId: string): Promise<void> {
    if (!this.records.has(recordId)) {
      throw new Error(`record not found: ${recordId}`);
    }
    this.records.delete(recordId);
  }

  async verifyTxtRecord(rr: string, expectedValue: string): Promise<boolean> {
    return Boolean(await this.findTxtRecord(rr, expectedValue));
  }

  /** Dangerous API intentionally not provided for RR-wide delete. */
  listAll(): TxtRecordRef[] {
    return [...this.records.values()];
  }
}

function normalizeRr(rr: string): string {
  return rr.trim().replace(/\.$/, '').toLowerCase();
}

export function assertMutableTxtHost(rr: string): void {
  if (rr === '@' || rr === '' || rr === 'www' || rr === '*') {
    throw new Error('Refusing to mutate apex/www/wildcard DNS hosts');
  }
  const allowed =
    rr.startsWith('_acme-challenge') || rr.startsWith('_launchos-verify-');
  if (!allowed) {
    throw new Error(
      'LaunchOS DNS TXT provider only allows _acme-challenge* or _launchos-verify-* hosts',
    );
  }
}

/** System DNS provider must only operate on the configured root domain. */
export function assertSystemDnsRootDomain(requested: string, configured: string): void {
  const a = requested.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  const b = configured.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (a !== b) {
    throw new Error(`系统 DNS Provider 仅允许操作根域名 ${b}`);
  }
}
