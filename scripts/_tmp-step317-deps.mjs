import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
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
await runner.connect({ host: server.host, port: server.port, username: resolveServerSshUsername(server.username), password: decryptCredential(server.credentialEncrypted), readyTimeoutMs: 20000 });
await runner.writeTextFile("/opt/launchos/tmp/step317-deps.sql", `
SELECT id, type, required, status, coalesce("connectionId",''), coalesce("deployableUnitId",'')
FROM "DependencyRequirement" WHERE "projectId"='cmunhwais0003rl01wqj1qy11';
SELECT key, required, coalesce("deployableUnitId",'') FROM "RuntimeConfigRequirement" WHERE "projectId"='cmunhwais0003rl01wqj1qy11' ORDER BY key;
SELECT id, type, status, name FROM "DatabaseInstance" ORDER BY "updatedAt" DESC LIMIT 10;
SELECT id, type, status, name FROM "RedisInstance" ORDER BY "updatedAt" DESC LIMIT 10;
SELECT id, kind, status, name FROM "DependencyConnection" WHERE "workspaceId"='cmuku9o570016rin89tcczblf' OR "workspaceId" IS NULL ORDER BY "updatedAt" DESC LIMIT 20;
`);
const r = await runner.execute(shellCommand('podman cp /opt/launchos/tmp/step317-deps.sql launchos-alpha-postgres:/tmp/step317-deps.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF "|" -f /tmp/step317-deps.sql'), { timeoutMs: 30000 });
console.log(String(r.stdout||r.stderr||"").slice(0, 4000));
await runner.disconnect(); await prisma.$disconnect();
