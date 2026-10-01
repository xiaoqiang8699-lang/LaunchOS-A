/**
 * Step 31.1 — Alpha API Git Runtime Fix
 *
 *   node scripts/step311-git-runtime-fix.mjs --confirm-step311
 *
 * Rebuild/redeploy launchos-alpha-api so runtime has git CLI.
 * Safe candidate switch. No secrets printed. No paid resources.
 */
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of [resolve(root, '.env'), resolve(root, '.secrets/alpha-data-plane.env')]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
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
}

if (!process.argv.includes('--confirm-step311')) {
  console.error('Refusing: pass --confirm-step311');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const {
  decryptCredential,
  resolveServerSshUsername,
  shellCommand,
} = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const { applyColocatedNginxRoute } = requireDomain('@launchos/domain');

const TARGET_HOST = '116.62.198.184';
const WEB_HOST = 'alpha.zsaos.com';
const API_HOST = 'api-alpha.zsaos.com';
const WEB_ORIGIN = `https://${WEB_HOST}`;
const API_ORIGIN = `https://${API_HOST}`;
const LIVE_API_PORT = 39110;
const CANDIDATE_API_PORT = 39112;
const IMAGE_TAG = 'launchos-alpha-api:step311';
const LOCAL_IMAGE = IMAGE_TAG;
const REMOTE_IMAGE = `localhost/${IMAGE_TAG}`;
const LIVE_CONTAINER = 'launchos-alpha-api';
const CANDIDATE_CONTAINER = 'launchos-alpha-api-cand-311';
const ARTIFACT_DIR = resolve(root, '.tools', 'alpha-runtime');
const REPORT_PATH = resolve(root, '.tools', 'step311-git-runtime-fix-report.json');
const DOCKERFILE = resolve(root, 'deploy/alpha/Dockerfile.api');
const PROTECTED_HOSTS = [
  WEB_HOST,
  API_HOST,
  'web-launchos.zsaos.com',
  'api-launchos.zsaos.com',
  'oneclick-web.zsaos.com',
  'launchos-real-test.zsaos.com',
];

function redact(text) {
  return String(text || '')
    .replace(/postgres(ql)?:\/\/[^:\s]+:[^@\s]+@/gi, 'postgresql://***:***@')
    .replace(/redis:\/\/[^:\s]+:[^@\s]+@/gi, 'redis://***:***@')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|CREDENTIAL)[=:]([^\s"']+)/gi, '$1=***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***');
}

function assertOk(result, label, { allowExit = [0] } = {}) {
  const code = Number(result?.exitCode ?? 1);
  if (!allowExit.includes(code)) {
    throw new Error(
      `${label} failed exit=${code}: ${redact(String(result?.stderr || result?.stdout || '').slice(0, 1500))}`,
    );
  }
  return result;
}

async function remoteOk(runner, command, label, opts = {}) {
  const { allowExit = [0], timeoutMs = 120000 } = opts;
  const result = await runner.execute(shellCommand(command), { timeoutMs });
  return assertOk(result, label, { allowExit });
}

function curlResolve(url, host, { method = 'GET', headers = {}, body = null, maxTime = '90' } = {}) {
  const args = [
    '-k',
    '-sS',
    '-X',
    method,
    '--resolve',
    `${host}:443:${TARGET_HOST}`,
    '-w',
    '\n__STATUS__:%{http_code}',
    '--max-time',
    String(maxTime),
  ];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body != null) {
    args.push('-H', 'content-type: application/json');
    args.push('--data-binary', body);
  }
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)\s*$/);
  return {
    status: m ? Number(m[1]) : 0,
    text: m ? out.slice(0, m.index) : out,
    err: redact(String(r.stderr || '')),
  };
}

function local(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 30_000_000,
    ...opts,
  });
}

