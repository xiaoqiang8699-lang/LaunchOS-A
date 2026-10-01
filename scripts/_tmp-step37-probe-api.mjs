import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const file of [resolve(root, ".env"), resolve(root, ".secrets/alpha-data-plane.env")]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
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
await runner.connect({ host: server.host, port: server.port, username: resolveServerSshUsername(server.username), password: decryptCredential(server.credentialEncrypted) });
const probe = await runner.execute(shellCommand("podman exec launchos-alpha-api sh -c 'pwd; ls; ls node_modules/@launchos 2>/dev/null | head; ls /app/node_modules/@launchos 2>/dev/null | head; which node; ls /app/apps/api 2>/dev/null | head'"), { timeoutMs: 30000 });
console.log(probe.stdout);
await runner.disconnect();
await prisma.$disconnect();
