/**
 * Beta M3 unit decisions.
 * node scripts/_tmp-m3-unit.mjs
 */
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireShared = createRequire(resolve(root, 'packages/shared/package.json'));
const { decideProductRuntimeHealth, isRuntimeHealthStale } = requireShared('./dist/runtime-product-health.js');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(
  decideProductRuntimeHealth({
    serviceStatus: 'RUNNING',
    runtimeHealth: 'HEALTHY',
    lastHealthCheckAt: new Date(),
    gatewayStatus: 'ACTIVE',
    dnsStatus: 'ACTIVE',
    publicOk: true,
    publicHttpStatus: 200,
    lastPublicCheckAt: new Date(),
  }).overallStatus === 'HEALTHY',
  'healthy',
);

assert(
  decideProductRuntimeHealth({
    serviceStatus: 'RUNNING',
    runtimeHealth: 'HEALTHY',
    lastHealthCheckAt: new Date(),
    gatewayStatus: 'ACTIVE',
    dnsStatus: 'ACTIVE',
  }).overallStatus === 'STATUS_PENDING',
  'public unknown pending',
);

const publicFail = decideProductRuntimeHealth({
  serviceStatus: 'RUNNING',
  runtimeHealth: 'HEALTHY',
  lastHealthCheckAt: new Date(),
  gatewayStatus: 'ACTIVE',
  dnsStatus: 'ACTIVE',
  publicOk: false,
  publicHttpStatus: 502,
  lastPublicCheckAt: new Date(),
});
assert(publicFail.overallStatus === 'UNHEALTHY', 'public fail status');
assert(publicFail.anomalyLayer === 'PUBLIC', 'public layer');
assert(publicFail.failureCategory === 'PLATFORM', 'platform');

assert(
  decideProductRuntimeHealth({
    serviceStatus: 'STOPPED',
    runtimeHealth: 'UNKNOWN',
  }).overallStatus === 'STOPPED',
  'stopped',
);

assert(
  decideProductRuntimeHealth({
    serviceStatus: 'RUNNING',
    runtimeHealth: 'HEALTHY',
    lastHealthCheckAt: new Date(),
    publicOk: true,
    activeDeployStatus: 'RUNNING',
  }).overallStatus === 'DEPLOYING',
  'deploying',
);

assert(
  decideProductRuntimeHealth({
    serviceStatus: 'RUNNING',
    runtimeHealth: 'HEALTHY',
    lastHealthCheckAt: new Date(),
    publicOk: true,
    activeDeployStatus: 'RUNNING',
    activeDeployIsRollback: true,
  }).overallStatus === 'RESTORING',
  'restoring',
);

assert(isRuntimeHealthStale(new Date(Date.now() - 20 * 60_000)) === true, 'stale');

assert(
  decideProductRuntimeHealth({
    serviceStatus: 'RUNNING',
    runtimeHealth: 'UNHEALTHY',
    healthMessage: 'container exited immediately',
    lastHealthCheckAt: new Date(),
  }).anomalyLayer === 'RUNTIME',
  'runtime exit',
);

console.log('M3_UNIT=PASS');
