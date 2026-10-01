const { PrismaClient } = require('../generated/client');
const { existsSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const p = new PrismaClient();

function walkSignals(root, maxFiles = 8000) {
  const signals = {
    packageJson: false,
    xcodeproj: false,
    xcworkspace: false,
    podfile: false,
    packageSwift: false,
    infoPlist: false,
    iosDir: false,
    swiftCount: 0,
    sampleSwift: [],
    topLevel: [],
  };
  if (!existsSync(root)) {
    return { missing: true, signals };
  }
  try {
    signals.topLevel = readdirSync(root).slice(0, 40);
  } catch {
    signals.topLevel = [];
  }

  const stack = [root];
  let seen = 0;
  while (stack.length && seen < maxFiles) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (['node_modules', '.git', 'DerivedData', 'Pods', 'build', '.build'].includes(name)) {
        continue;
      }
      const full = join(dir, name);
      if (entry.isDirectory()) {
        if (name.toLowerCase() === 'ios') signals.iosDir = true;
        if (name.endsWith('.xcodeproj')) signals.xcodeproj = true;
        if (name.endsWith('.xcworkspace')) signals.xcworkspace = true;
        stack.push(full);
        continue;
      }
      seen += 1;
      const lower = name.toLowerCase();
      if (lower === 'package.json') signals.packageJson = true;
      if (lower === 'podfile') signals.podfile = true;
      if (lower === 'package.swift') signals.packageSwift = true;
      if (lower === 'info.plist') signals.infoPlist = true;
      if (lower.endsWith('.swift')) {
        signals.swiftCount += 1;
        if (signals.sampleSwift.length < 8) {
          signals.sampleSwift.push(full.slice(root.length + 1));
        }
      }
    }
  }
  return { missing: false, signals, filesScanned: seen };
}

async function dumpProject(id) {
  const project = await p.project.findUnique({ where: { id } });
  const sources = await p.sourceRepository.findMany({ where: { projectId: id } });
  const analyses = await p.projectAnalysis.findMany({
    where: { projectId: id },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  const deps = await p.deployment.findMany({
    where: { projectId: id },
    orderBy: { createdAt: 'desc' },
    take: 5,
    include: {
      steps: { orderBy: { order: 'asc' } },
      artifacts: true,
      remoteDeployments: true,
      logs: { orderBy: { createdAt: 'desc' }, take: 40 },
    },
  });
  const gitRoot = process.env.LAUNCHOS_GIT_ROOT || join(tmpdir(), 'launchos-repos');
  const repoPath = join(gitRoot, id);
  const scan = walkSignals(repoPath);
  return { project, sources, analyses, deps, repoPath, scan };
}

async function main() {
  const projects = await p.project.findMany({
    where: {
      OR: [
        { name: { contains: 'Xiaoqiang', mode: 'insensitive' } },
        { slug: { contains: 'xiaoqiang', mode: 'insensitive' } },
      ],
    },
    orderBy: { updatedAt: 'desc' },
  });
  console.log(
    'PROJECT_IDS',
    projects.map((pjt) => ({
      id: pjt.id,
      name: pjt.name,
      slug: pjt.slug,
      framework: pjt.framework,
      purpose: pjt.applicationPurpose,
      updatedAt: pjt.updatedAt,
    })),
  );

  for (const project of projects) {
    const dump = await dumpProject(project.id);
    console.log('==== PROJECT', project.id, project.slug, '====');
    console.log(
      JSON.stringify(
        {
          framework: dump.project.framework,
          purpose: dump.project.applicationPurpose,
          sources: dump.sources,
          analyses: dump.analyses.map((a) => ({
            framework: a.framework,
            packageManager: a.packageManager,
            buildCommand: a.buildCommand,
            startCommand: a.startCommand,
            confidence: a.confidence,
            createdAt: a.createdAt,
            repositoryPath: a.repositoryPath,
          })),
          repoPath: dump.repoPath,
          scan: dump.scan,
          deps: dump.deps.map((d) => ({
            id: d.id,
            status: d.status,
            createdAt: d.createdAt,
            startedAt: d.startedAt,
            finishedAt: d.finishedAt,
            errorMessage: d.errorMessage,
            uploadStatus: d.uploadStatus,
            uploadStartedAt: d.uploadStartedAt,
            uploadFinishedAt: d.uploadFinishedAt,
            uploadError: d.uploadError,
            steps: d.steps.map((s) => ({
              key: s.stepKey,
              name: s.name,
              status: s.status,
              startedAt: s.startedAt,
              finishedAt: s.finishedAt,
              errorMessage: s.errorMessage,
            })),
            artifacts: d.artifacts,
            remoteDeployments: d.remoteDeployments,
            recentLogs: d.logs.slice(0, 25).map((l) => ({
              level: l.level,
              message: String(l.message).slice(0, 300),
              createdAt: l.createdAt,
            })),
          })),
        },
        null,
        2,
      ),
    );
  }

  const running = await p.deployment.findMany({
    where: { status: { in: ['RUNNING', 'QUEUED', 'CREATED'] } },
    orderBy: { createdAt: 'desc' },
    take: 20,
    include: {
      project: { select: { name: true, slug: true } },
      steps: { orderBy: { order: 'asc' } },
    },
  });
  console.log(
    'RUNNING_ANY',
    JSON.stringify(
      running.map((d) => ({
        id: d.id,
        project: d.project,
        status: d.status,
        createdAt: d.createdAt,
        steps: d.steps.map((s) => ({ key: s.stepKey, name: s.name, status: s.status, startedAt: s.startedAt })),
      })),
      null,
      2,
    ),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await p.$disconnect();
  });
