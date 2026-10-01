import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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
const ARTIFACT_DIR = resolve(root, '.tools/alpha-runtime');
mkdirSync(ARTIFACT_DIR, { recursive: true });
const TARGET_HOST = '116.62.198.184';
const HOST = 'web-ceshi.launchos.app';
const DEP_CURRENT = 'cmuo1j5k5001vrl01aio07lf3';
const DEP_PREV = 'cmuo01mvg0011rl01i025p9ea';
const SI_PREV = 'cmuo0d0ff002zrl01fyjjur61';
const SI_CUR = 'cmuo1kxki00a2rl01puc73sg8';

function redact(t) {
  return String(t || '')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer|accessToken|AUTH_SECRET)\s*[=:]\s*\S+/gi, '$1=***')
    .replace(/enc:v1:[A-Za-z0-9+/=:_-]+/g, 'enc:v1:***');
}

function curlProbe(url, resolveHost, ip) {
  const args = [
    '-sS', '-k', '-L', '--max-time', '45',
    '-A', 'LaunchOS-Step35/1.0',
    '-w', '\n__CODE__:%{http_code}\n__SSL__:%{ssl_verify_result}\n__IP__:%{remote_ip}\n__TIME__:%{time_total}',
  ];
  if (ip) args.push('--resolve', `${resolveHost}:443:${ip}`);
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 2_000_000 });
  const out = String(r.stdout || '');
  const code = Number((out.match(/__CODE__:(\d+)/) || [])[1] || 0);
  const body = out.replace(/\n__CODE__:[\s\S]*$/, '');
  return {
    code,
    ssl: (out.match(/__SSL__:(\d+)/) || [])[1] || null,
    remoteIp: (out.match(/__IP__:([^\n]+)/) || [])[1] || null,
    time: (out.match(/__TIME__:([0-9.]+)/) || [])[1] || null,
    bodyFingerprint: body.replace(/\s+/g, ' ').trim().slice(0, 220),
    stderr: String(r.stderr || '').slice(0, 400),
    exit: r.status,
  };
}

const dns = spawnSync('nslookup', [HOST], { encoding: 'utf8' });
const dnsOut = String(dns.stdout || '') + String(dns.stderr || '');
writeFileSync(join(ARTIFACT_DIR, 'step35-dns.txt'), dnsOut);

const probeDirect = curlProbe(`https://${HOST}/`, HOST, null);
const probeViaAlpha = curlProbe(`https://${HOST}/`, HOST, TARGET_HOST);
const probeZsaosStyle = curlProbe(`https://web-ceshi.zsaos.com/`, 'web-ceshi.zsaos.com', TARGET_HOST);

const prisma = new PrismaClient();
const server = await prisma.serverInstance.findFirst({ where: { host: TARGET_HOST } });
const runner = new RemoteRunner();
await runner.connect({
  host: server.host,
  port: server.port,
  username: resolveServerSshUsername(server.username),
  password: decryptCredential(server.credentialEncrypted),
});

async function remoteOk(cmd, label, opts = {}) {
  const r = await runner.execute(shellCommand(cmd), { timeoutMs: opts.timeoutMs ?? 180000 });
  if (r.exitCode !== 0) throw new Error(`${label}: ${redact(r.stderr || r.stdout || '').slice(0, 2500)}`);
  return r;
}

