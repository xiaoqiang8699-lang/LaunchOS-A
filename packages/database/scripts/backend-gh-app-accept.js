const fs = require('fs');
const path = require('path');
const os = require('os');

function loadEnv() {
  const envPath = path.resolve(__dirname, '../../../.env');
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}

function redact(s) {
  return String(s || '')
    .replace(/ghs_[A-Za-z0-9_]+/g, '***')
    .replace(/ghp_[A-Za-z0-9_]+/g, '***')
    .replace(/-----BEGIN[\s\S]*?PRIVATE KEY-----/g, '***PRIVATE_KEY***')
    .replace(/x-access-token:[^\s@]+/gi, 'x-access-token:***')
    .replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//***:***@');
}

loadEnv();

const { PrismaClient } = require('../generated/client');
const {
  createInstallationAccessToken,
  listInstallationRepositories,
  getInstallation,
  isGitHubAppConfigured,
  readGitHubAppConfig,
} = require('../../github/dist');
const { GitService } = require('../../git/dist');
const { ProjectAnalyzer, isMobileFramework, isWebDeployableFramework } = require('../../analyzer/dist');

const p = new PrismaClient();
const report = {};

async function main() {
  const cfg = readGitHubAppConfig();
  report.githubAppConfigured = isGitHubAppConfigured();
  report.githubAppSlug = cfg?.slug || null;
  report.hasPrivateKeyConfigured = Boolean(cfg?.privateKey);

  const connections = await p.gitProviderConnection.findMany({
    select: {
      id: true,
      provider: true,
      installationId: true,
      status: true,
      login: true,
      accountType: true,
      workspaceId: true,
      userId: true,
      updatedAt: true,
      workspace: { select: { id: true, name: true } },
      user: { select: { id: true, email: true } },
      sources: {
        select: {
          id: true,
          url: true,
          branch: true,
          isPrivate: true,
          connectionId: true,
          fullName: true,
          authStatus: true,
          projectId: true,
        },
      },
    },
    orderBy: { updatedAt: 'desc' },
  });

  report.connectionCount = connections.length;
  report.connections = connections.map((c) => ({
    id: c.id,
    provider: c.provider,
    status: c.status,
    installationIdPresent: Boolean(c.installationId),
    installationIdSuffix: c.installationId ? String(c.installationId).slice(-4) : null,
    login: c.login,
    accountType: c.accountType,
    workspaceId: c.workspaceId,
    workspaceName: c.workspace?.name || null,
    userEmail: c.user?.email || null,
    sourceCount: c.sources.length,
    sources: c.sources.map((s) => ({
      fullName: s.fullName,
      url: s.url,
      branch: s.branch,
      isPrivate: s.isPrivate,
      connectionIdLinked: Boolean(s.connectionId) && s.connectionId === c.id,
      authStatus: s.authStatus,
      projectId: s.projectId,
    })),
  }));

  const active = connections.find((c) => c.status === 'ACTIVE') || connections[0];
  if (!active) {
    report.error = 'No GitProviderConnection found';
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  report.primary = {
    status: active.status,
    provider: active.provider,
    installationIdPresent: Boolean(active.installationId),
    installationIdSuffix: active.installationId ? String(active.installationId).slice(-4) : null,
  };

  // Installation existence check (no token print)
  try {
    const inst = await getInstallation(active.installationId);
    report.installationExists = true;
    report.installationAccount = {
      login: inst.accountLogin,
      type: inst.accountType,
    };
  } catch (e) {
    report.installationExists = false;
    report.installationError = redact(e instanceof Error ? e.message : String(e));
  }

  // Token mint
  try {
    const issued = await createInstallationAccessToken(active.installationId);
    const ok = Boolean(issued?.token) && String(issued.token).length > 20;
    report.installationTokenGenerated = ok;
    report.installationTokenLog = ok
      ? 'installation token generated successfully'
      : 'installation token generation returned empty';
    report.installationTokenExpiresAt = issued?.expiresAt || null;

    if (!ok) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    // List repos
    const repos = await listInstallationRepositories(issued.token);
    report.repoApiSuccess = true;
    report.repoCount = repos.length;
    report.repos = repos.map((r) => ({
      fullName: r.fullName,
      private: r.private,
      defaultBranch: r.defaultBranch,
    }));
    report.xiaoqiangInList = repos.some(
      (r) => r.fullName === 'xiaoqiang8699-lang/Xiaoqiang-APP' || r.name === 'Xiaoqiang-APP',
    );

    const target =
      repos.find((r) => r.fullName === 'xiaoqiang8699-lang/Xiaoqiang-APP') ||
      repos.find((r) => /Xiaoqiang-APP/i.test(r.fullName)) ||
      null;
    if (!target) {
      report.cloneSkipped = 'Xiaoqiang-APP not in authorized repository list';
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    report.targetRepo = {
      fullName: target.fullName,
      private: target.private,
      defaultBranch: target.defaultBranch,
      cloneUrlHostOnly: 'https://github.com/xiaoqiang8699-lang/Xiaoqiang-APP.git',
    };

    const git = new GitService();
    const auth = { username: 'x-access-token', token: issued.token };

    // detect
    try {
      const detected = await git.detectRepository(target.cloneUrl || target.htmlUrl?.replace(/\/$/, '') + '.git' || `https://github.com/${target.fullName}.git`, { auth });
      report.detect = {
        success: true,
        defaultBranch: detected.defaultBranch || detected.branch || null,
        reachable: detected.reachable ?? true,
      };
    } catch (e) {
      // try with constructed url
      try {
        const detected = await git.detectRepository(`https://github.com/${target.fullName}.git`, { auth });
        report.detect = {
          success: true,
          defaultBranch: detected.defaultBranch || detected.branch || null,
          reachable: detected.reachable ?? true,
        };
      } catch (e2) {
        report.detect = {
          success: false,
          error: redact(e2 instanceof Error ? e2.message : String(e2)),
        };
      }
    }

    // clone into temp dir
    const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'launchos-app-auth-clone-'));
    report.cloneDir = cloneDir;
    const branch = report.detect?.defaultBranch || target.defaultBranch || 'master';
    try {
      await git.cloneRepository(
        `https://github.com/${target.fullName}.git`,
        cloneDir,
        branch,
        { auth },
      );
      await git.checkoutBranch(cloneDir, branch, { auth });
      const commit = await git.getCommitInfo(cloneDir);
      // ensure no token in remotes
      let remoteUrl = '';
      try {
        remoteUrl = require('child_process').execSync('git remote get-url origin', { cwd: cloneDir, encoding: 'utf8' }).trim();
      } catch {}
      report.clone = {
        success: true,
        branch,
        commitSha: commit?.sha || commit?.shortSha || null,
        remoteContainsToken: /ghs_|ghp_|x-access-token:|@github\.com/.test(remoteUrl) && /ghs_|ghp_|x-access-token:/.test(remoteUrl),
        remoteUrlRedacted: redact(remoteUrl),
      };

      const analyzer = new ProjectAnalyzer();
      const analysis = await analyzer.analyzeRepository(cloneDir);
      report.analyzer = {
        projectType: analysis.projectType,
        framework: analysis.framework,
        confidence: analysis.confidence,
        summary: analysis.summary || null,
        isMobile: isMobileFramework(analysis.framework),
        webDeployable: isWebDeployableFramework(analysis.framework),
      };
      report.blocksWebDeploy = isMobileFramework(analysis.framework) || !isWebDeployableFramework(analysis.framework);
    } catch (e) {
      report.clone = {
        success: false,
        error: redact(e instanceof Error ? e.message : String(e)),
      };
    } finally {
      try {
        fs.rmSync(cloneDir, { recursive: true, force: true });
      } catch {}
    }
  } catch (e) {
    report.installationTokenGenerated = false;
    report.installationTokenLog = redact(e instanceof Error ? e.message : String(e));
    report.repoApiSuccess = false;
  }

  // Also check project frameworks for 照型 / Xiaoqiang in DB
  const projects = await p.project.findMany({
    where: {
      OR: [
        { name: { contains: '照型' } },
        { name: { contains: 'Xiaoqiang' } },
        { sources: { some: { url: { contains: 'Xiaoqiang-APP' } } } },
      ],
    },
    select: {
      id: true,
      name: true,
      framework: true,
      sources: { select: { connectionId: true, isPrivate: true, branch: true, fullName: true, authStatus: true } },
    },
  });
  report.relatedProjects = projects;

  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((e) => {
    console.error(JSON.stringify({ fatal: redact(e instanceof Error ? e.message : String(e)) }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await p.$disconnect();
  });
