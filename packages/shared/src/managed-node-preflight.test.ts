import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  evaluateManagedNodePreflight,
  interpretManagedNodeProbe,
  managedPortRangeHasFreePort,
  passingManagedNodeProbe,
} from './managed-node-preflight';

describe('managed node preflight', () => {
  it('marks a complete colocated gateway node READY', () => {
    const result = evaluateManagedNodePreflight(passingManagedNodeProbe());
    assert.equal(result.status, 'READY');
    assert.equal(result.localGatewayReady, true);
    assert.deepEqual(result.blockers, []);
  });

  it('does not become READY when gateway is missing', () => {
    const result = evaluateManagedNodePreflight({
      ...passingManagedNodeProbe(),
      gatewayExecutable: false,
      gatewayConfigPresent: false,
      port80: 'free',
      port443: 'free',
    });
    assert.equal(result.status, 'UNAVAILABLE');
    assert.equal(result.localGatewayReady, false);
    assert.ok(result.blockers.some((item) => item.code === 'LOCAL_GATEWAY_NOT_READY'));
  });

  it('accepts podman-docker when info and ps succeed, even if docker.service is inactive', () => {
    const facts = interpretManagedNodeProbe({
      DOCKER_BIN: '1',
      DOCKER_INFO_OK: '1',
      DOCKER_PS_OK: '1',
      DOCKER_SERVICE: 'inactive',
      DISK_FREE_MB: '8000',
      WORKDIR_WRITABLE: '1',
      NGINX_BIN: '1',
      GATEWAY_CONF: '1',
      PORT80: 'gateway',
      PORT443: 'gateway',
      LOOPBACK_HTTP: '200',
      LISTENING_MANAGED_PORTS: '39000,39001,39002',
      RUNTIME_ENGINE: 'podman',
    });
    const result = evaluateManagedNodePreflight(facts);
    assert.equal(facts.dockerAvailable, true);
    assert.equal(facts.dockerDaemonUsable, true);
    assert.equal(facts.portRangeUsable, true);
    assert.equal(result.status, 'READY');
    assert.equal(result.localGatewayReady, true);
    assert.deepEqual(result.blockers, []);
  });

  it('treats a partially used 39000 range as still allocatable', () => {
    assert.equal(managedPortRangeHasFreePort([39000, 39001, 39002]), true);
    const full = Array.from({ length: 1000 }, (_, index) => 39000 + index);
    assert.equal(managedPortRangeHasFreePort(full), false);
  });

  it('fails closed when 80/443 cannot be judged', () => {
    const result = evaluateManagedNodePreflight({
      ...passingManagedNodeProbe(),
      port80: 'unknown',
      port443: 'unknown',
    });
    assert.equal(result.status, 'UNAVAILABLE');
    assert.ok(result.blockers.some((item) => item.code === 'PUBLIC_PORT_UNKNOWN'));
  });
});
