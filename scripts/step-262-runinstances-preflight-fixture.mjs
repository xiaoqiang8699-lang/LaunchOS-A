/**
 * Non-billing fixture: build+validate RunInstances request matching live plan.
 * Never calls Aliyun SDK / RunInstances.
 */
import assert from 'node:assert/strict';
import {
  buildLaunchosEcsTags,
  generateManagedEcsPassword,
  validateRunInstancesRequestPreflight,
} from '../packages/shared/dist/server-provision.js';

const password = generateManagedEcsPassword();
const tags = buildLaunchosEcsTags({
  cloudResourceId: 'cmuas8iiz0001riown1l1a0o3',
  projectId: 'fixture-project',
  workspaceId: 'fixture-workspace',
});
const preflight = validateRunInstancesRequestPreflight({
  regionId: 'cn-hangzhou',
  zoneId: 'cn-hangzhou-i',
  instanceType: 'ecs.c6a.large',
  imageId: 'alinux_4_deb_4_2404_2_x64_20G_alibase_20260714.vhd',
  systemDiskCategory: 'cloud_essd',
  systemDiskSize: 60,
  vSwitchId: 'vsw-bp157ohics42z8nspg3ma',
  securityGroupId: 'sg-bp1140codg2rttjhff9x',
  instanceName: 'launchos-launchos',
  chargeType: 'PostPaid',
  internetChargeType: 'PayByTraffic',
  internetMaxBandwidthOut: 5,
  clientToken: 'op_fixture_preflight',
  loginMode: 'PASSWORD',
  passwordPresent: Boolean(password),
  passwordLength: password.length,
  tags,
});

const blob = JSON.stringify(preflight);
assert.equal(preflight.valid, true);
assert.deepEqual(preflight.missingFields, []);
assert.equal(preflight.passwordPresent, true);
assert.equal(preflight.resolvedRunInstancesRequest.SecurityGroupId, 'sg-bp1140codg2rttjhff9x');
assert.equal(preflight.resolvedRunInstancesRequest.VSwitchId, 'vsw-bp157ohics42z8nspg3ma');
assert.equal(
  preflight.resolvedRunInstancesRequest.ImageId,
  'alinux_4_deb_4_2404_2_x64_20G_alibase_20260714.vhd',
);
assert.equal(/AccessKey|BEGIN .*PRIVATE KEY|"Password"\s*:\s*"[^"]{6,}"/i.test(blob), false);

console.log(
  JSON.stringify(
    {
      ok: true,
      valid: preflight.valid,
      missingFields: preflight.missingFields,
      passwordPresent: preflight.passwordPresent,
      passwordLength: preflight.passwordLength,
      resolvedRunInstancesRequest: preflight.resolvedRunInstancesRequest,
      RUN_INSTANCES_CALLED: false,
    },
    null,
    2,
  ),
);
