/**
 * Step 23.11 wait/probe — READ ONLY.
 *
 * Does NOT:
 * - create repositories
 * - push / commit / modify user repos
 * - request Contents write or Administration
 *
 * Waits until developer manually creates private `launchos-multi-demo`
 * and grants it to the LaunchOS Dev GitHub App (selected repos).
 */
const fs = require('fs');
const path = require('path');

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
    .replace(/-----BEGIN[\s\S]*?PRIVATE KEY-----/g, '***PRIVATE_KEY***');
}

loadEnv();

const { PrismaClient } = require('../generated/client');
const {
  createGitHubAppJwt,
  createInstallationAccessToken,
  listInstallationRepositories,
} = require('../../github/dist');
const { ProjectAnalyzer, resolveUnitPath } = require('../../analyzer/dist');

const REPO_NAME = 'launchos-multi-demo';
const DEMO = path.resolve(__dirname, '../../../.tools/launchos-multi-demo');
const OUT = path.resolve(__dirname, '../../../.tools/step2311-wait-probe.json');

const p = new PrismaClient();

async function main() {
  const report = {
    startedAt: new Date().toISOString(),
    mode: 'read-only-wait',
    policy: {
      contents: 'read',
      metadata: 'read',
      createRepo: false,
      pushCode: false,
      modifyUserRepos: false,
    },
    checks: {},
  };

  const conn = await p.gitProviderConnection.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { updatedAt: 'desc' },
  });
  if (!conn) {
    report.error = 'No ACTIVE GitProviderConnection';
    finish(report);
    return;
  }

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
  const instBody = await instRes.json();
  report.appJwtOk = instRes.ok;
  report.connectionStatus = conn.status;
  report.account = instBody.account?.login || conn.login || null;
  report.permissions = instBody.permissions || null;
  report.repositorySelection = instBody.repository_selection || null;
  report.checks.readOnlyPermissions =
    (instBody.permissions?.contents || '') === 'read' &&
    (instBody.permissions?.metadata || '') === 'read';

  const tok = await createInstallationAccessToken(conn.installationId);
  report.checks.tokenIssued = Boolean(tok.token);
  report.tokenExpiresAt = tok.expiresAt;

  const repos = await listInstallationRepositories(tok.token);
  report.repoCount = repos.length;
  report.repos = repos.map((r) => ({
    fullName: r.fullName,
    private: r.private,
    defaultBranch: r.defaultBranch,
  }));

  const demo = repos.find(
    (r) => r.name === REPO_NAME || r.fullName.endsWith(`/${REPO_NAME}`),
  );
  if (!demo) {
    report.launchosMultiDemo = { found: false };
    report.waitingForDeveloper = true;
    report.nextSteps = [
      '在 GitHub 网页手动创建 private 仓库 launchos-multi-demo',
      '用本人 Git CLI / Desktop / 网页上传 .tools/launchos-multi-demo 内容（不要用 LaunchOS App push）',
      '在 GitHub App installation → Only select repositories 中勾选 launchos-multi-demo',
      '再运行本脚本：node packages/database/scripts/step2311-wait-probe.js',
    ];
  } else {
    // Confirm private via repo API (read metadata)
    const metaRes = await fetch(`https://api.github.com/repos/${demo.fullName}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${tok.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'LaunchOS',
      },
    });
    const meta = await metaRes.json();
    report.launchosMultiDemo = {
      found: true,
      fullName: demo.fullName,
      private: Boolean(meta.private ?? demo.private),
      apiPrivate: meta.private ?? null,
      defaultBranch: meta.default_branch || demo.defaultBranch,
      htmlUrl: meta.html_url || demo.htmlUrl,
      metaStatus: metaRes.status,
    };
    report.checks.privateTrue = report.launchosMultiDemo.private === true;
    report.waitingForDeveloper = !report.checks.privateTrue;
    if (!report.checks.privateTrue) {
      report.nextSteps = [
        '仓库已授权但 private!=true，请将 launchos-multi-demo 设为 Private 后重试',
      ];
    }
  }

  // Local fixture still intact (developer push source)
  report.localFixture = {
    present:
      fs.existsSync(path.join(DEMO, 'apps/web/index.html')) &&
      fs.existsSync(path.join(DEMO, 'apps/api/server.js')),
    path: DEMO,
  };

  const analyzer = new ProjectAnalyzer();
  const local = await analyzer.analyzeRepository(DEMO);
  report.localScan = {
    unitCount: (local.units || []).length,
    units: (local.units || []).map((u) => ({
      name: u.name,
      type: u.type,
      rootPath: u.rootPath,
      framework: u.framework,
      deployable: u.deployable,
    })),
    noRootUnit: !(local.units || []).some((u) => u.rootPath === '.'),
  };
  report.checks.localTwoUnits = report.localScan.unitCount === 2;
  let trav = false;
  try {
    resolveUnitPath(DEMO, '../outside');
  } catch {
    trav = true;
  }
  report.checks.traversalRejected = trav;

  report.readyForE2E =
    Boolean(demo) &&
    report.checks.privateTrue === true &&
    report.checks.readOnlyPermissions === true &&
    report.checks.tokenIssued === true;

  if (report.readyForE2E) {
    report.nextSteps = [
      'private repo 已就绪。运行：node packages/database/scripts/step2311-e2e-readonly.js',
    ];
  }

  report.finishedAt = new Date().toISOString();
  finish(report);
}

function finish(report) {
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch(async (e) => {
    const report = {
      error: redact(e instanceof Error ? e.message : e),
      waitingForDeveloper: true,
    };
    finish(report);
    process.exitCode = 1;
  })
  .finally(() => p.$disconnect());
