import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const gatewayDir = join(root, 'apps/gateway');
const require = createRequire(join(gatewayDir, 'package.json'));
const { build } = require('esbuild');

const entry = join(gatewayDir, 'src/standalone.ts');
const outfile = join(gatewayDir, 'dist/gateway.cjs');

await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile,
  sourcemap: false,
});

console.log(`bundled ${outfile}`);
