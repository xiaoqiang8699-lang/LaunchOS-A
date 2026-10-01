export type DnsRecordType = 'A' | 'CNAME';

export type CreateDomainRecordInput = {
  domain: string;
  type?: DnsRecordType;
  value: string;
};

export type DomainRecordResult = {
  recordId: string;
  domain: string;
  type: DnsRecordType;
  value: string;
};

export type DomainVerification = {
  domain: string;
  verified: boolean;
};

export interface DomainProvider {
  readonly name: string;
  createRecord(input: CreateDomainRecordInput): Promise<DomainRecordResult>;
  deleteRecord(recordId: string): Promise<void>;
  verifyDomain(domain: string): Promise<DomainVerification>;
}
