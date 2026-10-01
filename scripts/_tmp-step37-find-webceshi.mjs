import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
    if ((v.startsWith("\"") && v.endsWith("\"")) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
const requireApi = createRequire(resolve(root, "apps/api/package.json"));
const { PrismaClient } = requireApi("@launchos/database");
const prisma = new PrismaClient();
const projects = await prisma.project.findMany({
  where: { OR: [{ name: { contains: "web-ceshi" } }, { name: { contains: "ceshi" } }] },
  select: { id: true, name: true, createdAt: true },
  take: 20,
});
console.log("projects", projects);
for (const p of projects) {
  const depCount = await prisma.deployment.count({ where: { projectId: p.id } });
  const verCount = await prisma.applicationVersion.count({ where: { projectId: p.id } });
  console.log(p.id, p.name, "deps", depCount, "vers", verCount);
}
const byId = await prisma.project.findUnique({ where: { id: "cmunsm2lk00ctrl01nnu1pwyd" }, select: { id: true, name: true } });
console.log("byId", byId);
console.log("DATABASE_URL host", (process.env.DATABASE_URL || "").replace(/:[^:@/]+@/, ":***@").slice(0, 120));
await prisma.$disconnect();
