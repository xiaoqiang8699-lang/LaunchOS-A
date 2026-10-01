import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const installRoot = 'C:\\launchos-pg';
const dataDir = process.env.LAUNCHOS_PGDATA ?? 'C:\\launchos-pgdata';
const password = 'postgres';

process.env.LANG = 'C';
process.env.LC_ALL = 'C';
process.env.PGCLIENTENCODING = 'UTF8';

function run(command, args, cwd, allowFailure = false) {
  const result = spawnSync(command, args, {
    cwd,
    env: {
      ...process.env,
      LANG: 'C',
      LC_ALL: 'C',
      PGHOME: installRoot,
      PGDATA: dataDir,
    },
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with code ${result.status ?? 'null'}`);
  }
}

const embeddedEntry = require.resolve('embedded-postgres');
const nativeDir = path.resolve(path.dirname(embeddedEntry), '../../@embedded-postgres/windows-x64/native');

mkdirSync(installRoot, { recursive: true });
run('robocopy', [nativeDir, installRoot, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS'], installRoot, true);

const binDir = path.join(installRoot, 'bin');
const initdb = path.join(binDir, 'initdb.exe');
const pgCtl = path.join(binDir, 'pg_ctl.exe');
const pwFile = path.join(installRoot, 'pw.txt');

writeFileSync(pwFile, `${password}\n`, 'utf8');
process.chdir(installRoot);

if (!existsSync(path.join(dataDir, 'PG_VERSION'))) {
  mkdirSync(dataDir, { recursive: true });
  run(
    initdb,
    [
      '-D',
      dataDir,
      '-U',
      'postgres',
      '--encoding=UTF8',
      '--locale=C',
      '--auth=password',
      `--pwfile=${pwFile}`,
    ],
    installRoot,
  );
}

run(pgCtl, ['-D', dataDir, '-l', path.join(dataDir, 'postgres.log'), '-o', '-p 5432', 'start'], installRoot, true);
await sleep(1500);

const databasePackageDir = path.resolve(import.meta.dirname, '..');
spawnSync(
  'pnpm',
  [
    'exec',
    'prisma',
    'db',
    'execute',
    '--url',
    'postgresql://postgres:postgres@localhost:5432/postgres',
    '--stdin',
  ],
  {
    cwd: databasePackageDir,
    input: 'CREATE DATABASE launchos;\n',
    encoding: 'utf8',
    shell: true,
  },
);

console.log('Local PostgreSQL is running at postgresql://postgres:postgres@localhost:5432/launchos');