await runner.writeTextFile(
  '/opt/launchos/tmp/step35-deep.sh',
  `#!/bin/bash
set +e
echo '=== nginx for web-ceshi ==='
ls -la /etc/nginx/conf.d 2>/dev/null | head
grep -RIn 'web-ceshi' /etc/nginx /opt/launchos/gateway 2>/dev/null | head -40
echo
echo '=== local curl public via nginx ==='
curl -sS -k -o /tmp/step35-body.txt -w 'local_https=%{http_code} ip=%{remote_ip}\\n' --resolve ${HOST}:443:127.0.0.1 https://${HOST}/ --max-time 20
head -c 240 /tmp/step35-body.txt; echo
curl -sS -o /dev/null -w 'loopback_39006=%{http_code}\\n' http://127.0.0.1:39006/ --max-time 10
echo
echo '=== containers related ==='
podman ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}\t{{.Image}}' | grep -iE 'cmunsm2|cmuo01|cmuo1|39006|web-ceshi|launchos/cmunsm' || true
echo
echo '=== inspect previous success container ==='
podman inspect 01f39e52acc1da20b809075a2c34bae6f56a22297eee1e32e56cbbec92744099 --format 'State={{.State.Status}} Exit={{.State.ExitCode}} OOM={{.State.OOMKilled}} Started={{.State.StartedAt}} Finished={{.State.FinishedAt}} Health={{.State.Health.Status}} Ports={{json .NetworkSettings.Ports}} Cmd={{json .Config.Cmd}} Entrypoint={{json .Config.Entrypoint}} EnvPorts={{range .Config.Env}}{{println .}}{{end}}' 2>&1 | sed -E 's/(AUTH_SECRET|PASSWORD|SECRET|TOKEN|DATABASE_URL)=.*/\\1=***/'
echo
echo '=== previous container logs tail ==='
podman logs --tail 80 01f39e52acc1da20b809075a2c34bae6f56a22297eee1e32e56cbbec92744099 2>&1 | sed -E 's/(AUTH_SECRET|PASSWORD|SECRET|TOKEN|DATABASE_URL)=[^ ]+/\\1=***/g' | tail -80
echo
echo '=== current candidate search ==='
podman ps -a --format '{{.ID}} {{.Names}} {{.Status}} {{.Image}} {{.CreatedAt}}' | tail -40
echo
echo '=== deployment logs current ==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "SELECT \\"createdAt\\", level, left(message,350) FROM \\"DeploymentLog\\" WHERE \\"deploymentId\\"='${DEP_CURRENT}' ORDER BY \\"createdAt\\" ASC LIMIT 120;"
echo
echo '=== deployment logs prev SUCCESS verify-ish ==='
podman exec launchos-alpha-postgres psql -U launchos_alpha -d launchos -c "SELECT \\"createdAt\\", level, left(message,350) FROM \\"DeploymentLog\\" WHERE \\"deploymentId\\"='${DEP_PREV}' AND (message ILIKE '%VERIFY%' OR message ILIKE '%health%' OR message ILIKE '%http%' OR message ILIKE '%gateway%' OR message ILIKE '%route%' OR message ILIKE '%public%' OR message ILIKE '%39006%' OR message ILIKE '%SUCCESS%' OR level='error') ORDER BY \\"createdAt\\" ASC LIMIT 80;"
echo
echo '=== worker logs ==='
podman logs --since 30m launchos-alpha-worker 2>&1 | grep -iE '${DEP_CURRENT}|${DEP_PREV}|REMOTE_DEPLOY|candidate|podman run|health|gateway|ECONN|timeout|stall|CREATING|start command|PORT' | sed -E 's/(AUTH_SECRET|PASSWORD|SECRET|TOKEN|DATABASE_URL)=[^ ]+/\\1=***/g' | tail -100
echo
echo '=== redis bull jobs ==='
podman exec launchos-alpha-redis redis-cli --scan --pattern 'bull:deploymentQueue:*' 2>/dev/null | head -40
podman exec launchos-alpha-redis redis-cli LLEN bull:deploymentQueue:wait 2>/dev/null
podman exec launchos-alpha-redis redis-cli LLEN bull:deploymentQueue:active 2>/dev/null
podman exec launchos-alpha-redis redis-cli ZCARD bull:deploymentQueue:delayed 2>/dev/null
podman exec launchos-alpha-redis redis-cli ZCARD bull:deploymentQueue:failed 2>/dev/null
podman exec launchos-alpha-redis redis-cli LRANGE bull:deploymentQueue:active 0 5 2>/dev/null
echo
echo '=== nginx listen ==='
ss -lntp | grep -E ':443|:80|:39006' || true
`,
);

const deep = await remoteOk('chmod 700 /opt/launchos/tmp/step35-deep.sh && /opt/launchos/tmp/step35-deep.sh', 'deep', {
  timeoutMs: 180000,
});
const deepOut = redact(String(deep.stdout || '') + '\n' + String(deep.stderr || ''));
writeFileSync(join(ARTIFACT_DIR, 'step35-deep.txt'), deepOut);

const summary = {
  dnsOut: dnsOut.slice(0, 1500),
  probeDirect,
  probeViaAlpha,
  probeZsaosStyle,
  deepSnippet: deepOut.slice(0, 12000),
};
writeFileSync(join(ARTIFACT_DIR, 'step35-public-verify.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ probeDirect, probeViaAlpha, probeZsaosStyle, dnsHint: dnsOut.slice(0, 500) }, null, 2));
console.log('\n===== DEEP =====\n');
console.log(deepOut.slice(0, 12000));

await prisma.$disconnect();
await runner.disconnect().catch(() => undefined);
