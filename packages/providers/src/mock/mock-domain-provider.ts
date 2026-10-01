import type {
  CreateDomainRecordInput,
  DomainProvider,
  DomainRecordResult,
  DomainVerification,
} from '../core/domain-provider.interface';

export class MockDomainProvider implements DomainProvider {
  readonly name = 'MOCK';

  async createRecord(input: CreateDomainRecordInput): Promise<DomainRecordResult> {
    return {
      recordId: `mock-dns-${Math.random().toString(36).slice(2, 10)}`,
      domain: input.domain,
      type: input.type ?? 'A',
      value: input.value,
    };
  }

  async deleteRecord(_recordId: string): Promise<void> {
    return;
  }

  async verifyDomain(domain: string): Promise<DomainVerification> {
    return {
      domain,
      verified: true,
    };
  }
}
