const { PrismaClient } = require('../generated/client');
const p = new PrismaClient();

async function main() {
  await p.project.update({
    where: { id: 'cmu2k41dl0003ri68hbbyud0w' },
    data: { framework: 'EXPO' },
  });
  await p.projectAnalysis.create({
    data: {
      projectId: 'cmu2k41dl0003ri68hbbyud0w',
      repositoryPath: 'C:\\Users\\柠蜜\\AppData\\Local\\Temp\\launchos-repos\\cmu2k41dl0003ri68hbbyud0w',
      framework: 'EXPO',
      packageManager: 'npm',
      buildCommand: null,
      startCommand: null,
      port: null,
      confidence: 0.95,
    },
  });
  console.log('updated 照型APP framework -> EXPO');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await p.$disconnect();
  });
