import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildRuntimePlanFromFacts,
  decideRuntimeInstallStrategy,
  emptyTool,
  parseOsReleaseFields,
  pickAvailablePackageManager,
  resolveOsPackageFamily,
  resumeFromPhase,
  selectPackageManagersForFamily,
  toolFromCommandProbe,
  type HostToolProbe,
} from './server-initialization-runtime.js';

function tools(partial: Partial<HostToolProbe>): HostToolProbe {
  return {
    podman: emptyTool(),
    docker: emptyTool(),
    dnf: emptyTool(),
    yum: emptyTool(),
    microdnf: emptyTool(),
    rpm: emptyTool(),
    aptGet: emptyTool(),
    ...partial,
  };
}

describe('server initialization runtime detection', () => {
  it('recognizes Alibaba Cloud Linux 4 Deb Edition as debian/apt-get', () => {
    const text = `NAME="Alibaba Cloud Linux"
VERSION="4 (Deb Edition)"
ID="alinux"
ID_LIKE="ubuntu debian"
VARIANT="Deb Edition"
VARIANT_ID="deb"
VERSION_ID="4"`;
    const fields = parseOsReleaseFields(text);
    const family = resolveOsPackageFamily(fields);
    assert.equal(family, 'debian');
    assert.deepEqual(selectPackageManagersForFamily(family), ['apt-get']);
  });

  it('dnf missing + yum present → YUM selected (not UNSUPPORTED)', () => {
    const t = tools({
      yum: toolFromCommandProbe({ pathStdout: '/usr/bin/yum', pathExitCode: 0 }),
    });
    const pm = pickAvailablePackageManager(t, ['dnf', 'yum', 'microdnf']);
    assert.equal(pm, 'yum');
    const strategy = decideRuntimeInstallStrategy({ tools: t, osFamily: 'rpm' });
    assert.equal(strategy.kind, 'INSTALL');
    if (strategy.kind === 'INSTALL') assert.equal(strategy.packageManager, 'yum');
  });

  it('dnf exit 1 alone does not mean UNSUPPORTED when yum exists', () => {
    const t = tools({
      dnf: emptyTool(),
      yum: { available: true, path: '/usr/bin/yum', version: 'yum 3' },
    });
    const strategy = decideRuntimeInstallStrategy({ tools: t, osFamily: 'rpm' });
    assert.notEqual(strategy.kind, 'UNSUPPORTED_PACKAGE_MANAGER');
  });

  it('podman present without package manager → REUSE', () => {
    const t = tools({
      podman: { available: true, path: '/usr/bin/podman', version: 'podman version 4.0' },
    });
    const strategy = decideRuntimeInstallStrategy({ tools: t, osFamily: 'debian' });
    assert.equal(strategy.kind, 'REUSE_PODMAN');
  });

  it('no runtime and no managers → UNSUPPORTED_PACKAGE_MANAGER', () => {
    const strategy = decideRuntimeInstallStrategy({
      tools: tools({}),
      osFamily: 'debian',
    });
    assert.equal(strategy.kind, 'UNSUPPORTED_PACKAGE_MANAGER');
  });

  it('probe failure → PACKAGE_MANAGER_PROBE_FAILED', () => {
    const strategy = decideRuntimeInstallStrategy({
      tools: tools({}),
      osFamily: 'debian',
      probeFailed: true,
      probeErrorMessage: 'ssh blew up',
    });
    assert.equal(strategy.kind, 'PACKAGE_MANAGER_PROBE_FAILED');
  });

  it('Deb Edition with apt-get → INSTALL apt-get', () => {
    const t = tools({
      aptGet: { available: true, path: '/usr/bin/apt-get', version: null },
    });
    const strategy = decideRuntimeInstallStrategy({ tools: t, osFamily: 'debian' });
    assert.equal(strategy.kind, 'INSTALL');
    if (strategy.kind === 'INSTALL') {
      assert.equal(strategy.packageManager, 'apt-get');
      assert.equal(strategy.installCommands.some((c) => c.includes('apt-get install -y podman')), true);
    }
  });

  it('Alibaba Deb Edition fixture: apt-get + no podman → INSTALL/apt-get + resume INSTALLING_RUNTIME', () => {
    const text = `NAME="Alibaba Cloud Linux"
VERSION="4 (Deb Edition)"
ID="alinux"
ID_LIKE="ubuntu debian"
VARIANT="Deb Edition"
VARIANT_ID="deb"
VERSION_ID="4"`;
    const fields = parseOsReleaseFields(text);
    const family = resolveOsPackageFamily(fields);
    assert.equal(family, 'debian');
    const t = tools({
      aptGet: { available: true, path: '/usr/bin/apt-get', version: null },
    });
    const strategy = decideRuntimeInstallStrategy({ tools: t, osFamily: family });
    assert.equal(strategy.kind, 'INSTALL');
    if (strategy.kind === 'INSTALL') {
      assert.equal(strategy.packageManager, 'apt-get');
    }
    assert.equal(resumeFromPhase('PREPARING_DIRECTORIES'), 'INSTALLING_RUNTIME');
    const plan = buildRuntimePlanFromFacts({ packageFamily: family, tools: t, strategy });
    assert.equal(plan.some((l) => /apt-get selected/i.test(l)), true);
    assert.equal(plan.some((l) => /dnf \|\| yum/.test(l)), false);
  });

  it('resume from PREPARING_DIRECTORIES continues at INSTALLING_RUNTIME', () => {
    assert.equal(resumeFromPhase('PREPARING_DIRECTORIES'), 'INSTALLING_RUNTIME');
    assert.equal(resumeFromPhase('INSTALLING_RUNTIME'), 'CONFIGURING_FIREWALL');
  });
});
