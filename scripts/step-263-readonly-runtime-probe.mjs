/**
 * Step 26.3 — read-only SSH diagnosis (one command at a time).
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

function argId(argv) {
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i].startsWith('--server-instance-id=')) return argv[i].slice('--server-instance-id='.length);
    if (argv[i] === '--server-instance-id') return argv[i + 1] || TARGET_SI;
  }
  return TARGET_SI;
}

const serverInstanceId = argId(process.argv);
const require = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = require('@launchos/database');
const { decryptCredential, resolveServerSshUsername, redactSecrets } = require('@launchos/shared');
const { RemoteRunner } = require('@launchos/remote-runner');

async function soft(runner, command) {
  try {
    const r = await runner.execute(command, { timeoutMs: 30_000 });
    return {
      command,
      exitCode: r.exitCode,
      stdout: (r.stdout || '').trim().slice(0, 800),
      stderr: (r.stderr || '').trim().slice(0, 300),
    };
  } catch (error) {
    return {
      command,
      exitCode: -1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

function sh(cmd) {
  return `sh -lc ${JSON.stringify(cmd)}`;
}

async function run() {
  const prisma = new PrismaClient();
  let password = '';
  try {
    const server = await prisma.serverInstance.findUnique({ where: { id: serverInstanceId } });
    if (!server) throw new Error('not found');
    if (server.host !== TARGET_IP) throw new Error(`host mismatch ${server.host}`);
    password = decryptCredential(server.credentialEncrypted);
    const username = resolveServerSshUsername({
      serverUsername: server.username,
      provider: server.provider,
    });

    const runner = new RemoteRunner();
    await runner.connect({
      host: server.host,
      port: server.port || 22,
      username,
      password,
      readyTimeoutMs: 25_000,
    });

    const cmds = [
      // raw (no explicit shell) — reproduces worker-style exec
      'command -v dnf',
      'command -v yum',
      'command -v podman',
      'test -x /usr/bin/dnf',
      'test -x /usr/bin/yum',
      'test -x /usr/bin/microdnf',
      'test -x /usr/bin/rpm',
      'test -x /usr/bin/podman',
      // via shell
      sh('cat /etc/os-release'),
      sh('uname -a'),
      sh('uname -m'),
      sh('printf %s "$PATH"'),
      sh('echo SHELL=$SHELL'),
      sh('command -v dnf || true'),
      sh('command -v yum || true'),
      sh('command -v microdnf || true'),
      sh('command -v rpm || true'),
      sh('command -v apt-get || true'),
      sh('command -v podman || true'),
      sh('command -v docker || true'),
      sh('ls -l /usr/bin/dnf /usr/bin/yum /usr/bin/microdnf /usr/bin/rpm /usr/bin/podman /usr/bin/docker 2>/dev/null || true'),
      sh('rpm --version 2>/dev/null || true'),
      sh('dnf --version 2>/dev/null | head -n 2 || true'),
      sh('yum --version 2>/dev/null | head -n 2 || true'),
      sh('podman --version 2>/dev/null || true'),
      sh('docker --version 2>/dev/null || true'),
      sh('test -d /opt/launchos && echo launchosRoot=yes || echo launchosRoot=no'),
      sh('test -d /opt/launchos/apps && echo apps=yes || echo apps=no'),
      sh('test -d /opt/launchos/runtime && echo runtime=yes || echo runtime=no'),
      sh('test -d /opt/launchos/logs && echo logs=yes || echo logs=no'),
      sh('test -d /opt/launchos/artifacts && echo artifacts=yes || echo artifacts=no'),
      sh('test -d /opt/launchos/tmp && echo tmp=yes || echo tmp=no'),
      sh('test -d /opt/launchos/config && echo config=yes || echo config=no'),
      sh('ls /usr/bin/*dnf* /usr/bin/*yum* 2>/dev/null || true'),
      sh('type dnf 2>/dev/null || true'),
      sh('type yum 2>/dev/null || true'),
    ];

    const results = [];
    for (const c of cmds) {
      results.push(await soft(runner, c));
    }
    await runner.disconnect();

    const meta =
      server.metadata && typeof server.metadata === 'object' && !Array.isArray(server.metadata)
        ? server.metadata
        : {};

    const report = {
      serverInstanceId: server.id,
      publicIp: server.host,
      serverReadiness: server.status,
      lastSuccessfulPhase: meta.lastSuccessfulPhase || null,
      failedPhase: meta.failedPhase || null,
      errorCode: meta.errorCode || null,
      sshUsername: username,
      passwordPresent: true,
      results,
      WRITE_COMMANDS_EXECUTED_THIS_RUN: false,
      oldServerUntouched: true,
    };
    const text = JSON.stringify(report, null, 2);
    if (text.includes(password)) throw new Error('password leak');
    console.log(redactSecrets(text));
  } finally {
    password = '';
    await prisma.$disconnect();
  }
}

run().catch((e) => console.error(e instanceof Error ? e.message : e));
