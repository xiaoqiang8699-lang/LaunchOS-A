export type GatewayRouteEntry = {
  host: string;
  port: number;
  status: 'running' | 'stopped' | 'unavailable';
  projectId: string;
};

export type GatewayRouteTable = {
  updatedAt: string;
  rootDomain: string;
  routes: Record<string, GatewayRouteEntry>;
};

export function emptyRouteTable(rootDomain: string): GatewayRouteTable {
  return {
    updatedAt: new Date().toISOString(),
    rootDomain,
    routes: {},
  };
}
