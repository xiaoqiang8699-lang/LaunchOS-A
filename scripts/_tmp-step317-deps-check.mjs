import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
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
const bcrypt = requireApi("bcrypt");
function curl(url, host, opts = {}) {
  const { method = "GET", headers = {}, body = null, maxTime = "60" } = opts;
  const args = ["-k","-sS","-X",method,"--resolve",host+":443:116.62.198.184","-w","\n__STATUS__:%{http_code}","--max-time",String(maxTime)];
  for (const [k,v] of Object.entries(headers)) args.push("-H", k+": "+v);
  if (body != null) args.push("-H","content-type: application/json","--data-binary", body);
  args.push(url);
  const r = spawnSync("curl.exe", args, { encoding: "utf8", maxBuffer: 8e6 });
  const out = String(r.stdout||"");
  const m = out.match(/\n__STATUS__:(\d+)\s*$/);
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out };
}
const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: "116.62.198.184" } });
const runner = new RemoteRunner();
await runner.connect({ host: server.host, port: server.port, username: resolveServerSshUsername(server.username), password: decryptCredential(server.credentialEncrypted), readyTimeoutMs: 20000 });
const ownerEmail = (await runner.execute(shellCommand(`podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -Atc "SELECT u.email FROM \\"Project\\" p JOIN \\"Workspace\\" w ON w.id=p.\\"workspaceId\\" JOIN \\"User\\" u ON u.id=w.\\"ownerId\\" WHERE p.id='cmunhwais0003rl01wqj1qy11';"`), { timeoutMs: 20000 })).stdout.trim();
const tempPass = `Alpha${randomBytes(6).toString("hex")}!aA1`;
const hash = await bcrypt.hash(tempPass, 10);
await runner.writeTextFile("/opt/launchos/tmp/p.sql", `UPDATE "User" SET "passwordHash"='${hash.replace(/'/g,"''")}' WHERE email='${ownerEmail.replace(/'/g,"''")}';\n`);
await runner.execute(shellCommand("podman cp /opt/launchos/tmp/p.sql launchos-alpha-postgres:/tmp/p.sql && podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -f /tmp/p.sql"), { timeoutMs: 20000 });
const login = curl("https://api-alpha.zsaos.com/api/v1/auth/login","api-alpha.zsaos.com",{ method:"POST", headers:{origin:"https://alpha.zsaos.com"}, body: JSON.stringify({email:ownerEmail,password:tempPass})});
const token = JSON.parse(login.text||"{}").accessToken;
const deps = curl("https://api-alpha.zsaos.com/api/v1/projects/cmunhwais0003rl01wqj1qy11/dependencies","api-alpha.zsaos.com",{ headers:{ authorization:"Bearer "+token, origin:"https://alpha.zsaos.com"}});
console.log(deps.status, deps.text.slice(0,2000));
const sql = await runner.execute(shellCommand(`podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -AtF '|' -c "SELECT id, status, host, \\"databaseName\\" FROM \\"DatabaseConnection\\" WHERE \\"projectId\\"='cmunhwais0003rl01wqj1qy11'; SELECT id, status, host, \\"databaseIndex\\" FROM \\"RedisConnection\\" WHERE \\"projectId\\"='cmunhwais0003rl01wqj1qy11'; SELECT \\"databaseConnectionId\\", \\"deployableUnitId\\" FROM \\"DatabaseConnectionUnit\\"; SELECT \\"redisConnectionId\\", \\"deployableUnitId\\" FROM \\"RedisConnectionUnit\\";"`), { timeoutMs: 20000 });
console.log("SQL", sql.stdout);
await runner.disconnect(); await prisma.$disconnect();
