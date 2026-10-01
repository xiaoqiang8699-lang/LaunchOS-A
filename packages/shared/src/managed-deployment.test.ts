import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertManagedRuntimePort,
  assertManagedServerBound,
  assertImageArchitectureCompatible,
  assertRuntimePublishSpec,
  classifyManagedDeployRuntimeFailure,
  evaluateManagedServerForDeploy,
  FAILED_CONTAINER_CLEANUP_POLICY,
  managedDeploymentLockKey,
  planNextRuntimePort,
  resolveDeploymentTargetType,
  resolveFailedServiceInstanceStatus,
  resolveRunnableStartCommand,
  resolveUnitHealthCheck,
  filterRuntimeEnvForUnitType,
  verifyRuntimeConfigPresence,
  scanImageBuildForSecrets,
  pickPlatformManagedNode,
  shouldSkipPublicGatewayForManagedDeploy,
  summarizeManagedDeployGate,
  STEP28_MULTI_UNIT_DEPLOY_WHITELIST,
} from './managed-deployment.js';
import { DYNAMIC_PORT_RANGE_START, RUNTIME_BIND_ADDRESS } from './server-initialization.js';

describe('managed deployment domain', () => {
  it('builds deployment lock key', () => {
    assert.equal(
      managedDeploymentLockKey('proj', 'unit'),
      'deployment:proj:unit',
    );
  });

  it('rejects non-READY server', () => {
    const r = evaluateManagedServerForDeploy({
      id: 's1',
      host: '116.62.198.184',
      status: 'INITIALIZING',
      metadata: { runtimeType: 'podman', bindAddress: '127.0.0.1' },
    });
    assert.equal(r.ok, false);
    assert.ok(r.blockers.some((b) => b.code === 'SERVER_NOT_READY'));
  });

  it('rejects old protected host', () => {
    const r = evaluateManagedServerForDeploy({
      id: 's1',
      host: '8.138.113.134',
      status: 'READY',
      metadata: { runtimeType: 'podman', bindAddress: '127.0.0.1', dockerCompatibility: true },
    });
    assert.equal(r.ok, false);
    assert.ok(r.blockers.some((b) => b.code === 'OLD_SERVER_FORBIDDEN'));
  });

  it('accepts READY podman managed server', () => {
    const r = evaluateManagedServerForDeploy(
      {
        id: 'cmub78pz001sdripco5pexhdz',
        host: '116.62.198.184',
        status: 'READY',
        dockerStatus: 'READY',
        provider: 'ALIYUN',
        metadata: {
          runtimeType: 'podman',
          bindAddress: '127.0.0.1',
          dockerCompatibility: true,
        },
      },
      { allowedServerInstanceId: 'cmub78pz001sdripco5pexhdz' },
    );
    assert.equal(r.ok, true);
    assert.deepEqual(r.blockers, []);
    assert.equal(r.facts.bindAddress, RUNTIME_BIND_ADDRESS);
  });

  it('plans ports from 39000 and skips collisions / 3000', () => {
    assert.equal(planNextRuntimePort([]), DYNAMIC_PORT_RANGE_START);
    assert.equal(planNextRuntimePort([39000, 39001]), 39002);
    assert.equal(planNextRuntimePort([3000, 3001]), DYNAMIC_PORT_RANGE_START);
  });

  it('enforces loopback publish spec', () => {
    assert.doesNotThrow(() =>
      assertRuntimePublishSpec({
        publishHost: '127.0.0.1',
        hostPort: 39001,
        containerPort: 3000,
      }),
    );
    assert.throws(
      () =>
        assertRuntimePublishSpec({
          publishHost: '0.0.0.0',
          hostPort: 39001,
          containerPort: 3000,
        }),
      /RUNTIME_PUBLIC_BIND_FORBIDDEN/,
    );
    assert.throws(() =>
      assertRuntimePublishSpec({
        publishHost: '127.0.0.1',
        hostPort: 3000,
        containerPort: 3000,
      }),
    );
  });

  it('classifies health vs start vs exit failures', () => {
    assert.equal(
      classifyManagedDeployRuntimeFailure('health check timeout').code,
      'HEALTH_CHECK_FAILED',
    );
    assert.equal(
      classifyManagedDeployRuntimeFailure('container exited immediately').code,
      'CONTAINER_EXITED',
    );
    assert.equal(
      classifyManagedDeployRuntimeFailure('RUNTIME_PUBLIC_BIND_FORBIDDEN').code,
      'RUNTIME_PUBLIC_BIND_FORBIDDEN',
    );
    assert.equal(
      classifyManagedDeployRuntimeFailure('docker: Error response from daemon').code,
      'CONTAINER_START_FAILED',
    );
    assert.equal(
      classifyManagedDeployRuntimeFailure(
        'Error: Get "https://registry-1.docker.io/v2/": dial tcp i/o timeout',
      ).code,
      'CONTAINER_REGISTRY_UNREACHABLE',
    );
    assert.equal(
      classifyManagedDeployRuntimeFailure('BASE_IMAGE_PULL_FAILED: pull access denied').code,
      'BASE_IMAGE_PULL_FAILED',
    );
    assert.equal(
      classifyManagedDeployRuntimeFailure('DEPLOYABLE_IMAGE_NOT_LOADED: image not known').code,
      'DEPLOYABLE_IMAGE_NOT_LOADED',
    );
  });

  it('skips public gateway for Aliyun managed SG-only servers', () => {
    assert.equal(
      shouldSkipPublicGatewayForManagedDeploy({ provider: 'ALIYUN' }),
      true,
    );
    assert.equal(
      shouldSkipPublicGatewayForManagedDeploy({
        provider: 'CUSTOM',
        metadata: { firewallStatus: 'PROVIDER_SECURITY_GROUP_ONLY' },
      }),
      true,
    );
    assert.equal(
      shouldSkipPublicGatewayForManagedDeploy({ provider: 'CUSTOM', metadata: {} }),
      false,
    );
    assert.equal(
      shouldSkipPublicGatewayForManagedDeploy({
        provider: 'ALIYUN',
        scope: 'PLATFORM_MANAGED',
      }),
      false,
    );
  });

  it('picks the oldest ready platform node and ignores workspace servers', () => {
    const readyMeta = { localGatewayReady: true };
    const picked = pickPlatformManagedNode([
      {
        id: 'busy',
        scope: 'PLATFORM_MANAGED',
        status: 'CREATED',
        dockerStatus: 'UNKNOWN',
        updatedAt: '2020-01-01T00:00:00.000Z',
        metadata: readyMeta,
      },
      {
        id: 'workspace',
        scope: 'WORKSPACE_OWNED',
        status: 'READY',
        dockerStatus: 'READY',
        updatedAt: '2019-01-01T00:00:00.000Z',
        metadata: readyMeta,
      },
      {
        id: 'unchecked',
        scope: 'PLATFORM_MANAGED',
        status: 'READY',
        dockerStatus: 'READY',
        updatedAt: '2018-01-01T00:00:00.000Z',
        metadata: { localGatewayReady: false },
      },
      {
        id: 'newer',
        scope: 'PLATFORM_MANAGED',
        status: 'READY',
        dockerStatus: 'READY',
        updatedAt: '2024-01-01T00:00:00.000Z',
        metadata: readyMeta,
      },
      {
        id: 'older',
        scope: 'PLATFORM_MANAGED',
        status: 'READY',
        dockerStatus: 'READY',
        updatedAt: '2023-01-01T00:00:00.000Z',
        metadata: readyMeta,
      },
    ]);
    assert.equal(picked?.id, 'older');
    assert.equal(pickPlatformManagedNode([]), null);
  });

  it('summarizes canDeploy only when all gates pass', () => {
    const ok = summarizeManagedDeployGate({
      serverOk: true,
      artifactReady: true,
      dependencyReady: true,
      runtimeSecretsReady: true,
      queueReady: true,
      lockReady: true,
      plannedRuntimePort: 39000,
      blockers: [],
    });
    assert.equal(ok.canDeploy, true);

    const bad = summarizeManagedDeployGate({
      serverOk: true,
      artifactReady: false,
      dependencyReady: true,
      runtimeSecretsReady: true,
      queueReady: true,
      lockReady: true,
      plannedRuntimePort: 39000,
      blockers: [],
    });
    assert.equal(bad.canDeploy, false);
    assert.ok(bad.blockers.some((b) => b.code === 'ARTIFACT_NOT_READY'));
  });

  it('fail-fast when MANAGED_SERVER without serverInstanceId', () => {
    assert.throws(
      () =>
        assertManagedServerBound({
          targetType: 'MANAGED_SERVER',
          serverInstanceId: null,
        }),
      /MANAGED_SERVER_NOT_BOUND/,
    );
    assert.doesNotThrow(() =>
      assertManagedServerBound({
        targetType: 'MANAGED_SERVER',
        serverInstanceId: 'cmub78pz001sdripco5pexhdz',
      }),
    );
    assert.doesNotThrow(() =>
      assertManagedServerBound({ targetType: 'LOCAL', serverInstanceId: null }),
    );
  });

  it('resolves explicit targetType without guessing from null server', () => {
    assert.equal(
      resolveDeploymentTargetType({
        hostingMode: 'launchos',
        serverInstanceId: 's1',
      }),
      'MANAGED_SERVER',
    );
    assert.equal(resolveDeploymentTargetType({ explicit: 'LOCAL' }), 'LOCAL');
    assert.equal(
      resolveDeploymentTargetType({
        explicit: 'MANAGED_SERVER',
        serverInstanceId: null,
      }),
      'MANAGED_SERVER',
    );
  });

  it('rejects managed runtime ports outside 39000-39999', () => {
    assert.doesNotThrow(() => assertManagedRuntimePort(DYNAMIC_PORT_RANGE_START));
    assert.throws(() => assertManagedRuntimePort(32768), /MANAGED_RUNTIME_PORT_OUT_OF_RANGE/);
    assert.throws(() => assertManagedRuntimePort(3000), /MANAGED_RUNTIME_PORT_OUT_OF_RANGE/);
  });

  it('does not blindly use npm start when script missing', () => {
    const missing = resolveRunnableStartCommand({
      analyzerStartCommand: 'npm start',
      packageScripts: { build: 'echo ok' },
      hasPackageJson: true,
    });
    assert.equal(missing.artifactRunnable, false);
    assert.equal(missing.resolvedStartCommand, null);
    assert.equal(missing.reasonCode, 'USER_PROJECT_START_COMMAND_MISSING');

    const ok = resolveRunnableStartCommand({
      packageScripts: { start: 'node server.js', build: 'echo' },
      hasPackageJson: true,
    });
    assert.equal(ok.artifactRunnable, true);
    assert.equal(ok.resolvedStartCommand, 'npm start');

    const prod = resolveRunnableStartCommand({
      packageScripts: { 'start:prod': 'node server.js' },
      hasPackageJson: true,
    });
    assert.equal(prod.resolvedStartCommand, 'npm run start:prod');

    const node = resolveRunnableStartCommand({
      unitStartCommand: 'node server.js',
      packageScripts: {},
      hasPackageJson: true,
    });
    assert.equal(node.resolvedStartCommand, 'node server.js');
  });

  it('maps failed deploy + exited container to ServiceInstance FAILED', () => {
    assert.equal(
      resolveFailedServiceInstanceStatus({
        deploymentFailed: true,
        containerExited: true,
        healthFailed: false,
        currentStatus: 'RUNNING',
      }),
      'FAILED',
    );
    assert.equal(
      resolveFailedServiceInstanceStatus({
        deploymentFailed: true,
        containerExited: false,
        healthFailed: true,
        currentStatus: 'RUNNING',
      }),
      'FAILED',
    );
    assert.equal(
      resolveFailedServiceInstanceStatus({
        deploymentFailed: false,
        containerExited: true,
        healthFailed: false,
      }),
      null,
    );
  });

  it('documents failed container cleanup policy', () => {
    assert.equal(FAILED_CONTAINER_CLEANUP_POLICY.retainFailedContainerForDiagnosis, true);
    assert.equal(FAILED_CONTAINER_CLEANUP_POLICY.preservePreviousHealthyRevision, true);
    assert.ok(FAILED_CONTAINER_CLEANUP_POLICY.retentionHours >= 1);
  });

  it('enforces image/server architecture compatibility', () => {
    assert.doesNotThrow(() =>
      assertImageArchitectureCompatible({
        imageArchitecture: 'amd64',
        serverArchitecture: 'x86_64',
      }),
    );
    assert.throws(
      () =>
        assertImageArchitectureCompatible({
          imageArchitecture: 'arm64',
          serverArchitecture: 'x86_64',
        }),
      /IMAGE_ARCHITECTURE_MISMATCH/,
    );
  });

  it('scans image build context for secret plaintext', () => {
    const clean = scanImageBuildForSecrets('FROM node:20-alpine\nCMD ["npm","start"]');
    assert.equal(clean.imageBuildSecretPlaintextHits, 0);
    const dirty = scanImageBuildForSecrets(
      'ENV DATABASE_URL=postgres://u:p@h/db\nENV REDIS_URL=redis://u:p@h:6379',
    );
    assert.ok(dirty.imageBuildSecretPlaintextHits >= 2);
  });

  it('requires deployable image when explicitly not ready', () => {
    const bad = summarizeManagedDeployGate({
      serverOk: true,
      artifactReady: true,
      deployableImageReady: false,
      dependencyReady: true,
      runtimeSecretsReady: true,
      queueReady: true,
      lockReady: true,
      plannedRuntimePort: 39000,
      blockers: [],
    });
    assert.equal(bad.canDeploy, false);
    assert.ok(bad.blockers.some((b) => b.code === 'DEPLOYABLE_IMAGE_NOT_READY'));
  });

  it('resolves unit health paths without forcing /health on WEB', () => {
    assert.deepEqual(resolveUnitHealthCheck({ unitType: 'API' }), {
      healthPath: '/health',
      healthPathSource: 'FRAMEWORK_DEFAULT',
    });
    assert.deepEqual(resolveUnitHealthCheck({ unitType: 'WEB' }), {
      healthPath: '/',
      healthPathSource: 'ROOT_FALLBACK',
    });
    assert.deepEqual(resolveUnitHealthCheck({ unitType: 'WEB', explicitHealthPath: '/ready' }), {
      healthPath: '/ready',
      healthPathSource: 'EXPLICIT',
    });
  });

  it('strips backend secrets from WEB runtime env but keeps server-side AUTH_SECRET', () => {
    const filtered = filterRuntimeEnvForUnitType('WEB', {
      SENTRY_DSN: 'https://example.ingest.sentry.io/1',
      DATABASE_URL: 'postgres://u:p@h/db',
      REDIS_URL: 'redis://u:p@h:6379',
      JWT_SECRET: 'secret',
      AUTH_SECRET: 'auth-session-secret',
      NEXTAUTH_SECRET: 'nextauth-secret',
      PG_PASSWORD: 'pw',
    });
    assert.equal(filtered.webSecretIsolation, true);
    assert.equal(filtered.env.SENTRY_DSN, 'https://example.ingest.sentry.io/1');
    assert.equal(filtered.env.AUTH_SECRET, 'auth-session-secret');
    assert.equal(filtered.env.NEXTAUTH_SECRET, 'nextauth-secret');
    assert.equal(filtered.env.DATABASE_URL, undefined);
    assert.equal(filtered.env.REDIS_URL, undefined);
    assert.equal(filtered.env.JWT_SECRET, undefined);
    assert.equal(filtered.env.PG_PASSWORD, undefined);
    assert.ok(filtered.strippedKeys.includes('DATABASE_URL'));
    assert.ok(filtered.allowedRuntimeKeys.includes('AUTH_SECRET'));
    assert.ok(filtered.allowedRuntimeKeys.includes('NEXTAUTH_SECRET'));
    assert.ok(filtered.allowedRuntimeKeys.includes('SENTRY_DSN'));
    assert.ok(filtered.blockedBackendSecretKeys.includes('DATABASE_URL'));
    assert.ok(filtered.blockedBackendSecretKeys.includes('REDIS_URL'));
    assert.ok(filtered.blockedBackendSecretKeys.includes('JWT_SECRET'));
  });

  it('verifies runtime config presence by keys only', () => {
    const result = verifyRuntimeConfigPresence({
      requiredKeys: ['AUTH_SECRET', 'PORT'],
      presentKeys: ['AUTH_SECRET', 'PORT', 'HOST'],
    });
    assert.equal(result.ok, true);
    assert.equal(result.requiredConfigCount, 2);
    assert.equal(result.injectedConfigCount, 2);
    assert.deepEqual(result.missingAtRuntime, []);
    const missing = verifyRuntimeConfigPresence({
      requiredKeys: ['AUTH_SECRET', 'DATABASE_URL'],
      presentKeys: ['AUTH_SECRET'],
    });
    assert.equal(missing.ok, false);
    assert.deepEqual(missing.missingAtRuntime, ['DATABASE_URL']);
  });

  it('plans Web runtime port away from reserved API 39000', () => {
    assert.equal(planNextRuntimePort([39000]), 39001);
    assert.notEqual(
      planNextRuntimePort([STEP28_MULTI_UNIT_DEPLOY_WHITELIST.apiRuntimePort]),
      STEP28_MULTI_UNIT_DEPLOY_WHITELIST.apiRuntimePort,
    );
  });
});
