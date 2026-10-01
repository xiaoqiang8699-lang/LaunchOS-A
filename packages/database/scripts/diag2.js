const { PrismaClient } = require('../generated/client');
const { existsSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const p = new PrismaClient();
const PROJECT_ID = process.argv[2] || 'cmu21lk8a0001ri6wlyc7q1jn';

function walkSignals(root) {
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
  if (!existsSync(root)) return { missing: true, signals };
  try {
    signals.topLevel = readdirSync(root).slice(0, 50);
  } catch {}
  const stack = [root];
  let seen = 0;
  while (stack.length && seen < 10000) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (['node_modules', '.git', 'DerivedData', 'Pods', 'build', '.build'].includes(name)) continue;
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
        if (signals.sampleSwift.length < 8) signals.sampleSwift.push(full.slice(root.length + 1));
      }
    }
  }
  return { missing: false, signals, filesScanned: seen };
}

async function main() {
  const project = await p.project.findUnique({ where: { id: PROJECT_ID } });
  const sources = await p.sourceRepository.findMany({ where: { projectId: PROJECT_ID } });
  const analyses = await p.projectAnalysis.findMany({
    where: { projectId: PROJECT_ID },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  const deps = await p.deployment.findMany({
    where: { projectId: PROJECT_ID },
    orderBy: { createdAt: 'desc' },
    take: 5,
    include: {
      steps: { orderBy: { order: 'asc' } },
      artifacts: true,
      remoteDeployments: true,
      logs: { orderBy: { createdAt: 'desc' }, take: 40 },
    },
  });
  const running = await p.deployment.findMany({
    where: { status: { in: ['RUNNING', 'QUEUED', 'CREATED'] } },
    include: {
      project: { select: { id: true, name: true, slug: true } },
      steps: { orderBy: { order: 'asc' } },
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  const gitRoot = process.env.LAUNCHOS_GIT_ROOT || join(tmpdir(), 'launchos-repos');
  const repoPath = join(gitRoot, PROJECT_ID);
  const scan = walkSignals(repoPath);

  const out = {
    project,
    sources,
    analyses,
    repoPath,
    scan,
    deps: deps.map((d) => ({
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
      steps: d.steps,
      artifacts: d.artifacts,
      remoteDeployments: d.remoteDeployments,
      recentLogs: d.logs.map((l) => ({
        level: l.level,
        message: String(l.message).slice(0, 280),
        createdAt: l.createdAt,
      })),
    })),
    runningAny: running.map((d) => ({
      id: d.id,
      status: d.status,
      project: d.project,
      steps: d.steps.map((s) => ({
        key: s.stepKey,
        name: s.name,
        status: s.status,
        startedAt: s.startedAt,
      })),
    })),
  };
  console.log(JSON.stringify(out, null, 2));
  await p.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await p.$disconnect();
  process.exit(1);
});
