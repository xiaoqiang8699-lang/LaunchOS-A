/**
 * Step 32 live verification against real failed LaunchRun presentation + success path health.
 * node scripts/_tmp-step32-verify-live.mjs
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

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
const requireDomain = createRequire(resolve(root, 'packages/domain/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const { decryptCredential, resolveServerSshUsername, shellCommand } = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');
const { presentDeploymentFailure } = requireDomain('@launchos/domain');

const TARGET_HOST = '116.62.198.184';
const LR = 'cmunsomd000e9rl01l54fl7vk';
const PROJECT = 'cmunsm2lk00ctrl01nnu1pwyd';
const SUCCESS_LR = 'cmunhwddb0019rl01fzipihgn';
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });

function curl(url, host) {
  const r = spawnSync(
    'curl.exe',
    ['-k', '-sS', '--resolve', `${host}:443:${TARGET_HOST}`, '-w', '\n__STATUS__:%{http_code}', '--max-time', '30', url],
    { encoding: 'utf8', maxBuffer: 4_000_000 },
  );
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)\s*$/);
  return { status: m ? Number(m[1]) : 0, text: m ? out.slice(0, m.index) : out };
}

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: TARGET_HOST } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});

await runner.writeTextFile(
  '/opt/launchos/tmp/step32-verify-live.sql',
  `SELECT status, "failureCode", left("failureMessage",160),
  "planSnapshot"->'failurePresentation'->>'category',
  "planSnapshot"->'failurePresentation'->>'stageLabel',
  "planSnapshot"->'failurePresentation'->>'userMessage',
  "planSnapshot"->'failurePresentation'->>'suggestedAction',
  "planSnapshot"->'failurePresentation'->>'fixPromptAvailable'
FROM "LaunchRun" WHERE id='${LR}';

SELECT status FROM "LaunchRun" WHERE id='${SUCCESS_LR}';

SELECT name, metadata->>'failureCategory', metadata->>'failureStage', metadata->>'userBlocked', metadata->>'session', metadata->>'project', metadata->>'launchRun'
FROM "ProductEvent"
WHERE name='ALPHA_FRICTION_NOTED' AND metadata->>'note' LIKE 'External Alpha P1 — Deployment failure%'
ORDER BY "createdAt" DESC LIMIT 1;
`,
);

const sql = await runner.execute(
  shellCommand(
    'podman exec -i launchos-alpha-postgres psql -U launchos_alpha -d launchos -v ON_ERROR_STOP=1 < /opt/launchos/tmp/step32-verify-live.sql',
  ),
  { timeoutMs: 60000 },
);
const containers = await runner.execute(
  shellCommand(`podman ps --format '{{.Names}}|{{.Status}}' | grep launchos-alpha | sort`),
  { timeoutMs: 30000 },
);

const apiHealth = curl('https://api-alpha.zsaos.com/api/v1/health', 'api-alpha.zsaos.com');
const webHome = curl('https://alpha.zsaos.com/', 'alpha.zsaos.com');

const presented = presentDeploymentFailure({
  failureCode: 'RUNTIME_CONFIG_MISSING',
  failureMessage: '上线前还需要完成 1 项运行配置：AUTH_SECRET',
  currentStage: 'DEPLOY',
  currentStep: 'DEPLOY_WEB',
  projectId: PROJECT,
  missingKeys: ['AUTH_SECRET'],
});

const out = String(sql.stdout || '');
assert.equal(sql.exitCode, 0, String(sql.stderr || ''));
assert.equal(presented.category, 'USER_CONFIG');
assert.equal(presented.title, '上线失败');
assert.match(presented.userMessage, /AUTH_SECRET/);
assert.equal(apiHealth.status, 200);
assert.match(apiHealth.text, /launchos-api/);
assert.ok([200, 307, 308].includes(webHome.status), `web status ${webHome.status}`);
assert.match(out, /RUNTIME_CONFIG_MISSING/);
assert.match(out, /USER_CONFIG/);
assert.match(out, /部署应用/);
assert.match(out, /AUTH_SECRET/);
assert.match(out, /SUCCESS/);
assert.match(out, /ALPHA_FRICTION_NOTED/);
assert.match(out, /true/);
assert.match(String(containers.stdout || ''), /launchos-alpha-api/);
assert.match(String(containers.stdout || ''), /launchos-alpha-web/);
assert.doesNotMatch(`${presented.userMessage}\n${presented.suggestedAction}`, /116\.62\.198\.184|ghp_/);

const report = {
  ok: true,
  launchRun: LR,
  deployment: null,
  realFailureStage: 'DEPLOY',
  failureCategory: 'USER_CONFIG',
  apiHealth: { status: apiHealth.status, body: apiHealth.text.slice(0, 200) },
  webHomeStatus: webHome.status,
  sqlSnippet: out.slice(0, 2000),
  containers: String(containers.stdout || '').trim(),
  presented,
  secretsExposed: 'NO',
};
writeFileSync(join(ARTIFACT_DIR, 'step32-verify-live.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await prisma.$disconnect();
await runner.disconnect().catch(() => undefined);
