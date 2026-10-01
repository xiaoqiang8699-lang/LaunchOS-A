export type CreateServerInput = {
  region?: string;
  name?: string;
  instanceType?: string;
  diskSizeGb?: number;
};

export type ServerInstance = {
  externalId: string;
  ip: string;
  status: string;
  region: string;
  instanceType?: string;
  username?: string;
  loginPassword?: string;
};

export type ServerStatus = {
  externalId: string;
  status: string;
  ip: string;
};

export type NetworkInstance = {
  externalId: string;
  status: string;
};

export type BindDomainInput = {
  domain: string;
  serverExternalId: string;
};

export type DomainBinding = {
  domain: string;
  serverExternalId: string;
  status: 'SKIPPED';
};

export interface CloudProvider {
  readonly name: string;
  createServer(input?: CreateServerInput): Promise<ServerInstance>;
  deleteServer(externalId: string): Promise<void>;
  getServerStatus(externalId: string): Promise<ServerStatus>;
  createNetwork(): Promise<NetworkInstance>;
  bindDomain(input: BindDomainInput): Promise<DomainBinding>;
}
