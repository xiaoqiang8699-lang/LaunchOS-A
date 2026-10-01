import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertIsolatedGatewayRoutes, planColocatedGatewayRoute } from './managed-gateway-route';

describe('colocated gateway routes', () => {
  it('maps two hostnames to different loopback ports', () => {
    const first = planColocatedGatewayRoute('alpha.apps.example.com', 39010);
    const second = planColocatedGatewayRoute('beta.apps.example.com', 39011);
    assert.equal(first.upstreamHost, '127.0.0.1');
    assert.equal(second.upstreamHost, '127.0.0.1');
    assert.equal(first.upstreamPort, 39010);
    assert.equal(second.upstreamPort, 39011);
    assert.notEqual(first.hostname, second.hostname);
    assert.doesNotThrow(() => assertIsolatedGatewayRoutes([first, second]));
  });

  it('rejects a shared host port', () => {
    const first = planColocatedGatewayRoute('alpha.apps.example.com', 39020);
    const second = planColocatedGatewayRoute('beta.apps.example.com', 39020);
    assert.throws(() => assertIsolatedGatewayRoutes([first, second]), /GATEWAY_ROUTE_COLLISION/);
  });

  it('rejects localhost and ports outside the managed range', () => {
    assert.throws(() => planColocatedGatewayRoute('localhost', 39000), /GATEWAY_HOSTNAME_INVALID/);
    assert.throws(() => planColocatedGatewayRoute('app.apps.example.com', 3000), /GATEWAY_PORT_INVALID/);
  });
});