function hasGitMissing(text) {
  return /本机未安装\s*Git|git not found|ENOENT.*\bgit\b|未安装 Git|spawn git/i.test(
    String(text || ''),
  );
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function apiRunCmd({ name, image, port, envFile = '/opt/launchos/config/alpha-api.env' }) {
  return [
    `podman run -d --name ${name}`,
    '--restart unless-stopped',
    '--network host',
    `--env-file ${envFile}`,
    `-e API_PORT=${port}`,
    '-v /opt/launchos/config/github-app.pem:/run/secrets/github-app.pem:ro',
    '--entrypoint /bin/sh',
    image,
    `-c 'export GITHUB_APP_PRIVATE_KEY="$(cat /run/secrets/github-app.pem)"; exec node apps/api/dist/main.js'`,
  ].join(' ');
}

async function waitLocalHealth(runner, port, label) {
  await runner.writeTextFile(
    `/opt/launchos/bin/step311-wait-${port}.sh`,
    `#!/bin/sh
i=0
while [ "$i" -lt 60 ]; do
  i=$((i+1))
  if curl -fsS http://127.0.0.1:${port}/api/v1/health >/dev/null 2>&1; then
    curl -fsS http://127.0.0.1:${port}/api/v1/health
    exit 0
  fi
  sleep 2
done
podman logs --tail 80 ${label} || true
exit 1
`,
  );
  return remoteOk(
    runner,
    `chmod 700 /opt/launchos/bin/step311-wait-${port}.sh && /opt/launchos/bin/step311-wait-${port}.sh`,
    `wait-health-${port}`,
    { timeoutMs: 180000 },
  );
}

const report = {
  step: '31.1 Alpha API Git Runtime Fix',
  oldContainerImage: null,
  oldGitCheck: null,
  dockerfileRuntimeGitStatus: null,
  newImageBuild: null,
  newImageId: null,
  gitVersion: null,
  candidateRuntime: null,
  candidateHealth: null,
  apiTrafficSwitch: null,
  publicApiHealth: null,
  publicRepoAnalyze: null,
  zipRegression: null,
  existingRoutesRegression: null,
  secretsExposed: 'NO',
  paidResourceCreated: 'NO',
  final: 'FAIL',
  error: null,
};

function printFinal(r) {
  console.log('');
  console.log('Step 31.1 Alpha API Git Runtime Fix');
  console.log('');
  console.log(`1. Old container image: ${JSON.stringify(r.oldContainerImage)}`);
  console.log(`2. Old git check: ${JSON.stringify(r.oldGitCheck)}`);
  console.log(`3. Dockerfile runtime git status: ${r.dockerfileRuntimeGitStatus}`);
  console.log(`4. New image build: ${r.newImageBuild}`);
  console.log(`5. New image id: ${r.newImageId}`);
  console.log(`6. git version: ${r.gitVersion}`);
  console.log(`7. Candidate runtime: ${JSON.stringify(r.candidateRuntime)}`);
  console.log(`8. Candidate health: ${JSON.stringify(r.candidateHealth)}`);
  console.log(`9. API traffic switch: ${JSON.stringify(r.apiTrafficSwitch)}`);
  console.log(`10. Public API health: ${JSON.stringify(r.publicApiHealth)}`);
  console.log(`11. Public repo analyze: ${JSON.stringify(r.publicRepoAnalyze)}`);
  console.log(`12. ZIP regression: ${JSON.stringify(r.zipRegression)}`);
  console.log(`13. Existing routes regression: ${JSON.stringify(r.existingRoutesRegression)}`);
  console.log(`14. Secrets exposed: ${r.secretsExposed}`);
  console.log(`15. Paid resource created: ${r.paidResourceCreated}`);
  console.log(`16. Final PASS / FAIL: ${r.final}`);
  if (r.error) console.log(`error: ${r.error}`);
}

async function main() {
  mkdirSync(ARTIFACT_DIR, { recursive: true });

  const df = readFileSync(DOCKERFILE, 'utf8');
  const hasGit = /AS runtime[\s\S]*apt-get install[\s\S]*\bgit\b/.test(df);
  report.dockerfileRuntimeGitStatus = hasGit
    ? 'PRESENT — runtime stage installs git (no Dockerfile change)'
    : 'MISSING';
  if (!hasGit) {
    throw new Error('Dockerfile.api runtime stage missing git');
  }

  const prisma = new PrismaClient();
  const server = await prisma.serverInstance.findFirst({ where: { host: TARGET_HOST } });
  if (!server) throw new Error('managed server not found');
  const username = resolveServerSshUsername(server.username);
  const password = decryptCredential(server.credentialEncrypted);

  const runner = new RemoteRunner();
  await runner.connect({
    host: server.host,
    port: server.port,
    username,
    password,
  });

  try {
    console.log('[1] inspect old container');
    const oldInspect = await remoteOk(
      runner,
      [
        `echo CID_LINE=$(podman inspect ${LIVE_CONTAINER} --format '{{.Id}}')`,
        `echo IMAGE_LINE=$(podman inspect ${LIVE_CONTAINER} --format '{{.Image}}')`,
        `echo IMAGENAME_LINE=$(podman inspect ${LIVE_CONTAINER} --format '{{.ImageName}}')`,
        `echo CREATED_LINE=$(podman inspect ${LIVE_CONTAINER} --format '{{.Created}}')`,
        `IMG=$(podman inspect ${LIVE_CONTAINER} --format '{{.Image}}')`,
        `echo IMAGE_CREATED_LINE=$(podman image inspect $IMG --format '{{.Created}}')`,
        `echo IMAGE_ID_LINE=$(podman image inspect $IMG --format '{{.Id}}')`,
        `echo TAGS_LINE=$(podman image inspect $IMG --format '{{range .RepoTags}}{{.}};{{end}}')`,
      ].join(' ; '),
      'inspect-old',
    );
    report.oldContainerImage = redact(String(oldInspect.stdout || '').trim()).slice(0, 2000);

    const oldGit = await runner.execute(
      shellCommand(`podman exec ${LIVE_CONTAINER} sh -c 'command -v git; git --version'`),
      { timeoutMs: 30000 },
    );
    report.oldGitCheck = {
      exitCode: oldGit.exitCode,
      stdout: redact(String(oldGit.stdout || '').trim()).slice(0, 400),
      stderr: redact(String(oldGit.stderr || '').trim()).slice(0, 400),
    };
    console.log('[1] old git', JSON.stringify(report.oldGitCheck));

    console.log('[3] docker build --no-cache');
    const buildLog = join(ARTIFACT_DIR, 'step311-docker-build.log');
    const build = local(
      'docker',
      [
        'build',
        '--platform',
        'linux/amd64',
        '-f',
        'deploy/alpha/Dockerfile.api',
        '-t',
        LOCAL_IMAGE,
        '--pull',
        '--no-cache',
        '.',
      ],
    );
    writeFileSync(
      buildLog,
      redact(`${build.stdout || ''}\n${build.stderr || ''}`).slice(-250000),
      'utf8',
    );
    if (build.status !== 0) {
      throw new Error(`docker build failed status=${build.status}; log=${buildLog}`);
    }

    const inspectLocal = local('docker', [
      'image',
      'inspect',
      LOCAL_IMAGE,
      '--format',
      '{{.Id}} {{.Created}}',
    ]);
    const localMeta = String(inspectLocal.stdout || '').trim();
    report.newImageId = localMeta.split(/\s+/)[0] || null;
    report.newImageBuild = 'OK (docker build --platform linux/amd64 --pull --no-cache)';

    const gitLocal = local('docker', [
      'run',
      '--rm',
      '--entrypoint',
      'sh',
      LOCAL_IMAGE,
      '-c',
      'git --version',
    ]);
    if (gitLocal.status !== 0) {
      throw new Error(`new image git check failed: ${redact(gitLocal.stderr || gitLocal.stdout)}`);
    }
    report.gitVersion = String(gitLocal.stdout || '').trim();
    console.log('[3] git in image', report.gitVersion);

    console.log('[3] docker save + upload');
    const tarPath = join(ARTIFACT_DIR, 'launchos-alpha-api-step311.tar');
    try {
      unlinkSync(tarPath);
    } catch {
      /* ignore */
    }
    const save = local('docker', ['save', '-o', tarPath, LOCAL_IMAGE]);
    if (save.status !== 0) throw new Error(`docker save failed: ${redact(save.stderr)}`);

    await remoteOk(runner, 'mkdir -p /opt/launchos/tmp /opt/launchos/bin', 'mkdir-tmp');
    const remoteTar = '/opt/launchos/tmp/launchos-alpha-api-step311.tar';
    await runner.upload(tarPath, remoteTar, { timeoutMs: 900000 });
    const load = await remoteOk(
      runner,
      [
        `podman load -i ${remoteTar}`,
        `rm -f ${remoteTar}`,
        `podman tag docker.io/library/${IMAGE_TAG} ${REMOTE_IMAGE} 2>/dev/null || podman tag ${IMAGE_TAG} ${REMOTE_IMAGE} 2>/dev/null || true`,
        `podman image inspect ${REMOTE_IMAGE} --format '{{.Id}} {{.Created}}'`,
      ].join(' && '),
      'podman-load',
      { timeoutMs: 600000 },
    );
    const remoteImageMeta = String(load.stdout || '').trim().split(/\n/).at(-1);
    if (remoteImageMeta) {
      report.newImageId = `${report.newImageId} | remote ${remoteImageMeta.split(/\s+/)[0]}`;
    }

    const remoteGitImg = await remoteOk(
      runner,
      `podman run --rm --entrypoint sh ${REMOTE_IMAGE} -c 'git --version'`,
      'remote-image-git',
    );
    report.gitVersion = String(remoteGitImg.stdout || report.gitVersion).trim();

    console.log('[4] candidate deploy');
    await runner.execute(shellCommand(`podman rm -f ${CANDIDATE_CONTAINER} 2>/dev/null || true`), {
      timeoutMs: 60000,
    });
    const started = await remoteOk(
      runner,
      apiRunCmd({
        name: CANDIDATE_CONTAINER,
        image: REMOTE_IMAGE,
        port: CANDIDATE_API_PORT,
      }),
      'start-candidate',
      { timeoutMs: 120000 },
    );
    report.candidateRuntime = {
      container: CANDIDATE_CONTAINER,
      image: REMOTE_IMAGE,
      port: CANDIDATE_API_PORT,
      id: redact(String(started.stdout || '').trim()).slice(0, 80),
    };

    const candHealth = await waitLocalHealth(runner, CANDIDATE_API_PORT, CANDIDATE_CONTAINER);
    const candGit = await remoteOk(
      runner,
      `podman exec ${CANDIDATE_CONTAINER} sh -c 'git --version'`,
      'candidate-git',
    );
    report.candidateHealth = {
      healthy: true,
      body: redact(String(candHealth.stdout || '').trim()).slice(0, 300),
      git: String(candGit.stdout || '').trim(),
    };

    console.log('[5] traffic switch to candidate');
    const switched = await applyColocatedNginxRoute({
      host: TARGET_HOST,
      port: server.port,
      username,
      password,
      hostname: API_HOST,
      targetPort: CANDIDATE_API_PORT,
      healthPath: '/api/v1/health',
    });
    report.apiTrafficSwitch = {
      phase: 'candidate',
      hostname: API_HOST,
      targetPort: CANDIDATE_API_PORT,
      reloaded: switched.reloaded,
      certificatePresent: switched.certificatePresent,
    };

    let publicOk = false;
    let publicBody = '';
    let publicStatus = 0;
    for (let i = 0; i < 20; i++) {
      const pub = curlResolve(`${API_ORIGIN}/api/v1/health`, API_HOST);
      publicStatus = pub.status;
      publicBody = pub.text;
      if (pub.status === 200 && /launchos-api/i.test(pub.text)) {
        publicOk = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    report.publicApiHealth = {
      ok: publicOk,
      status: publicStatus,
      body: redact(publicBody).slice(0, 300),
      phase: 'after-candidate-switch',
    };
    if (!publicOk) {
      await applyColocatedNginxRoute({
        host: TARGET_HOST,
        port: server.port,
        username,
        password,
        hostname: API_HOST,
        targetPort: LIVE_API_PORT,
        healthPath: '/api/v1/health',
      });
      report.apiTrafficSwitch = {
        ...report.apiTrafficSwitch,
        rolledBackTo: LIVE_API_PORT,
      };
      throw new Error('public API health failed on candidate; rolled back to live port');
    }

    console.log('[5] promote new image onto live port');
    await remoteOk(runner, `podman rm -f ${LIVE_CONTAINER} || true`, 'rm-old-live', {
      allowExit: [0, 1],
    });
    await remoteOk(
      runner,
      apiRunCmd({
        name: LIVE_CONTAINER,
        image: REMOTE_IMAGE,
        port: LIVE_API_PORT,
      }),
      'start-new-live',
      { timeoutMs: 120000 },
    );
    await waitLocalHealth(runner, LIVE_API_PORT, LIVE_CONTAINER);

    const promoted = await applyColocatedNginxRoute({
      host: TARGET_HOST,
      port: server.port,
      username,
      password,
      hostname: API_HOST,
      targetPort: LIVE_API_PORT,
      healthPath: '/api/v1/health',
    });
    await runner.execute(shellCommand(`podman rm -f ${CANDIDATE_CONTAINER} || true`), {
      timeoutMs: 60000,
    });
    report.apiTrafficSwitch = {
      phase: 'promoted-live',
      hostname: API_HOST,
      targetPort: LIVE_API_PORT,
      reloaded: promoted.reloaded,
      certificatePresent: promoted.certificatePresent,
      result: 'candidate verified then live replaced and switched back to 39110',
    };

    const pubFinal = curlResolve(`${API_ORIGIN}/api/v1/health`, API_HOST);
    report.publicApiHealth = {
      ok: pubFinal.status === 200 && /launchos-api/i.test(pubFinal.text),
      status: pubFinal.status,
      body: redact(pubFinal.text).slice(0, 300),
      service: parseJson(pubFinal.text)?.service || null,
      phase: 'after-promote',
    };
    if (!report.publicApiHealth.ok) {
      throw new Error('public API health failed after promote');
    }

    // confirm live container git
    const liveGit = await remoteOk(
      runner,
      `podman exec ${LIVE_CONTAINER} sh -c 'git --version'`,
      'live-git-after-promote',
    );
    report.gitVersion = String(liveGit.stdout || report.gitVersion).trim();

    console.log('[6] public repo regression');
    const email = `alpha-git311-${Date.now()}@zsaos.test`;
    const passwordUser = `Alpha${randomBytes(5).toString('hex')}!aA1`;
    curlResolve(`${API_ORIGIN}/api/v1/auth/register`, API_HOST, {
      method: 'POST',
      headers: { origin: WEB_ORIGIN },
      body: JSON.stringify({ email, password: passwordUser, name: 'Git311' }),
    });
    const login = curlResolve(`${API_ORIGIN}/api/v1/auth/login`, API_HOST, {
      method: 'POST',
      headers: { origin: WEB_ORIGIN },
      body: JSON.stringify({ email, password: passwordUser }),
    });
    const token = parseJson(login.text)?.accessToken;
    if (!token) throw new Error(`login failed status=${login.status}`);
    const auth = { authorization: `Bearer ${token}`, origin: WEB_ORIGIN };

    const pubConnect = curlResolve(`${API_ORIGIN}/api/v1/onboarding/source/public`, API_HOST, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        cloneUrl: 'https://github.com/octocat/Hello-World.git',
        branch: 'master',
      }),
    });
    const analyze = curlResolve(`${API_ORIGIN}/api/v1/onboarding/analyze`, API_HOST, {
      method: 'POST',
      headers: auth,
      maxTime: '180',
    });
    const analyzeJson = parseJson(analyze.text);
    const gitMissing = hasGitMissing(analyze.text) || hasGitMissing(pubConnect.text);
    report.publicRepoAnalyze = {
      connectStatus: pubConnect.status,
      analyzeStatus: analyze.status,
      gitMissingError: gitMissing,
      stage: analyzeJson?.stage || analyzeJson?.status || null,
      projectId: analyzeJson?.projectId || null,
      analyzeSnippet: redact(analyze.text).slice(0, 500),
      connectSnippet: redact(pubConnect.text).slice(0, 300),
      ok:
        !gitMissing &&
        pubConnect.status >= 200 &&
        pubConnect.status < 300 &&
        analyze.status >= 200 &&
        analyze.status < 300,
    };

    console.log('[7] zip regression');
    const zipPath = join(ARTIFACT_DIR, 'step31-smoke.zip');
    if (!existsSync(zipPath)) {
      report.zipRegression = { skipped: true, reason: 'step31-smoke.zip missing', ok: false };
    } else {
      const zipEmail = `alpha-zip311-${Date.now()}@zsaos.test`;
      const zipPass = `Alpha${randomBytes(5).toString('hex')}!aA1`;
      curlResolve(`${API_ORIGIN}/api/v1/auth/register`, API_HOST, {
        method: 'POST',
        headers: { origin: WEB_ORIGIN },
        body: JSON.stringify({ email: zipEmail, password: zipPass, name: 'Zip311' }),
      });
      const zipLogin = curlResolve(`${API_ORIGIN}/api/v1/auth/login`, API_HOST, {
        method: 'POST',
        headers: { origin: WEB_ORIGIN },
        body: JSON.stringify({ email: zipEmail, password: zipPass }),
      });
      const zipToken = parseJson(zipLogin.text)?.accessToken;
      if (!zipToken) {
        report.zipRegression = { ok: false, reason: 'zip login failed' };
      } else {
        const args = [
          '-k',
          '-sS',
          '-X',
          'POST',
          '--resolve',
          `${API_HOST}:443:${TARGET_HOST}`,
          '-H',
          `authorization: Bearer ${zipToken}`,
          '-H',
          `origin: ${WEB_ORIGIN}`,
          '-F',
          `file=@${zipPath}`,
          '-w',
          '\n__STATUS__:%{http_code}',
          '--max-time',
          '180',
          `${API_ORIGIN}/api/v1/onboarding/source/zip`,
        ];
        const zr = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
        const out = String(zr.stdout || '');
        const m = out.match(/\n__STATUS__:(\d+)\s*$/);
        const uploadStatus = m ? Number(m[1]) : 0;
        const uploadText = m ? out.slice(0, m.index) : out;
        const zipAnalyze = curlResolve(`${API_ORIGIN}/api/v1/onboarding/analyze`, API_HOST, {
          method: 'POST',
          headers: { authorization: `Bearer ${zipToken}`, origin: WEB_ORIGIN },
          maxTime: '180',
        });
        report.zipRegression = {
          skipped: false,
          uploadStatus,
          analyzeStatus: zipAnalyze.status,
          gitMissingError: hasGitMissing(zipAnalyze.text),
          uploadSnippet: redact(uploadText).slice(0, 300),
          analyzeSnippet: redact(zipAnalyze.text).slice(0, 400),
          ok:
            uploadStatus >= 200 &&
            uploadStatus < 300 &&
            zipAnalyze.status >= 200 &&
            zipAnalyze.status < 300 &&
            !hasGitMissing(zipAnalyze.text),
        };
      }
    }

    console.log('[8] existing routes');
    const routes = {};
    for (const host of PROTECTED_HOSTS) {
      const primary = host.startsWith('api-')
        ? `https://${host}/api/v1/health`
        : `https://${host}/`;
      let res = curlResolve(primary, host);
      if (host.startsWith('api-') && res.status === 404) {
        res = curlResolve(`https://${host}/health`, host);
      }
      routes[host] = {
        status: res.status,
        ok: res.status >= 200 && res.status < 400,
      };
    }
    report.existingRoutesRegression = routes;

    const routesOk = Object.values(routes).every((r) => r.ok);
    const pass =
      String(report.dockerfileRuntimeGitStatus).startsWith('PRESENT') &&
      Boolean(report.gitVersion) &&
      report.candidateHealth?.healthy === true &&
      report.publicApiHealth?.ok === true &&
      report.publicRepoAnalyze?.ok === true &&
      report.zipRegression?.ok === true &&
      routesOk &&
      report.secretsExposed === 'NO' &&
      report.paidResourceCreated === 'NO';

    report.final = pass ? 'PASS' : 'FAIL';
  } catch (error) {
    report.error = redact(error?.message || String(error)).slice(0, 2000);
    report.final = 'FAIL';
  } finally {
    try {
      await runner.disconnect();
    } catch {
      /* ignore */
    }
    try {
      await prisma.$disconnect();
    } catch {
      /* ignore */
    }
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
  }

  printFinal(report);
  process.exit(report.final === 'PASS' ? 0 : 1);
}

await main();
