import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keys = [
  'GITHUB_APP_ID',
  'GITHUB_APP_SLUG',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_CLIENT_ID',
  'GITHUB_APP_CLIENT_SECRET',
  'GITHUB_APP_CALLBACK_URL',
];

function hasValue(raw) {
  if (raw == null) return false;
  let v = String(raw).trim();
  if (!v) return false;
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1);
  }
  if (!v) return false;
  if (/^(your_|changeme|xxx|TODO|replace)/i.test(v)) return false;
  return true;
}

function inspectEnvFile(rel) {
  const file = resolve(root, rel);
  if (!existsSync(file)) return { path: rel, exists: false };
  const text = readFileSync(file, 'utf8');
  const out = { path: rel, exists: true, keys: {} };
  for (const k of keys) {
    const m = text.match(new RegExp(`^${k}=(.*)$`, 'm'));
    const present = Boolean(m && hasValue(m[1]));
    out.keys[k] = {
      present,
      source: present ? `env:${rel}` : 'missing',
    };
  }
  return out;
}

function findPemFiles(dir, acc = [], depth = 0) {
  if (depth > 3 || !existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) findPemFiles(p, acc, depth + 1);
    else if (/\.pem$/i.test(name) || /github.*key/i.test(name)) {
      const text = readFileSync(p, 'utf8');
      const looksPem = /BEGIN (RSA )?PRIVATE KEY/.test(text);
      acc.push({
        path: p.replace(root + '\\', '').replace(root + '/', ''),
        present: looksPem,
        source: looksPem ? `file:${basename(p)}` : 'file-invalid',
        bytes: st.size,
      });
    }
  }
  return acc;
}

const files = [
  '.env',
  '.env.example',
  '.env.alpha.example',
  '.secrets/alpha-data-plane.env',
  'apps/api/.env',
];

const report = {
  envFiles: files.map(inspectEnvFile),
  pemCandidates: [
    ...findPemFiles(resolve(root, '.secrets')),
    ...findPemFiles(resolve(root, 'deploy')),
  ],
  processEnv: Object.fromEntries(
    keys.map((k) => [
      k,
      {
        present: hasValue(process.env[k]),
        source: hasValue(process.env[k]) ? 'process.env' : 'missing',
      },
    ]),
  ),
};

// Aggregate best source per key without values
const aggregate = {};
for (const k of keys) {
  const hits = [];
  if (report.processEnv[k].present) hits.push(report.processEnv[k].source);
  for (const f of report.envFiles) {
    if (f.exists && f.keys[k]?.present) hits.push(f.keys[k].source);
  }
  if (k === 'GITHUB_APP_PRIVATE_KEY') {
    for (const p of report.pemCandidates) if (p.present) hits.push(p.source);
  }
  aggregate[k] = {
    present: hits.length > 0,
    source: hits[0] || 'missing',
    sources: hits,
  };
}

console.log(JSON.stringify({ aggregate, pemCandidates: report.pemCandidates.map((p) => ({ path: p.path, present: p.present, source: p.source, bytes: p.bytes })), envFilePresence: report.envFiles.map((f) => ({ path: f.path, exists: f.exists, keys: Object.fromEntries(Object.entries(f.keys || {}).map(([k, v]) => [k, { present: v.present, source: v.source }])) })) }, null, 2));
