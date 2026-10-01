const HOST_PORT_MIN = 39000;
const HOST_PORT_MAX = 39999;

export type ColocatedGatewayRoute = {
  hostname: string;
  upstreamHost: '127.0.0.1';
  upstreamPort: number;
};

/** v1 managed hosting: gateway and container share the node, so upstream is loopback. */
export function planColocatedGatewayRoute(hostname: string, hostPort: number): ColocatedGatewayRoute {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!normalized || normalized === 'localhost' || normalized.endsWith('.localhost')) {
    throw new Error('GATEWAY_HOSTNAME_INVALID');
  }
  if (!Number.isInteger(hostPort) || hostPort < HOST_PORT_MIN || hostPort > HOST_PORT_MAX) {
    throw new Error('GATEWAY_PORT_INVALID');
  }
  return {
    hostname: normalized,
    upstreamHost: '127.0.0.1',
    upstreamPort: hostPort,
  };
}

export function assertIsolatedGatewayRoutes(routes: ColocatedGatewayRoute[]): void {
  const hostnames = new Set<string>();
  const ports = new Set<number>();
  for (const route of routes) {
    if (hostnames.has(route.hostname) || ports.has(route.upstreamPort)) {
      throw new Error('GATEWAY_ROUTE_COLLISION');
    }
    hostnames.add(route.hostname);
    ports.add(route.upstreamPort);
  }
}
