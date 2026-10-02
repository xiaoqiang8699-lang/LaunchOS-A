/**
 * Compare env/JWT sources without printing secrets.
 * node scripts/_tmp-m8-1a-env-probe.mjs
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function load(file, into) {
  if (!existsSync(file)) return { file, missing: true, keys: [] };
  const keys = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    into[k] = v;
    keys.push(k);
  }
  return { file, missing: false, keys };
}

function fp(v) {
  if (!v) return null;
  return createHash('sha256').update(v).digest('hex').slice(0, 12);
}

const envOnly = {};
const secretsOnly = {};
const mergedWrong = {}; // .env first then secrets if undefined (current bug pattern)
const mergedRight = {}; // secrets first then .env if undefined

const a = load(resolve(root, '.env'), envOnly);
const b = load(resolve(root, '.secrets/alpha-data-plane.env'), secretsOnly);

Object.assign(mergedWrong, envOnly);
for (const [k, v] of Object.entries(secretsOnly)) {
  if (mergedWrong[k] === undefined) mergedWrong[k] = v;
}
Object.assign(mergedRight, secretsOnly);
for (const [k, v] of Object.entries(envOnly)) {
  if (mergedRight[k] === undefined) mergedRight[k] = v;
}

console.log(
  JSON.stringify(
    {
      envFile: a,
      secretsFile: { ...b, keys: b.keys },
      overlapKeys: a.keys.filter((k) => secretsOnly[k] !== undefined),
      jwt: {
        env: fp(envOnly.JWT_SECRET),
        secrets: fp(secretsOnly.JWT_SECRET),
        same: envOnly.JWT_SECRET === secretsOnly.JWT_SECRET,
      },
      databaseHost: {
        env: (envOnly.DATABASE_URL || '').replace(/:[^:@/]+@/, ':***@').slice(0, 80),
        secrets: (secretsOnly.DATABASE_URL || '').replace(/:[^:@/]+@/, ':***@').slice(0, 80),
        same: envOnly.DATABASE_URL === secretsOnly.DATABASE_URL,
      },
      wrongMergeJwt: fp(mergedWrong.JWT_SECRET),
      rightMergeJwt: fp(mergedRight.JWT_SECRET),
      wrongUsesLocalJwt: mergedWrong.JWT_SECRET === envOnly.JWT_SECRET,
      rightUsesAlphaJwt: mergedRight.JWT_SECRET === secretsOnly.JWT_SECRET,
    },
    null,
    2,
  ),
);
