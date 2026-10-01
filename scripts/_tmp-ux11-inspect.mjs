/**
 * Quick inspect alpha web runtime
 * node scripts/_tmp-ux11-inspect.mjs --confirm-ux11
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
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
if (!process.argv.includes('--confirm-ux11')) process.exit(2);

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');

const TARGET_HOST = '116.62.198.184';
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({
  where: { OR: [{ id: 'cmuma9i480001rij49yv4yw2q' }, { host: TARGET_HOST, scope: 'PLATFORM_MANAGED' }] },
});
const username = resolveServerSshUsername({ serverUsername: server.username, provider: server.provider });
const password = decryptCredential(server.credentialEncrypted);
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username, password });

async function run(cmd, timeoutMs = 60000) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs });
  return { code: r.exitCode, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

const parts = {};
parts.ps = await run(`podman ps -a --format '{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}'`);
parts.inspect = await run(
  `podman inspect launchos-alpha-web --format 'name={{.Name}}\nimageName={{.ImageName}}\nimageId={{.Image}}\ncreated={{.Created}}\nports={{json .HostConfig.PortBindings}}'`,
);
parts.images = await run(`podman images --format '{{.Repository}}:{{.Tag}}|{{.ID}}|{{.CreatedAt}}|{{.Size}}' | grep -i web | head -30`);
parts.nginx = await run(`grep -n 'alpha.zsaos.com\\|39082\\|proxy_pass' /opt/launchos/gateway/active/launchos-routes.conf 2>/dev/null | head -40`);
parts.curl = await run(`curl -sS -o /dev/null -w 'loopback=%{http_code}\\n' --max-time 8 http://127.0.0.1:39082/`);

writeFileSync(join(ARTIFACT_DIR, 'ux11-inspect2.json'), JSON.stringify(parts, null, 2));
console.log(JSON.stringify(parts, null, 2));
await prisma.$disconnect();
