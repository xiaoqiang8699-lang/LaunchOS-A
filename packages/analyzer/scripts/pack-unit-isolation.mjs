import { Buffer } from 'node:buffer';
import { mkdirSync, rmSync, writeFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveUnitPath } from '../dist/index.js';

const root = mkdtempSync(join(tmpdir(), 'launchos-pack-'));
const web = join(root, 'privacy-site');
const mobile = join(root, 'app');
mkdirSync(web, { recursive: true });
mkdirSync(mobile, { recursive: true });
writeFileSync(join(web, 'index.html'), '<html></html>');
writeFileSync(join(mobile, 'huge.bin'), Buffer.alloc(1024, 1));
writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'mobile', dependencies: { expo: '1' } }));

const unitCwd = resolveUnitPath(root, 'privacy-site');
const listed = readdirSync(unitCwd);
if (listed.includes('huge.bin') || listed.includes('package.json')) {
  throw new Error('unit path leaked parent files');
}
if (!listed.includes('index.html')) {
  throw new Error('missing unit file');
}

let rejected = false;
try { resolveUnitPath(root, '../../etc'); } catch { rejected = true; }
if (!rejected) throw new Error('traversal not rejected');

console.log(JSON.stringify({ ok: true, unitFiles: listed, traversalRejected: true }));
rmSync(root, { recursive: true, force: true });
