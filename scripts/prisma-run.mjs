import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const databaseDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../packages/database');

const env = {
  ...process.env,
  DATABASE_URL:
    process.env.DATABASE_URL && process.env.DATABASE_URL.length > 0
      ? process.env.DATABASE_URL
      : 'postgresql://postgres:postgres@localhost:5432/launchos?schema=public',
};

const args = process.argv.slice(2);
const result = spawnSync('pnpm', ['exec', 'prisma', ...args], {
  cwd: databaseDir,
  env,
  stdio: 'inherit',
  shell: true,
});

process.exit(result.status ?? 1);
