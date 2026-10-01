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
await runner.writeTextFile("/opt/launchos/tmp/step317-deps2.sql", `
SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name ILIKE '%depend%' OR table_name ILIKE '%database%' OR table_name ILIKE '%redis%' ORDER BY 1;
`);
const tables = await runner.execute(shellCommand('podman cp /opt/launchos/tmp/step317-deps2.sql launchos-alpha-postgres:/tmp/step317-deps2.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -At -f /tmp/step317-deps2.sql'), { timeoutMs: 20000 });
console.log("TABLES", tables.stdout);
await runner.writeTextFile("/opt/launchos/tmp/step317-deps3.sql", `
SELECT id, type, status, coalesce(name,''), coalesce("projectId",'') FROM "ProjectDependency" ORDER BY "updatedAt" DESC LIMIT 20;
SELECT u.id, u.type, d.type, d.required, d.status FROM "DeployableUnit" u LEFT JOIN "UnitDependency" d ON d."deployableUnitId"=u.id WHERE u."projectId"='cmunhwais0003rl01wqj1qy11';
`);
const r = await runner.execute(shellCommand('podman cp /opt/launchos/tmp/step317-deps3.sql launchos-alpha-postgres:/tmp/step317-deps3.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF "|" -f /tmp/step317-deps3.sql'), { timeoutMs: 20000 });
console.log(r.stdout||r.stderr);
await runner.disconnect(); await prisma.$disconnect();
