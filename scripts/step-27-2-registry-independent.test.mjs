/**
 * Step 27.2 fixtures — registry-independent managed deploy contracts.
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
const remote = readFileSync(
  resolve(root, 'packages/runtime/src/remote-docker-runtime.ts'),
  'utf8',
);
const imageArchive = readFileSync(
  resolve(root, 'packages/runtime/src/image-archive.ts'),
  'utf8',
);
const e2e = readFileSync(resolve(root, 'scripts/step-27-managed-deployment-e2e.mjs'), 'utf8');

describe('step 27.2 registry-independent managed deploy', () => {
  it('managed path builds image on LaunchOS builder and loads remotely', () => {
    assert.match(engine, /runManagedImageArchiveDeployStep/);
    assert.match(engine, /ensureManagedDockerImageArtifact/);
    assert.match(engine, /buildAndSaveImageArchive/);
    assert.match(engine, /uploadImageArchive/);
    assert.match(engine, /loadImageArchive/);
    assert.match(engine, /remoteBuildRequired:\s*false/);
    assert.match(engine, /remoteRegistryPullRequired:\s*false/);
  });

  it('remote run uses --pull=never and load never pulls registry', () => {
    assert.match(remote, /--pull=/);
    assert.match(remote, /pullPolicy/);
    assert.match(remote, /docker load -i/);
    assert.match(remote, /podman load -i/);
    assert.match(remote, /DEPLOYABLE_IMAGE_NOT_LOADED/);
    const managedFn = engine.slice(
      engine.indexOf('private async runManagedImageArchiveDeployStep'),
      engine.indexOf('private async ensureManagedDockerImageArtifact'),
    );
    assert.ok(managedFn.length > 100);
    assert.equal(managedFn.includes('remote.buildImage'), false);
    assert.equal(/docker\s+pull/.test(managedFn), false);
    assert.equal(/podman\s+build/.test(managedFn), false);
  });

  it('image archive is built locally with docker save', () => {
    assert.match(imageArchive, /docker save/);
    assert.match(imageArchive, /assertLocalBaseImagePresent/);
    assert.match(imageArchive, /MANAGED_BASE_IMAGE/);
  });

  it('e2e dry-run reports deployable DOCKER_IMAGE fields', () => {
    assert.match(e2e, /deployableArtifactId/);
    assert.match(e2e, /deployableArtifactType/);
    assert.match(e2e, /remoteBuildRequired/);
    assert.match(e2e, /remoteRegistryPullRequired/);
    assert.match(e2e, /runtimePullPolicy/);
    assert.match(e2e, /imageArchitecture/);
    assert.match(e2e, /architectureCompatible/);
  });
});
