/**
 * Step 26.3 — resume dry-run preview (read-only SSH + DB facts).
 * No install / no --confirm-initialize.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(resolve(root, '.env'), 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i <= 0) continue;
  const k = t.slice(0, i).trim();
  let v = t.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (process.env[k] === undefined) process.env[k] = v;
}

const TARGET_SI = 'cmub78pz001sdripco5pexhdz';
const TARGET_IP = '116.62.198.184';

const require = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = require('@launchos/database');
const {
  decryptCredential,
  resolveServerSshUsername,
  redactSecrets,
  shellCommand,
  decideRuntimeInstallStrategy,
  resolveOsPackageFamily,
  parseOsReleaseFields,
  resumeFromPhase,
  canStartServerInitialization,
  emptyTool,
  toolFromCommandProbe,
} = require('@launchos/shared');
const { RemoteRunner } = require('@launchos/remote-runner');

async function soft(runner, cmd) {
  try {
    const r = await runner.execute(cmd, { timeoutMs: 20_000 });
    return { exitCode: r.exitCode, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
  } catch (e) {
    return { exitCode: 1, stdout: '', stderr: e instanceof Error ? e.message : String(e) };
  }
}

async function detect(runner, name) {
  const path = await soft(runner, shellCommand(`command -v ${name} 2>/dev/null || true`));
  const p = path.stdout.split(/\s+/)[0] || '';
  if (!p) return emptyTool();
  const ver = await soft(runner, shellCommand(`${name} --version 2>/dev/null | head -n 1 || true`));
  return toolFromCommandProbe({
    pathStdout: p,
    pathExitCode: 0,
    versionStdout: ver.stdout,
    versionExitCode: ver.exitCode,
  });
}

async function main() {
  const prisma = new PrismaClient();
  let password = '';
  try {
    const server = await prisma.serverInstance.findUnique({ where: { id: TARGET_SI } });
    if (!server || server.host !== TARGET_IP) throw new Error('target mismatch');
    password = decryptCredential(server.credentialEncrypted);
    const username = resolveServerSshUsername({
      serverUsername: server.username,
      provider: server.provider,
    });
    const meta =
      server.metadata && typeof server.metadata === 'object' && !Array.isArray(server.metadata)
        ? server.metadata
        : {};

    const runner = new RemoteRunner();
    await runner.connect({
      host: server.host,
      port: 22,
      username,
      password,
      readyTimeoutMs: 25_000,
    });

    const pathOut = await soft(runner, shellCommand('printf %s "$PATH"'));
    const osRel = await soft(runner, shellCommand('cat /etc/os-release'));
    const fields = parseOsReleaseFields(osRel.stdout);
    const packageFamily = resolveOsPackageFamily(fields);

    const tools = {
      podman: await detect(runner, 'podman'),
      docker: await detect(runner, 'docker'),
      dnf: await detect(runner, 'dnf'),
      yum: await detect(runner, 'yum'),
      microdnf: await detect(runner, 'microdnf'),
      rpm: await detect(runner, 'rpm'),
      aptGet: await detect(runner, 'apt-get'),
    };
    const rootExists = await soft(
      runner,
      shellCommand('test -d /opt/launchos && echo yes || echo no'),
    );
    await runner.disconnect();

    const strategy = decideRuntimeInstallStrategy({
      tools,
      osFamily: packageFamily,
    });
    const lastSuccessfulPhase = meta.lastSuccessfulPhase || null;
    const resumeFrom = resumeFromPhase(lastSuccessfulPhase);
    const blockers = [];
    if (!canStartServerInitialization(server.status) && server.status !== 'READY') {
      blockers.push(`serverReadiness=${server.status}`);
    }
    if (strategy.kind === 'UNSUPPORTED_PACKAGE_MANAGER') {
      blockers.push('no package manager and no podman');
    }

    const report = {
      serverInstanceId: server.id,
      publicIp: server.host,
      serverReadiness: server.status,
      osName: fields.osName,
      osVersion: fields.osVersion,
      packageFamily,
      PATH: pathOut.stdout,
      podmanDetected: tools.podman.available,
      podmanPath: tools.podman.path,
      dockerDetected: tools.docker.available,
      dnfDetected: tools.dnf.available,
      yumDetected: tools.yum.available,
      microdnfDetected: tools.microdnf.available,
      rpmDetected: tools.rpm.available,
      aptGetDetected: tools.aptGet.available,
      selectedRuntimeStrategy: strategy.kind,
      selectedPackageManager:
        strategy.kind === 'INSTALL' ? strategy.packageManager : strategy.kind === 'REUSE_PODMAN' ? null : null,
      installPlanPreview: strategy.kind === 'INSTALL' ? strategy.installCommands : [],
      launchosRootExists: rootExists.stdout === 'yes',
      lastSuccessfulPhase,
      resumeFromPhase: resumeFrom,
      canResume: canStartServerInitialization(server.status) && blockers.length === 0,
      blockers,
      WRITE_COMMANDS_EXECUTED_THIS_RUN: false,
      oldServerUntouched: true,
      historicalNote: 'prior run already wrote directories; this dry-run did not write',
    };

    const text = JSON.stringify(report, null, 2);
    if (text.includes(password)) throw new Error('password leak');
    console.log(redactSecrets(text));
  } finally {
    password = '';
    await prisma.$disconnect();
  }
}

main().catch((e) => console.error(e instanceof Error ? e.message : e));
