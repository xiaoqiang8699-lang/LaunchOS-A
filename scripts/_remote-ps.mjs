import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { RemoteRunner } = require(resolve(__dirname, '../packages/remote-runner/dist/index.js'));

const pass = process.env.PROBE_PASS;
if (!pass) throw new Error('PROBE_PASS required');

const r = new RemoteRunner();
await r.connect({
  host: process.env.PROBE_HOST || '8.138.113.134',
  port: 22,
  username: process.env.PROBE_USER || 'root',
  password: pass,
});
const out = await r.execute(
  'docker ps --format "{{.Names}} {{.Ports}} {{.Status}}"',
  { timeoutMs: 20000 },
);
console.log(out.stdout || out.stderr);
await r.disconnect();
