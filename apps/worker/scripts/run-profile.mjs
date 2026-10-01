import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const profile = process.argv[2] || 'deployment';
const mode = process.argv[3] || 'dev';
const require = createRequire(import.meta.url);
const env = { ...process.env, WORKER_PROFILE: profile };
const args =
  mode === 'start'
    ? ['dist/main.js']
    : [require.resolve('tsx/cli'), 'watch', 'src/main.ts'];
const child = spawn(process.execPath, args, {
  cwd: new URL('..', import.meta.url),
  env,
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 1));
