/**
 * Step 27.1 — Managed deployment path fixtures (source + domain invariants).
 * No remote writes.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engine = readFileSync(
  resolve(root, 'packages/deployment/src/engine/deployment-engine.service.ts'),
  'utf8',
);
const createDto = readFileSync(
  resolve(root, 'apps/api/src/deployments/dto/create-deployment.dto.ts'),
  'utf8',
);
const createSvc = readFileSync(
  resolve(root, 'apps/api/src/deployments/deployments.service.ts'),
  'utf8',
);
const e2e = readFileSync(resolve(root, 'scripts/step-27-managed-deployment-e2e.mjs'), 'utf8');
const dockerfile = readFileSync(resolve(root, 'packages/runtime/src/dockerfile.ts'), 'utf8');

describe('step 27.1 managed path fixtures', () => {
  it('create API persists targetType + serverInstanceId and fail-fasts unbound managed', () => {
    assert.match(createDto, /MANAGED_SERVER/);
    assert.match(createDto, /selectedArtifactId/);
    assert.match(createSvc, /MANAGED_SERVER_NOT_BOUND/);
    assert.match(createSvc, /targetType/);
    assert.match(createSvc, /sourceArtifactId/);
  });

  it('managed DEPLOY_APPLICATION skips local; REMOTE_DEPLOY runs remote docker step', () => {
    assert.match(
      engine,
      /Managed Server：跳过本地 DEPLOY_APPLICATION，交由 REMOTE_DEPLOY 执行/,
    );
    assert.match(engine, /runRemoteDockerDeployStep\(/);
    assert.match(engine, /assertManagedServerBound/);
    assert.match(engine, /assertManagedRuntimePort/);
    // Must not call local deploy from managed branch
    const managedBlock = engine.slice(
      engine.indexOf('if (targetType === \'MANAGED_SERVER\')'),
      engine.indexOf('if (deployment.serverInstanceId)'),
    );
    assert.equal(managedBlock.includes('runLocalDeployStep'), false);
  });

  it('dockerfile never defaults to npm start', () => {
    assert.equal(dockerfile.includes("?? 'npm start'"), false);
    assert.match(dockerfile, /ARTIFACT_NOT_RUNNABLE/);
  });

  it('e2e dry-run reports managed path fields and binds whitelist artifact', () => {
    assert.match(e2e, /deploymentTargetType/);
    assert.match(e2e, /executionPath/);
    assert.match(e2e, /localDeployAllowed/);
    assert.match(e2e, /selectedArtifactId/);
    assert.match(e2e, /resolvedStartCommand/);
    assert.match(e2e, /targetType:\s*['\"]MANAGED_SERVER['\"]/);
    assert.match(e2e, /selectedArtifactId:\s*ARTIFACT_ID/);
    assert.match(e2e, /oldHealthyRevisionPreserved/);
    assert.match(e2e, /WRITE_COMMANDS_EXECUTED_THIS_RUN/);
  });
});
