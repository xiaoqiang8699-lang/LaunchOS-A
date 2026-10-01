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

loadEnv();

const { PrismaClient } = require('../generated/client');
const {
  createInstallationAccessToken,
  isGitHubAppConfigured,
} = require('../../github/dist');
const { GitService } = require('../../git/dist');
const { ProjectAnalyzer, resolveUnitPath } = require('../../analyzer/dist');

const p = new PrismaClient();

async function main() {
  const out = {
    githubAppConfigured: isGitHubAppConfigured(),
    projects: [],
    pathTraversalRejected: false,
  };

  try {
    resolveUnitPath(os.tmpdir(), '../outside');
  } catch {
    out.pathTraversalRejected = true;
  }

  const sources = await p.sourceRepository.findMany({
    where: {
      OR: [
        { fullName: { contains: 'Xiaoqiang', mode: 'insensitive' } },
        { url: { contains: 'Xiaoqiang', mode: 'insensitive' } },
      ],
    },
    include: {
      project: { select: { id: true, name: true, framework: true } },
      connection: {
        select: { id: true, installationId: true, status: true, login: true },
      },
    },
    take: 10,
  });

  out.sourceCount = sources.length;
  const git = new GitService();
  const analyzer = new ProjectAnalyzer();

  for (const source of sources) {
    const item = {
      projectId: source.projectId,
      projectName: source.project?.name,
      fullName: source.fullName,
      url: source.url,
      branch: source.branch,
      frameworkBefore: source.project?.framework,
      connectionStatus: source.connection?.status || null,
      units: [],
      error: null,
    };

    try {
      const dir = path.join(os.tmpdir(), 'launchos-step239', source.projectId);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dir), { recursive: true });

      let token = null;
      if (source.connection?.installationId) {
        const tok = await createInstallationAccessToken(source.connection.installationId);
        token = tok.token;
      }

      await git.cloneRepository(source.url, dir, source.branch || 'master', {
        installationToken: token || undefined,
      });
      if (source.branch) {
        await git.checkoutBranch(dir, source.branch);
      }

      const result = await analyzer.analyzeRepository(dir);
      item.analysis = {
        projectType: result.projectType,
        framework: result.framework,
        primaryUnitPath: result.primaryUnitPath,
        unitCount: (result.units || []).length,
      };
      item.units = (result.units || []).map((u) => ({
        name: u.name,
        type: u.type,
        rootPath: u.rootPath,
        framework: u.framework,
        deployable: u.deployable,
        confidence: u.confidence,
      }));
      item.topLevel = fs.readdirSync(dir).slice(0, 40);

      // Persist units via same shape as analyses.service if table exists
      for (const unit of result.units || []) {
        await p.deployableUnit.upsert({
          where: {
            projectId_rootPath: {
              projectId: source.projectId,
              rootPath: unit.rootPath,
            },
          },
          create: {
            projectId: source.projectId,
            sourceRepositoryId: source.id,
            name: unit.name,
            type: unit.type,
            rootPath: unit.rootPath,
            framework: unit.framework,
            packageManager: unit.packageManager,
            buildCommand: unit.buildCommand,
            startCommand: unit.startCommand,
            outputPath: unit.outputPath,
            port: unit.port,
            deployable: unit.deployable,
            confidence: unit.confidence,
            status: unit.deployable ? 'DETECTED' : 'UNSUPPORTED',
            metadata: {},
          },
          update: {
            name: unit.name,
            type: unit.type,
            framework: unit.framework,
            packageManager: unit.packageManager,
            buildCommand: unit.buildCommand,
            startCommand: unit.startCommand,
            outputPath: unit.outputPath,
            port: unit.port,
            deployable: unit.deployable,
            confidence: unit.confidence,
            status: unit.deployable ? 'DETECTED' : 'UNSUPPORTED',
          },
        });
      }

      if (result.framework && result.framework !== 'UNSUPPORTED') {
        await p.project.update({
          where: { id: source.projectId },
          data: { framework: result.framework },
        });
      }
    } catch (err) {
      item.error = String(err && err.message ? err.message : err);
    }

    out.projects.push(item);
  }

  const outPath = path.resolve(__dirname, '../../../.tools/step239-xiaoqiang-scan.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  await p.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await p.$disconnect();
  process.exit(1);
});
