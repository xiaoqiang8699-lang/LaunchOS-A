import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of [resolve(root, '.env'), resolve(root, 'apps/api/.env')]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const API = 'http://127.0.0.1:3001/api/v1';
const login = await fetch(`${API}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: 'xiaoqiang8699@gmail.com',
    password: process.env.E2E_PASSWORD || 'Launchos123!',
  }),
}).then((r) => r.json());
if (!login.accessToken) {
  console.log(JSON.stringify({ ok: false, reason: 'login_failed' }));
  process.exit(0);
}
const res = await fetch(`${API}/alpha-tests/source-connection-p1`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${login.accessToken}` },
});
const body = await res.text();
console.log(JSON.stringify({ status: res.status, body }, null, 2));
