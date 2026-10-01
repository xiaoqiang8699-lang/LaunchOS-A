/**
 * Step 23.11 E2E — READ ONLY GitHub App.
 *
 * Prerequisites (developer manual):
 * 1. Create private GitHub repo launchos-multi-demo
 * 2. Push .tools/launchos-multi-demo with personal Git (not App token)
 * 3. Grant repo to LaunchOS Dev App (selected repositories)
 *
 * This script NEVER creates repos or pushes code.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function loadEnv() {
  const envPath = path.resolve(__dirname, '../../../.env');
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[k] = v;
  }
}

function redact(s) {
  return String(s || '')
    .replace(/ghs_[A-Za-z0-9_]+/g, '***')
    .replace(/ghp_[A-Za-z0-9_]+/g, '***')
    .replace(/-----BEGIN[\s\S]*?PRIVATE KEY-----/g, '***PRIVATE_KEY***')
    .replace(/x-access-token:[^\s@]+/gi, 'x-access-token:***');
}

loadEnv();

const { PrismaClient } = require('../generated/client');
const {
  createInstallationAccessToken,
  listInstallationRepositories,
  createGitHubAppJwt,
} = require('../../github/dist');
const { GitService } = require('../../git/dist');
const { ProjectAnalyzer, resolveUnitPath } = require('../../analyzer/dist');

const REPO_NAME = 'launchos-multi-demo';
const OUT = path.resolve(__dirname, '../../../.tools/step2311-e2e-report.json');
const p = new PrismaClient();

async function main() {
  const report = {
    startedAt: new Date().toISOString(),
    mode: 'read-only-e2e',
    policy: {
      contents: 'read-only',
      metadata: 'read-only',
      launchosWritesUserRepos: false,
    },
    checks: {},
  };

  const conn = await p.gitProviderConnection.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { updatedAt: 'desc' },
  });
  if (!conn) throw new Error('No ACTIVE GitProviderConnection');

  const key = process.env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n');
  const jwt = createGitHubAppJwt(process.env.GITHUB_APP_ID, key);
  const instRes = await fetch(
    `https://api.github.com/app/installations/${encodeURIComponent(conn.installationId)}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jwt}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'LaunchOS',
      },
    },
  );
  const inst = await instRes.json();
  report.permissions = inst.permissions || null;
  report.checks.readOnlyOk =
    (inst.permissions?.contents || '') === 'read' &&
    (inst.permissions?.metadata || '') === 'read';

  const issued = await createInstallationAccessToken(conn.installationId);
  const repos = await listInstallationRepositories(issued.token);
  const demo = repos.find(
    (r) => r.name === REPO_NAME || r.fullName.endsWith(`/${REPO_NAME}`),
  );
  if (!demo) {
    report.waitingForDeveloper = true;
    report.error =
      'launchos-multi-demo 尚未出现在 installation 授权列表。请开发者手动创建 Private 仓并勾选授权。';
    finish(report);
    return;
  }

  const metaRes = await fetch(`https://api.github.com/repos/${demo.fullName}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${issued.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'LaunchOS',
    },
  });
  const meta = await metaRes.json();
  report.repo = {
    fullName: demo.fullName,
    private: Boolean(meta.private),
    defaultBranch: meta.default_branch || demo.defaultBranch || 'main',
    htmlUrl: meta.html_url || demo.htmlUrl,
  };
  report.checks.privateTrue = report.repo.private === true;
  if (!report.checks.privateTrue) {
    report.waitingForDeveloper = true;
    report.error = '授权仓库存在，但 private!=true';
    finish(report);
    return;
  }

  // Clone via App installation token (read-only) — never put token in remote URL logs
  const git = new GitService();
  const cloneDir = path.join(os.tmpdir(), `launchos-step2311-${Date.now()}`);
  fs.mkdirSync(path.dirname(cloneDir), { recursive: true });
  await git.cloneRepository(demo.cloneUrl || `https://github.com/${demo.fullName}.git`, cloneDir, report.repo.defaultBranch, {
    installationToken: issued.token,
  });
  if (report.repo.defaultBranch) {
    await git.checkoutBranch(cloneDir, report.repo.defaultBranch);
  }
  report.checks.cloneOk = fs.existsSync(path.join(cloneDir, '.git'));

  const analyzer = new ProjectAnalyzer();
  const analysis = await analyzer.analyzeRepository(cloneDir);
  const units = analysis.units || [];
  report.scan = {
    unitCount: units.length,
    units: units.map((u) => ({
      name: u.name,
      type: u.type,
      rootPath: u.rootPath,
      framework: u.framework,
      deployable: u.deployable,
    })),
    noRootUnit: !units.some((u) => u.rootPath === '.'),
  };
  report.checks.twoUnits = units.length === 2;
  report.checks.hasWeb = units.some((u) => u.rootPath === 'apps/web' && u.deployable);
  report.checks.hasApi = units.some((u) => u.rootPath === 'apps/api' && u.deployable);
  let trav = false;
  try {
    resolveUnitPath(cloneDir, '../outside');
  } catch {
    trav = true;
  }
  report.checks.traversalRejected = trav;

  report.phase = 'scan-complete';
  report.note =
    'Read-only clone + analyze OK. Remote deploy phases require running LaunchOS API/worker and continue in full E2E when services are up.';
  report.cloneDir = cloneDir;
  finish(report);
}

function finish(report) {
  report.finishedAt = new Date().toISOString();
  // never persist secrets
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch(async (e) => {
    finish({ error: redact(e instanceof Error ? e.message : e), waitingForDeveloper: true });
    process.exitCode = 1;
  })
  .finally(() => p.$disconnect());
