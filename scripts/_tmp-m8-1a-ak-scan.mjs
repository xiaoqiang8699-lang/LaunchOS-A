import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  resolve(root, '.env'),
  resolve(root, '.secrets/alpha-data-plane.env'),
  resolve(root, '.secrets/aliyun.env'),
  resolve(root, '.secrets/alibaba.env'),
  resolve(root, '.tools/alpha-runtime/aliyun.env'),
];

for (const file of files) {
  if (!existsSync(file)) {
    console.log(JSON.stringify({ file, missing: true }));
    continue;
  }
  const interesting = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const raw = line;
    const t = line.trim();
    if (!t.includes('ALIYUN') && !t.includes('ACCESS_KEY') && !t.includes('OSS_') && !t.toUpperCase().includes('AK')) continue;
    if (t.startsWith('#')) {
      interesting.push({ commented: true, key: t.slice(1).split('=')[0].trim(), len: 0 });
      continue;
    }
    if (!t.includes('=')) continue;
    const i = t.indexOf('=');
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    interesting.push({
      key: k,
      len: v.length,
      empty: v.length === 0,
      fp: v ? createHash('sha256').update(v).digest('hex').slice(0, 8) : null,
      hasSpace: /\s/.test(v),
      rawStartsHash: raw.trimStart().startsWith('#'),
    });
  }
  console.log(JSON.stringify({ file, interesting }, null, 2));
}
