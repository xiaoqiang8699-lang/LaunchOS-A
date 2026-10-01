/**
 * Step 34 deep extract — DeploymentLog + unit packageManager + sample repo files
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');

const DEP = 'cmunvd5xl0015rl01xbv001ex';
const PROJECT = 'cmunsm2lk00ctrl01nnu1pwyd';
const UNIT = 'cmunsmcpc00d2rl0184kdxdb3';
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });

function redact(t) {
  return String(t || '')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer|x-access-token)[=:]\S+/gi, '$1=***');
}

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: '116.62.198.184' } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});

await runner.writeTextFile(
  '/opt/launchos/tmp/step34-deep.sql',
  `SELECT count(*) FROM "DeploymentLog" WHERE "deploymentId"='${DEP}';
SELECT level, left(message, 2000), "createdAt"::text
FROM "DeploymentLog" WHERE "deploymentId"='${DEP}' ORDER BY "createdAt" ASC;

SELECT id, name, type::text, coalesce("rootPath",'.'), coalesce(framework,''), coalesce("packageManager",''), coalesce(port::text,'')
FROM "DeployableUnit" WHERE id='${UNIT}';

SELECT id, status, "failureCode", left(coalesce("errorMessage",''), 1000)
FROM "Deployment" WHERE id='${DEP}';

SELECT "stepKey", status, left(coalesce("errorMessage",''), 2000)
FROM "DeploymentStep" WHERE "deploymentId"='${DEP}' ORDER BY "createdAt";
`,
);

const sql = await runner.execute(
  shellCommand(
    'podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < /opt/launchos/tmp/step34-deep.sql',
  ),
  { timeoutMs: 90000 },
);

const repoProbe = await runner.execute(
  shellCommand(`
set +e
REPO=/tmp/launchos-repos/${PROJECT}
echo ===REPO===
ls -la "$REPO" 2>&1 | head -50
echo ===ROOT_LOCKS===
ls -la "$REPO"/package.json "$REPO"/package-lock.json "$REPO"/pnpm-lock.yaml "$REPO"/yarn.lock "$REPO"/bun.lockb 2>&1
echo ===UNIT_PATH===
# try common roots
for d in "$REPO" "$REPO/." "$REPO/apps/web" "$REPO/web" "$REPO/frontend"; do
  if [ -f "$d/package.json" ]; then
    echo FOUND_PKG=$d
    ls -la "$d"/package.json "$d"/package-lock.json "$d"/pnpm-lock.yaml "$d"/yarn.lock 2>&1
    echo ---package.json---
    head -c 4000 "$d/package.json"
    echo
    echo ---engines---
    python3 - <<'PY' 2>/dev/null || node -e 'const p=require(process.argv[1]); console.log(JSON.stringify({engines:p.engines,packageManager:p.packageManager,scripts:p.scripts,deps:Object.keys(p.dependencies||{}),devDeps:Object.keys(p.devDependencies||{})},null,2))' "$d/package.json"
import json
p=json.load(open("$d/package.json"))
print(json.dumps({"engines":p.get("engines"),"packageManager":p.get("packageManager"),"scripts":p.get("scripts"),"deps":list((p.get("dependencies") or {}).keys()),"devDeps":list((p.get("devDependencies") or {}).keys())}, indent=2, ensure_ascii=False))
PY
  fi
done
echo ===DOCKERFILE_SNIP===
find /tmp /opt/launchos -name 'Dockerfile.launchos' 2>/dev/null | head -10
find /tmp/launchos-repos/${PROJECT} -name 'Dockerfile.launchos' 2>/dev/null | head -5
echo ===REGISTRY===
curl -sS -o /dev/null -w 'npmmirror:%{http_code}\n' --max-time 15 https://registry.npmmirror.com/ || echo npmmirror_fail
curl -sS -o /dev/null -w 'npmjs:%{http_code}\n' --max-time 15 https://registry.npmjs.org/ || echo npmjs_fail
echo ===NODE_ON_HOST===
node -v 2>/dev/null; npm -v 2>/dev/null
podman run --rm --network host node:20-alpine sh -c 'node -v; npm -v' 2>&1 | tail -5
`),
  { timeoutMs: 180000 },
);

const workerFull = await runner.execute(
  shellCommand(
    `podman logs --since 2026-09-30T08:50:00Z launchos-alpha-worker 2>&1 | sed -E 's/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer|gh[pousr]_[A-Za-z0-9_]{20,}|x-access-token)[=:][^ ]+/\\1=***/gi' | grep -A2 -B2 -E '${DEP}|npm ERR|ERESOLVE|EACCES|ENOENT|exit code|docker build|RUN npm|WARN|error' | tail -200`,
  ),
  { timeoutMs: 60000 },
);

const out = {
  sql: redact(String(sql.stdout || '')),
  sqlErr: redact(String(sql.stderr || '')).slice(0, 500),
  repoProbe: redact(String(repoProbe.stdout || '') + '\n' + String(repoProbe.stderr || '')).slice(0, 20000),
  workerFull: redact(String(workerFull.stdout || '')).slice(0, 15000),
};
writeFileSync(join(ARTIFACT_DIR, 'step34-deep.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await prisma.$disconnect();
await runner.disconnect();
