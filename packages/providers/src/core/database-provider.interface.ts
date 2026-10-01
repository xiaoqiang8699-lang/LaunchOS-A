export type DatabaseInstanceStatus =
  | 'CREATING'
  | 'RUNNING'
  | 'FAILED'
  | 'DELETING'
  | 'DELETED'
  | 'UNKNOWN';

export type DatabaseTier = 'DEV' | 'SMALL' | 'STANDARD';

export type CreatePostgresInstanceInput = {
  region: string;
  zoneId?: string;
  instanceClass?: string;
  storageGb?: number;
  engineVersion?: string;
  vpcId?: string;
  vSwitchId?: string;
  instanceName: string;
  /** Comma-separated CIDRs / IPs. Never use 0.0.0.0/0. */
  securityIpList: string;
  clientToken?: string;
  tier?: DatabaseTier;
};

export type PostgresConnectionInfo = {
  host: string;
  port: number;
  networkType: 'VPC' | 'PUBLIC' | 'UNKNOWN';
};

export type CreateDatabaseInput = {
  dbInstanceId: string;
  databaseName: string;
  characterSetName?: string;
};

export type CreateAccountInput = {
  dbInstanceId: string;
  accountName: string;
  accountPassword: string;
};

export type GrantPrivilegeInput = {
  dbInstanceId: string;
  accountName: string;
  databaseName: string;
  privilege?: 'DBOwner' | 'ReadWrite' | 'ReadOnly';
};

export type SetWhitelistInput = {
  dbInstanceId: string;
  securityIpList: string;
  dbInstanceIpArrayName?: string;
};

export type AvailableSpec = {
  tier: DatabaseTier;
  label: string;
  instanceClass: string;
  storageGb: number;
  engineVersion: string;
};

export type NetworkPlacement = {
  region: string;
  zoneId?: string;
  vpcId?: string;
  vSwitchId?: string;
  /** Prefer private connectivity when true. */
  preferPrivate: boolean;
  /** Source IPs/CIDRs allowed to connect. */
  whitelist: string[];
  networkMode: 'VPC_PRIVATE' | 'PUBLIC_LIMITED';
};

/**
 * Cloud database provisioning port. Controllers must not call Aliyun APIs directly.
 */
export interface DatabaseProvider {
  readonly name: string;
  listAvailableSpecs(region: string, tier?: DatabaseTier): Promise<AvailableSpec[]>;
  createPostgresInstance(input: CreatePostgresInstanceInput): Promise<{ dbInstanceId: string }>;
  getInstanceStatus(dbInstanceId: string): Promise<{ status: DatabaseInstanceStatus; rawStatus?: string }>;
  waitUntilRunning(dbInstanceId: string, timeoutMs?: number): Promise<void>;
  createDatabase(input: CreateDatabaseInput): Promise<void>;
  createAccount(input: CreateAccountInput): Promise<void>;
  grantAccountPrivilege(input: GrantPrivilegeInput): Promise<void>;
  setWhitelist(input: SetWhitelistInput): Promise<void>;
  getConnectionInfo(dbInstanceId: string, preferPrivate?: boolean): Promise<PostgresConnectionInfo>;
  allocatePublicConnection?(dbInstanceId: string, port?: number): Promise<PostgresConnectionInfo>;
  deleteInstance(dbInstanceId: string): Promise<void>;
  resolveNetworkPlacement(input: {
    region?: string;
    ecsInstanceId?: string;
    serverPublicIp?: string;
  }): Promise<NetworkPlacement>;
}
