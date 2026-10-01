import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  HOST_PORT_RANGE_END,
  HOST_PORT_RANGE_START,
  hostPortCandidates,
  selectHostPort,
  toUserFacingRuntimeError,
} from './host-port-allocator';

describe('host-port-allocator', () => {
  it('uses 39000+ range and never includes container ports 80/3000', () => {
    const ports = hostPortCandidates();
    assert.equal(ports[0], HOST_PORT_RANGE_START);
    assert.equal(ports[ports.length - 1], HOST_PORT_RANGE_END);
    assert.ok(!ports.includes(80));
    assert.ok(!ports.includes(3000));
    assert.ok(!ports.includes(8080));
  });

  it('gives two deployments different host ports and can reuse a released port', () => {
    const first = selectHostPort([]);
    assert.equal(first, 39000);
    const second = selectHostPort([first!]);
    assert.equal(second, 39001);
    assert.notEqual(first, second);
    const redeployWhileOldRuns = selectHostPort([39010]);
    assert.equal(redeployWhileOldRuns, 39000);
    assert.equal(selectHostPort([39000]), 39001);
    assert.equal(selectHostPort([]), 39000);
  });

  it('maps bind conflicts to friendly Chinese copy', () => {
    assert.equal(
      toUserFacingRuntimeError('Error: cannot listen on the TCP port: listen tcp4 :3000: bind: address already in use'),
      '服务器运行资源暂时冲突，请重新尝试上线。',
    );
  });
});
