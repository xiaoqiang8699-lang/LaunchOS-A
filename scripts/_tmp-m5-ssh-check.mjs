import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of [resolve(root, '.env'), resolve(root, '.secrets/alpha-data-plane.env')]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');

const prisma = new PrismaClient();
const s = await prisma.serverInstance.findFirst({ where: { host: '116.62.198.184' } });
const uObj = resolveServerSshUsername({
  serverUsername: s.username,
  provider: s.provider,
  imageName: s.imageName,
  osName: s.osName,
});
const uStr = resolveServerSshUsername(s.username);
const password = decryptCredential(s.credentialEncrypted);
console.log(
  JSON.stringify(
    {
      username: s.username,
      provider: s.provider,
      imageName: s.imageName,
      osName: s.osName,
      resolvedObj: uObj,
      resolvedStr: uStr,
      passLen: password.length,
    },
    null,
    2,
  ),
);

for (const username of [...new Set([uObj, uStr, 'root'].filter(Boolean))]) {
  const runner = new RemoteRunner();
  try {
    await runner.connect({ host: s.host, port: s.port, username, password });
    const r = await runner.execute(shellCommand('whoami && hostname'), { timeoutMs: 20000 });
    console.log('OK', username, (r.stdout || '').trim(), 'exit', r.exitCode);
    await runner.disconnect().catch(() => undefined);
    break;
  } catch (e) {
    console.log('FAIL', username, e.message || e);
  }
}
await prisma.$disconnect();
