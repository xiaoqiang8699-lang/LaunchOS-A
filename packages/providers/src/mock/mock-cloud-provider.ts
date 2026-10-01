import type {
  BindDomainInput,
  CloudProvider,
  CreateServerInput,
  DomainBinding,
  NetworkInstance,
  ServerInstance,
  ServerStatus,
} from '../core/provider.interface';

const MOCK_SERVER_ID = 'mock-server-id';
const MOCK_SERVER_IP = '127.0.0.1';
const MOCK_NETWORK_ID = 'mock-network-id';

export class MockCloudProvider implements CloudProvider {
  readonly name = 'MOCK';

  async createServer(input: CreateServerInput = {}): Promise<ServerInstance> {
    return {
      externalId: MOCK_SERVER_ID,
      ip: MOCK_SERVER_IP,
        status: 'RUNNING',
        region: input.region?.trim() || 'local',
        instanceType: input.instanceType || 'mock.local',
    };
  }

  async deleteServer(_externalId: string): Promise<void> {
    return;
  }

  async getServerStatus(externalId: string): Promise<ServerStatus> {
    return {
      externalId,
      status: 'RUNNING',
      ip: MOCK_SERVER_IP,
    };
  }

  async createNetwork(): Promise<NetworkInstance> {
    return {
      externalId: MOCK_NETWORK_ID,
      status: 'RUNNING',
    };
  }

  async bindDomain(input: BindDomainInput): Promise<DomainBinding> {
    return {
      domain: input.domain,
      serverExternalId: input.serverExternalId,
      status: 'SKIPPED',
    };
  }
}
