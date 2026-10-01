import type { CloudProvider } from './core/provider.interface';
import type { DomainProvider } from './core/domain-provider.interface';
import { RealCloudProvider } from './aliyun/real-cloud-provider';
import { MockCloudProvider } from './mock/mock-cloud-provider';
import { MockDomainProvider } from './mock/mock-domain-provider';

export const MOCK_PROVIDER_TYPE = 'MOCK';
export const ALIYUN_PROVIDER_TYPE = 'ALIYUN';

export type CloudProviderCredentials = {
  accessKey: string;
  secretKey: string;
  region?: string;
};

export class UnsupportedProviderError extends Error {
  constructor(type: string) {
    super(`Unsupported cloud provider: ${type}`);
    this.name = 'UnsupportedProviderError';
  }
}

export function createCloudProvider(
  type: string,
  credentials?: CloudProviderCredentials,
): CloudProvider {
  if (type === MOCK_PROVIDER_TYPE) {
    return new MockCloudProvider();
  }
  if (type === ALIYUN_PROVIDER_TYPE) {
    if (!credentials?.accessKey || !credentials.secretKey) {
      throw new Error('ALIYUN provider requires accessKey and secretKey');
    }
    return new RealCloudProvider({
      accessKey: credentials.accessKey,
      secretKey: credentials.secretKey,
      region: credentials.region,
    });
  }
  throw new UnsupportedProviderError(type);
}

export function createDomainProvider(type: string): DomainProvider {
  if (type === MOCK_PROVIDER_TYPE) {
    return new MockDomainProvider();
  }
  throw new UnsupportedProviderError(type);
}
