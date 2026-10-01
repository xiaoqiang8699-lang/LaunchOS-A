const { PrismaClient } = require('@launchos/database');
const { existsSync, readdirSync, statSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const p = new PrismaClient();

function walkSignals(root, maxFiles = 4000) {
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
  };
  if (!existsSync(root)) {
    return { missing: true, signals };
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
      if (name === 'node_modules' || name === '.git' || name === 'DerivedData' || name === 'Pods') {
        continue;
      }
      const full = join(dir, name);
      if (entry.isDirectory()) {
        if (name.toLowerCase() === 'ios') signals.iosDir = true;
        stack.push(full);
        continue;
      }
      seen += 1;
      const lower = name.toLowerCase();
      if (lower === 'package.json') signals.packageJson = true;
      if (lower.endsWith('.xcodeproj') || name.endsWith('.xcodeproj')) signals.xcodeproj = true;
      // xcodeproj is a directory usually
      if (lower === 'podfile') signals.podfile = true;
      if (lower === 'package.swift') signals.packageSwift = true;
      if (lower === 'info.plist') signals.infoPlist = true;
      if (lower.endsWith('.swift')) {
        signals.swiftCount += 1;
        if (signals.sampleSwift.length < 5) signals.sampleSwift.push(full.slice(root.length + 1));
      }
      if (lower.endsWith('.xcworkspace')) signals.xcworkspace = true;
    }
  }

  // also check directories ending with .xcodeproj
  const stack2 = [root];
  let dSeen = 0;
  while (stack2.length && dSeen < 2000) {
    const dir = stack2.pop();
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (['node_modules', '.git', 'DerivedData', 'Pods'].includes(entry.name)) continue;
      dSeen += 1;
      const full = join(dir, entry.name);
      if (entry.name.endsWith('.xcodeproj')) signals.xcodeproj = true;
      if (entry.name.endsWith('.xcworkspace')) signals.xcworkspace = true;
      stack2.push(full);
    }
  }

  return { missing: false, signals, filesScanned: seen };
}

async function main() {
  let projects = await p.project.findMany({
    where: {
      OR: [
        { name: { contains: 'Xiaoqiang', mode: 'insensitive' } },
        { slug: { contains: 'xiaoqiang', mode: 'insensitive' } },
      ],
    },
    select: {
      id: true,
      name: true,
      slug: true,
      applicationPurpose: true,
      framework: true,
      defaultBranch: true,
      sourceUrl: true,
      repositoryUrl: true,
    },
  });

  if (!projects.length) {
    projects = await p.project.findMany({
      orderBy: { updatedAt: 'desc' },
      take: 15,
      select: {
        id: true,
        name: true,
        slug: true,
        applicationPurpose: true,
        framework: true,
        defaultBranch: true,
        sourceUrl: true,
        repositoryUrl: true,
      },
    });
    console.log('RECENT_PROJECTS', JSON.stringify(projects, null, 2));
  } else {
    console.log('PROJECTS', JSON.stringify(projects, null, 2));
  }

  const target =
    projects.find((item) => /xiaoqiang/i.test(item.name) || /xiaoqiang/i.test(item.slug)) ||
    projects[0];
  if (!target) {
    console.log('NO_PROJECT');
    return;
  }

  const id = target.id;
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
      logs: { orderBy: { createdAt: 'desc' }, take: 30 },
    },
  });

  const gitRoot = process.env.LAUNCHOS_GIT_ROOT || join(tmpdir(), 'launchos-repos');
  const repoPath = join(gitRoot, id);
  const scan = walkSignals(repoPath);

  console.log('TARGET', JSON.stringify(target, null, 2));
  console.log('SOURCES', JSON.stringify(sources, null, 2));
  console.log(
    'ANALYSES',
    JSON.stringify(
      analyses.map((a) => ({
        id: a.id,
        framework: a.framework,
        packageManager: a.packageManager,
        buildCommand: a.buildCommand,
        startCommand: a.startCommand,
        port: a.port,
        confidence: a.confidence,
        repositoryPath: a.repositoryPath,
        createdAt: a.createdAt,
      })),
      null,
      2,
    ),
  );
  console.log('REPO_SCAN_PATH', repoPath);
  console.log('REPO_SCAN', JSON.stringify(scan, null, 2));
  console.log(
    'DEPS',
    JSON.stringify(
      deps.map((d) => ({
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
          duration: s.duration,
        })),
        artifacts: d.artifacts.map((a) => ({
          id: a.id,
          size: a.size,
          status: a.status,
          type: a.type,
          storagePath: a.storagePath,
        })),
        remoteDeployments: d.remoteDeployments.map((r) => ({
          id: r.id,
          status: r.status,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt,
        })),
        recentLogs: d.logs.map((l) => ({
          level: l.level,
          message: String(l.message).slice(0, 240),
          createdAt: l.createdAt,
        })),
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
