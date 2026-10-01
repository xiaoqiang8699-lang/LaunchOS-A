import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const file of [resolve(root, ".env"), resolve(root, ".secrets/alpha-data-plane.env")]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
const requireApi = createRequire(resolve(root, "apps/api/package.json"));
const { PrismaClient } = requireApi("@launchos/database");
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi("@launchos/shared");
const { RemoteRunner } = requireApi("@launchos/remote-runner");
const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: "116.62.198.184" } });
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username: resolveServerSshUsername(server.username), password: decryptCredential(server.credentialEncrypted), readyTimeoutMs: 20000 });
const r = await runner.execute(shellCommand(`
echo ===WORKER_INSPECT===
podman inspect launchos-alpha-worker --format '{{json .Config.Env}}' | tr ',' '\n' | sed -n 's/=.*//p' | grep -Ei 'GITHUB|GIT_' | sort
echo ===WORKER_MOUNTS===
podman inspect launchos-alpha-worker --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}'
echo ===API_MOUNTS===
podman inspect launchos-alpha-api --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}'
echo ===RUN_SCRIPTS===
ls -la /opt/launchos/bin/*worker* /opt/launchos/bin/*run* 2>/dev/null | head -40
`), { timeoutMs: 30000 });
console.log(String(r.stdout||r.stderr||"").replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY)=.*/gi,"$1=***"));
await runner.disconnect(); await prisma.$disconnect();
