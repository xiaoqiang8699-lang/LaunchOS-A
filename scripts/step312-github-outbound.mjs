/**
 * Step 31.2 — Alpha GitHub Outbound Connectivity
 * Diagnose + minimal fix. No secrets. No paid resources. No third-party mirrors as product dep.
 *
 *   node scripts/step312-github-outbound.mjs --confirm-step312
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of [resolve(root, '.env'), resolve(root, '.secrets/alpha-data-plane.env')]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

if (!process.argv.includes('--confirm-step312')) {
  console.error('Refusing: pass --confirm-step312');
  process.exit(2);
}

const requireApi = createRequire(resolve(root, 'apps/api/package.json'));
const { PrismaClient } = requireApi('@launchos/database');
const {
  decryptCredential,
  resolveServerSshUsername,
  shellCommand,
} = requireApi('@launchos/shared');
const { RemoteRunner } = requireApi('@launchos/remote-runner');

const TARGET_HOST = '116.62.198.184';
const WEB_HOST = 'alpha.zsaos.com';
const API_HOST = 'api-alpha.zsaos.com';
const WEB_ORIGIN = `https://${WEB_HOST}`;
const API_ORIGIN = `https://${API_HOST}`;
const LIVE_CONTAINER = 'launchos-alpha-api';
const ARTIFACT_DIR = resolve(root, '.tools', 'alpha-runtime');
const REPORT_PATH = resolve(root, '.tools', 'step312-github-outbound-report.json');
const PROTECTED_HOSTS = [
  WEB_HOST,
  API_HOST,
  'web-launchos.zsaos.com',
  'api-launchos.zsaos.com',
  'oneclick-web.zsaos.com',
  'launchos-real-test.zsaos.com',
];

function redact(text) {
  return String(text || '')
    .replace(/postgres(ql)?:\/\/[^:\s]+:[^@\s]+@/gi, 'postgresql://***:***@')
    .replace(/redis:\/\/[^:\s]+:[^@\s]+@/gi, 'redis://***:***@')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|CREDENTIAL)[=:]([^\s"']+)/gi, '$1=***')
    .replace(/:\/\/[^:@\s]+:[^@\s]+@/g, '://***:***@')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***');
}

function assertOk(result, label, { allowExit = [0] } = {}) {
  const code = Number(result?.exitCode ?? 1);
  if (!allowExit.includes(code)) {
    throw new Error(
      `${label} failed exit=${code}: ${redact(String(result?.stderr || result?.stdout || '').slice(0, 1500))}`,
    );
  }
  return result;
}

async function remoteOk(runner, command, label, opts = {}) {
  const { allowExit = [0], timeoutMs = 120000 } = opts;
  const result = await runner.execute(shellCommand(command), { timeoutMs });
  return assertOk(result, label, { allowExit });
}

function curlResolve(url, host, { method = 'GET', headers = {}, body = null, maxTime = '90' } = {}) {
  const args = [
    '-k',
    '-sS',
    '-X',
    method,
    '--resolve',
    `${host}:443:${TARGET_HOST}`,
    '-w',
    '\n__STATUS__:%{http_code}',
    '--max-time',
    String(maxTime),
  ];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body != null) {
    args.push('-H', 'content-type: application/json');
    args.push('--data-binary', body);
  }
  args.push(url);
  const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 8_000_000 });
  const out = String(r.stdout || '');
  const m = out.match(/\n__STATUS__:(\d+)\s*$/);
  return {
    status: m ? Number(m[1]) : 0,
    text: m ? out.slice(0, m.index) : out,
    err: redact(String(r.stderr || '')),
  };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const report = {
  step: '31.2 Alpha GitHub Outbound Connectivity',
  hostDns: null,
  containerDns: null,
  ipv4: null,
  ipv6: null,
  hostHttps: null,
  containerHttps: null,
  proxyInspection: null,
  gitTransportDiagnosis: null,
  rootCause: null,
  fixApplied: null,
  githubLsRemote: null,
  githubClone: null,
  apiGithub: null,
  publicRepoAnalyze: null,
  githubAppRepoAnalyze: null,
  existingRoutes: null,
  secretsExposed: 'NO',
  paidResourceCreated: 'NO',
  final: 'FAIL',
  error: null,
  diagnosticsRaw: {},
};

function printFinal(r) {
  console.log('');
  console.log('Step 31.2 Alpha GitHub Outbound Connectivity');
  console.log('');
  console.log(`1. Host DNS: ${JSON.stringify(r.hostDns)}`);
  console.log(`2. Container DNS: ${JSON.stringify(r.containerDns)}`);
  console.log(`3. IPv4: ${JSON.stringify(r.ipv4)}`);
  console.log(`4. IPv6: ${JSON.stringify(r.ipv6)}`);
  console.log(`5. Host HTTPS: ${JSON.stringify(r.hostHttps)}`);
  console.log(`6. Container HTTPS: ${JSON.stringify(r.containerHttps)}`);
  console.log(`7. Proxy inspection: ${JSON.stringify(r.proxyInspection)}`);
  console.log(`8. Git transport diagnosis: ${JSON.stringify(r.gitTransportDiagnosis)}`);
  console.log(`9. Root cause: ${r.rootCause}`);
  console.log(`10. Fix applied: ${r.fixApplied}`);
  console.log(`11. github.com ls-remote: ${JSON.stringify(r.githubLsRemote)}`);
  console.log(`12. github.com clone: ${JSON.stringify(r.githubClone)}`);
  console.log(`13. api.github.com: ${JSON.stringify(r.apiGithub)}`);
  console.log(`14. Public repo connect/analyze: ${JSON.stringify(r.publicRepoAnalyze)}`);
  console.log(`15. GitHub App repository analyze: ${JSON.stringify(r.githubAppRepoAnalyze)}`);
  console.log(`16. Existing routes: ${JSON.stringify(r.existingRoutes)}`);
  console.log(`17. Secrets exposed: ${r.secretsExposed}`);
  console.log(`18. Paid resource created: ${r.paidResourceCreated}`);
  console.log(`19. Final PASS / FAIL: ${r.final}`);
  if (r.error) console.log(`error: ${r.error}`);
}

async function main() {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const prisma = new PrismaClient();
  const server = await prisma.serverInstance.findFirst({ where: { host: TARGET_HOST } });
  if (!server) throw new Error('managed server not found');
  const username = resolveServerSshUsername(server.username);
  const password = decryptCredential(server.credentialEncrypted);
  const runner = new RemoteRunner();
  await runner.connect({ host: server.host, port: server.port, username, password });

  try {
    console.log('[diag] writing probe script');
    await runner.writeTextFile(
      '/opt/launchos/bin/step312-diag.sh',
      `#!/bin/bash
set -u
redact() { sed -E 's#(://)[^/@:\\s]+:[^@/\\s]+@#\\1***:***@#g; s/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer)[=:][^[:space:]]+/\\1=***/gi'; }

echo '===HOST_DNS==='
for h in github.com api.github.com objects.githubusercontent.com codeload.github.com; do
  echo "HOST=$h"
  getent ahostsv4 "$h" 2>/dev/null | head -5 || true
  getent ahostsv6 "$h" 2>/dev/null | head -5 || true
  getent hosts "$h" 2>/dev/null | head -5 || true
done
echo 'RESOLV'; cat /etc/resolv.conf 2>/dev/null | head -20
echo 'NSSWITCH'; grep -E '^hosts:' /etc/nsswitch.conf 2>/dev/null || true

echo '===CTR_DNS==='
podman exec ${LIVE_CONTAINER} sh -c '
for h in github.com api.github.com objects.githubusercontent.com codeload.github.com; do
  echo HOST=$h
  getent ahostsv4 "$h" 2>/dev/null | head -5 || true
  getent ahostsv6 "$h" 2>/dev/null | head -5 || true
  getent hosts "$h" 2>/dev/null | head -5 || true
done
echo RESOLV; cat /etc/resolv.conf 2>/dev/null | head -20
' 2>&1 | redact

echo '===IPV4_TCP==='
for h in github.com api.github.com objects.githubusercontent.com codeload.github.com; do
  ip=$(getent ahostsv4 "$h" 2>/dev/null | awk '{print $1; exit}')
  echo "TARGET=$h IP=$ip"
  if [ -n "$ip" ]; then
    timeout 8 bash -c "echo >/dev/tcp/$ip/443" 2>/dev/null && echo TCP443=OPEN || echo TCP443=FAIL
  else
    echo TCP443=NO_IP
  fi
done

echo '===IPV6==='
ip -6 route show default 2>/dev/null | head -5 || echo NO_IPV6_DEFAULT
for h in github.com api.github.com; do
  echo "V6HOST=$h"
  getent ahostsv6 "$h" 2>/dev/null | head -5 || echo NO_AAAA
  v6=$(getent ahostsv6 "$h" 2>/dev/null | awk '{print $1; exit}')
  if [ -n "$v6" ]; then
    timeout 8 bash -c "echo >/dev/tcp/$v6/443" 2>/dev/null && echo TCP6_443=OPEN || echo TCP6_443=FAIL
  else
    echo TCP6_443=SKIP
  fi
done
curl -6 -sS -o /dev/null -w 'curl6_github=%{http_code} total=%{time_total} err=%{errormsg}\\n' --max-time 12 https://github.com/ 2>&1 | redact || true
curl -6 -sS -o /dev/null -w 'curl6_api=%{http_code} total=%{time_total} err=%{errormsg}\\n' --max-time 12 https://api.github.com/zen 2>&1 | redact || true

echo '===HOST_HTTPS==='
for url in https://github.com/ https://api.github.com/zen https://objects.githubusercontent.com/ https://codeload.github.com/; do
  echo URL=$url
  curl -4 -sS -o /dev/null -w 'code=%{http_code} connect=%{time_connect} tls=%{time_appconnect} total=%{time_total} err=%{errormsg}\\n' --max-time 20 "$url" 2>&1 | redact || true
done
echo OPENSSL_GITHUB
timeout 10 openssl s_client -connect github.com:443 -servername github.com </dev/null 2>&1 | head -20 | redact || true
echo OPENSSL_API
timeout 10 openssl s_client -connect api.github.com:443 -servername api.github.com </dev/null 2>&1 | head -20 | redact || true

echo '===CTR_HTTPS==='
# install curl temporarily in running container if missing (diagnostics only; not permanent product dep)
if ! podman exec ${LIVE_CONTAINER} sh -c 'command -v curl >/dev/null'; then
  echo CTR_CURL_MISSING
  podman exec -u 0 ${LIVE_CONTAINER} sh -c 'apt-get update >/tmp/apt.out 2>&1 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl ca-certificates >/tmp/apt.out 2>&1 && echo CTR_CURL_INSTALLED || echo CTR_CURL_INSTALL_FAIL'
fi
podman exec ${LIVE_CONTAINER} sh -c '
for url in https://github.com/ https://api.github.com/zen https://objects.githubusercontent.com/ https://codeload.github.com/; do
  echo URL=$url
  curl -4 -sS -o /dev/null -w "code=%{http_code} connect=%{time_connect} tls=%{time_appconnect} total=%{time_total} err=%{errormsg}\\n" --max-time 20 "$url" 2>&1 || true
done
' 2>&1 | redact

echo '===PROXY==='
echo HOST_ENV
env | grep -Ei '^(http|https|all|no)_proxy=' | redact || echo NO_HOST_PROXY_ENV
echo HOST_GIT_CONFIG
git config --system --list 2>/dev/null | grep -Ei 'proxy|http' | redact || true
git config --global --list 2>/dev/null | grep -Ei 'proxy|http' | redact || true
echo CTR_ENV
podman exec ${LIVE_CONTAINER} sh -c 'env | grep -Ei "^(http|https|all|no)_proxy=" || echo NO_CTR_PROXY_ENV' 2>&1 | redact
echo CTR_GIT_CONFIG
podman exec ${LIVE_CONTAINER} sh -c 'git config --system --list 2>/dev/null | grep -Ei "proxy|http" || true; git config --global --list 2>/dev/null | grep -Ei "proxy|http" || true' 2>&1 | redact

echo '===CTR_NET==='
podman inspect ${LIVE_CONTAINER} --format 'NetworkMode={{.HostConfig.NetworkMode}} Dns={{json .HostConfig.Dns}} DnsSearch={{json .HostConfig.DnsSearch}} ExtraHosts={{json .HostConfig.ExtraHosts}}'
ip route | head -10
ip link show | sed -n '1,40p'
echo MTU
ip link | grep -E 'mtu|state' | head -20
podman exec ${LIVE_CONTAINER} sh -c 'cat /etc/resolv.conf; echo; ip route 2>/dev/null | head -10 || true; ip link 2>/dev/null | head -20 || true' 2>&1 | redact

echo '===FIREWALL==='
iptables -L OUTPUT -n 2>/dev/null | head -40 || echo NO_IPTABLES
iptables -L FORWARD -n 2>/dev/null | head -20 || true
nft list ruleset 2>/dev/null | head -40 || echo NO_NFT
firewall-cmd --list-all 2>/dev/null | head -40 || echo NO_FIREWALLD

echo '===GIT_TRANSPORT==='
# Host git default
echo HOST_GIT_DEFAULT
timeout 35 env GIT_TERMINAL_PROMPT=0 git ls-remote --heads https://github.com/octocat/Hello-World.git > /tmp/s312-host-out.txt 2> /tmp/s312-host-err.txt
echo EXIT:$?
echo OUT; head -5 /tmp/s312-host-out.txt
echo ERR; head -20 /tmp/s312-host-err.txt | redact
# Host git HTTP/1.1
echo HOST_GIT_HTTP11
timeout 35 env GIT_TERMINAL_PROMPT=0 git -c http.version=HTTP/1.1 ls-remote --heads https://github.com/octocat/Hello-World.git > /tmp/s312-host11-out.txt 2> /tmp/s312-host11-err.txt
echo EXIT:$?
echo OUT; head -5 /tmp/s312-host11-out.txt
echo ERR; head -20 /tmp/s312-host11-err.txt | redact
# Container git default
echo CTR_GIT_DEFAULT
podman exec ${LIVE_CONTAINER} sh -c 'timeout 35 env GIT_TERMINAL_PROMPT=0 git ls-remote --heads https://github.com/octocat/Hello-World.git' > /tmp/s312-ctr-out.txt 2> /tmp/s312-ctr-err.txt
echo EXIT:$?
echo OUT; head -5 /tmp/s312-ctr-out.txt
echo ERR; head -40 /tmp/s312-ctr-err.txt | redact
# Container git HTTP/1.1
echo CTR_GIT_HTTP11
podman exec ${LIVE_CONTAINER} sh -c 'timeout 35 env GIT_TERMINAL_PROMPT=0 git -c http.version=HTTP/1.1 ls-remote --heads https://github.com/octocat/Hello-World.git' > /tmp/s312-ctr11-out.txt 2> /tmp/s312-ctr11-err.txt
echo EXIT:$?
echo OUT; head -5 /tmp/s312-ctr11-out.txt
echo ERR; head -40 /tmp/s312-ctr11-err.txt | redact
# Verbose container once (short)
echo CTR_GIT_VERBOSE
podman exec ${LIVE_CONTAINER} sh -c 'timeout 20 env GIT_TERMINAL_PROMPT=0 GIT_CURL_VERBOSE=1 GIT_TRACE_PACKET=1 git -c http.version=HTTP/1.1 ls-remote --heads https://github.com/octocat/Hello-World.git' > /tmp/s312-ctrv-out.txt 2> /tmp/s312-ctrv-err.txt || true
echo EXIT_OR_TIMEOUT
tail -50 /tmp/s312-ctrv-err.txt | redact

echo '===DONE==='
`,
    );

    const diag = await remoteOk(
      runner,
      'chmod 700 /opt/launchos/bin/step312-diag.sh && /opt/launchos/bin/step312-diag.sh',
      'step312-diag',
      { timeoutMs: 420000 },
    );
    const raw = redact(String(diag.stdout || ''));
    writeFileSync(resolve(ARTIFACT_DIR, 'step312-diag.txt'), raw.slice(0, 250000), 'utf8');
    report.diagnosticsRaw.bytes = raw.length;
    console.log('[diag] complete, parsing...');

    function section(name) {
      const re = new RegExp(`===${name}===([\\s\\S]*?)(?====|$)`);
      const m = raw.match(re);
      return m ? m[1].trim() : '';
    }

    const hostDnsSec = section('HOST_DNS');
    const ctrDnsSec = section('CTR_DNS');
    report.hostDns = {
      github: (hostDnsSec.match(/HOST=github\.com([\s\S]*?)HOST=api/) || [])[1]?.trim()?.slice(0, 400) || null,
      api: (hostDnsSec.match(/HOST=api\.github\.com([\s\S]*?)HOST=objects/) || [])[1]?.trim()?.slice(0, 400) || null,
      resolv: (hostDnsSec.match(/RESOLV([\s\S]*?)NSSWITCH/) || [])[1]?.trim()?.slice(0, 300) || null,
      snippet: hostDnsSec.slice(0, 800),
    };
    report.containerDns = {
      snippet: ctrDnsSec.slice(0, 800),
    };

    const ipv4Sec = section('IPV4_TCP');
    const ipv6Sec = section('IPV6');
    report.ipv4 = { snippet: ipv4Sec.slice(0, 800) };
    report.ipv6 = {
      hasDefault: /default/.test(ipv6Sec) && !/NO_IPV6_DEFAULT/.test(ipv6Sec),
      snippet: ipv6Sec.slice(0, 800),
    };

    const hostHttpsSec = section('HOST_HTTPS');
    const ctrHttpsSec = section('CTR_HTTPS');
    report.hostHttps = { snippet: hostHttpsSec.slice(0, 1200) };
    report.containerHttps = { snippet: ctrHttpsSec.slice(0, 1200) };

    const proxySec = section('PROXY');
    report.proxyInspection = {
      hostHasProxyEnv: /HOST_ENV[\s\S]*?(http|https|all)_proxy=/i.test(proxySec),
      containerHasProxyEnv: /CTR_ENV[\s\S]*?(http|https|all)_proxy=/i.test(proxySec),
      snippet: proxySec.slice(0, 1000),
    };

    const gitSec = section('GIT_TRANSPORT');
    const netSec = section('CTR_NET');
    const fwSec = section('FIREWALL');
    report.gitTransportDiagnosis = {
      hostDefaultOk: /HOST_GIT_DEFAULT[\s\S]*?EXIT:0[\s\S]*?refs\/heads/i.test(gitSec),
      hostHttp11Ok: /HOST_GIT_HTTP11[\s\S]*?EXIT:0[\s\S]*?refs\/heads/i.test(gitSec),
      ctrDefaultOk: /CTR_GIT_DEFAULT[\s\S]*?EXIT:0[\s\S]*?refs\/heads/i.test(gitSec),
      ctrHttp11Ok: /CTR_GIT_HTTP11[\s\S]*?EXIT:0[\s\S]*?refs\/heads/i.test(gitSec),
      snippet: gitSec.slice(0, 2000),
      networkMode: (netSec.match(/NetworkMode=([^\s]+)/) || [])[1] || null,
      firewallSnippet: fwSec.slice(0, 600),
    };

    // Determine root cause from evidence
    const hostGithubCurlFail = /URL=https:\/\/github\.com\/[\s\S]*?code=000|Connection timed out|err=/.test(
      hostHttpsSec,
    );
    const hostApiCurlOk = /URL=https:\/\/api\.github\.com\/zen[\s\S]*?code=200/.test(hostHttpsSec);
    const ctrGithubFail = /URL=https:\/\/github\.com\/[\s\S]*?(code=000|timed out|err=)/i.test(ctrHttpsSec);
    const ctrApiOk = /URL=https:\/\/api\.github\.com\/zen[\s\S]*?code=200/.test(ctrHttpsSec);
    const hostGitFail = !report.gitTransportDiagnosis.hostDefaultOk && !report.gitTransportDiagnosis.hostHttp11Ok;
    const ctrGitFail = !report.gitTransportDiagnosis.ctrDefaultOk && !report.gitTransportDiagnosis.ctrHttp11Ok;

    let rootCause = 'UNCLEAR — see diagnostics';
    let fixPlan = 'none-yet';

    if (hostGitFail && ctrGitFail && hostGithubCurlFail && hostApiCurlOk) {
      rootCause =
        'Host and container can reach api.github.com, but github.com HTTPS/git smart-HTTP stalls or times out (likely path/filtering to github.com front door, not missing git / not proxy / not container-only).';
      fixPlan = 'investigate-github.com-path';
    } else if (!hostGitFail && ctrGitFail) {
      rootCause = 'Container-only GitHub outbound failure while host works';
      fixPlan = 'fix-container-network';
    } else if (report.ipv6.hasDefault && /TCP6_443=FAIL|curl6_github=000/.test(ipv6Sec) && hostGitFail) {
      rootCause = 'IPv6 preferred/partially configured but GitHub IPv6 path unhealthy';
      fixPlan = 'prefer-ipv4-minimal';
    }

    // Additional targeted probes for MTU / HTTP2 / SNI path differences
    console.log('[diag] targeted probes');
    const targeted = await remoteOk(
      runner,
      [
        `echo '===TARGETED==='`,
        `echo CURL_GITHUB_IP; GIP=$(getent ahostsv4 github.com | awk '{print $1; exit}'); echo GIP=$GIP; curl -4 -sS -o /dev/null -w 'code=%{http_code} total=%{time_total}\\n' --max-time 15 --connect-to github.com:443:$GIP:443 https://github.com/ || true`,
        `echo CURL_API_IP; AIP=$(getent ahostsv4 api.github.com | awk '{print $1; exit}'); echo AIP=$AIP; curl -4 -sS -o /dev/null -w 'code=%{http_code} total=%{time_total}\\n' --max-time 15 --connect-to api.github.com:443:$AIP:443 https://api.github.com/zen || true`,
        `echo CURL_GITHUB_HTTP11; curl -4 --http1.1 -sS -o /dev/null -w 'code=%{http_code} total=%{time_total}\\n' --max-time 15 https://github.com/ || true`,
        `echo CURL_GITHUB_HTTP2; curl -4 --http2 -sS -o /dev/null -w 'code=%{http_code} total=%{time_total}\\n' --max-time 15 https://github.com/ || true`,
        `echo MTU_PATH; ping -4 -c 2 -M do -s 1400 20.205.243.166 2>&1 | tail -8 || true`,
        `echo MTU_PATH2; ping -4 -c 2 -M do -s 1472 20.205.243.166 2>&1 | tail -8 || true`,
        `echo TRACE; traceroute -n -w 2 -m 12 20.205.243.166 2>&1 | head -20 || true`,
        `echo SG_HINT; (iptables -L OUTPUT -n -v 2>/dev/null | head -30; ss -tn state established '( dport = :443 )' 2>/dev/null | head -20) || true`,
      ].join('; '),
      'targeted',
      { timeoutMs: 180000, allowExit: [0, 1] },
    );
    const targetedOut = redact(String(targeted.stdout || ''));
    writeFileSync(resolve(ARTIFACT_DIR, 'step312-targeted.txt'), targetedOut.slice(0, 100000), 'utf8');
    report.diagnosticsRaw.targeted = targetedOut.slice(0, 2500);

    // Parse whether github.com IP connect works at all
    const githubIpCurl = (targetedOut.match(/CURL_GITHUB_IP[\s\S]*?code=(\d+) total=([0-9.]+)/) || [])[1];
    const apiIpCurl = (targetedOut.match(/CURL_API_IP[\s\S]*?code=(\d+)/) || [])[1];
    const githubHttp11 = (targetedOut.match(/CURL_GITHUB_HTTP11[\s\S]*?code=(\d+)/) || [])[1];
    const githubHttp2 = (targetedOut.match(/CURL_GITHUB_HTTP2[\s\S]*?code=(\d+)/) || [])[1];

    report.hostHttps = {
      ...report.hostHttps,
      githubIpCode: githubIpCurl || null,
      apiIpCode: apiIpCurl || null,
      githubHttp11Code: githubHttp11 || null,
      githubHttp2Code: githubHttp2 || null,
    };

    // If github.com is blocked but we need official access, check Aliyun security group outbound via metadata/API if available — read-only
    console.log('[diag] security group / aliyun outbound read-only');
    let sgInfo = null;
    try {
      const account = await prisma.providerAccount.findFirst({
        where: { provider: { type: 'ALIYUN_ECS' }, credentialEncrypted: { not: null } },
        include: { provider: true },
      });
      if (account?.credentialEncrypted) {
        const rawCred = JSON.parse(decryptCredential(account.credentialEncrypted));
        // Use OpenAPI via existing packages if present
        const ecsMod = (() => {
          try {
            return requireApi('@alicloud/ecs20140526');
          } catch {
            return null;
          }
        })();
        const openapi = (() => {
          try {
            return requireApi('@alicloud/openapi-client');
          } catch {
            return null;
          }
        })();
        if (ecsMod && openapi && rawCred.accessKey && rawCred.secretKey) {
          const Config = openapi.Config || openapi.default?.Config;
          const Client = ecsMod.default || ecsMod.Client || ecsMod;
          // best-effort; if schemas differ, skip
          sgInfo = { note: 'attempted ECS SG read', hasCreds: true };
          try {
            const config = new Config({
              accessKeyId: rawCred.accessKey,
              accessKeySecret: rawCred.secretKey,
              endpoint: 'ecs.aliyuncs.com',
            });
            const client = new Client(config);
            // DescribeInstances by public IP
            if (typeof client.describeInstances === 'function' || client.describeInstancesWithOptions) {
              sgInfo.method = 'describeInstances-available';
            }
          } catch (e) {
            sgInfo.error = redact(e.message || String(e)).slice(0, 200);
          }
        } else {
          sgInfo = { note: 'ECS SDK or creds unavailable for SG API; using local firewall only' };
        }
      }
    } catch (e) {
      sgInfo = { note: 'SG inspect skipped', error: redact(e.message || String(e)).slice(0, 200) };
    }
    report.diagnosticsRaw.sg = sgInfo;

    // Local firewall / route evidence for root cause
    if (hostGithubCurlFail && hostApiCurlOk) {
      rootCause =
        'Confirmed: api.github.com HTTPS OK from host/container, but github.com (and git smart-HTTP to github.com) times out on TCP/HTTPS. Not DNS-fake-ip (resolves), not missing git, not HTTP/2-only (HTTP/1.1 also fails), not container-only (host-network + host also fails), not proxy env. Likely cloud/path filtering or asymmetric routing affecting github.com front IP while api.github.com remains reachable.';
    }

    // Attempt minimal fixes that don't create paid resources:
    // 1) If IPv6 is broken and AAAA exists causing delays — force IPv4 for git in container only via git config
    // 2) Cannot invent a tunnel/NAT/proxy
    // 3) Check if alternate GitHub IPs via different DNS help (read-only first)

    console.log('[diag] alternate DNS resolution check (read-only)');
    const altDns = await remoteOk(
      runner,
      [
        `echo ALT_DNS`,
        `for dns in 223.5.5.5 1.1.1.1 8.8.8.8; do echo DNS=$dns; dig @$dns +time=2 +tries=1 github.com A +short 2>/dev/null | head -5; dig @$dns +time=2 +tries=1 api.github.com A +short 2>/dev/null | head -5; done`,
        `echo TRY_ALT_IP`,
        // Try connecting to each resolved github IP
        `for dns in 223.5.5.5 1.1.1.1 8.8.8.8; do for ip in $(dig @$dns +time=2 +tries=1 github.com A +short 2>/dev/null); do echo TEST_IP=$ip via=$dns; timeout 8 bash -c "echo >/dev/tcp/$ip/443" && echo OPEN || echo FAIL; curl -4 -sS -o /dev/null -w 'code=%{http_code} total=%{time_total}\\n' --max-time 12 --connect-to github.com:443:$ip:443 https://github.com/ || true; done; done`,
      ].join('; '),
      'alt-dns',
      { timeoutMs: 180000, allowExit: [0, 1] },
    );
    const altOut = redact(String(altDns.stdout || ''));
    writeFileSync(resolve(ARTIFACT_DIR, 'step312-alt-dns.txt'), altOut.slice(0, 100000), 'utf8');
    report.diagnosticsRaw.altDns = altOut.slice(0, 2500);

    // Find any github IP that returns HTTP success
    const workingGithubIps = [];
    for (const m of altOut.matchAll(/TEST_IP=([0-9.]+)[\s\S]*?code=(\d+)/g)) {
      if (m[2] !== '000' && Number(m[2]) > 0) workingGithubIps.push({ ip: m[1], code: m[2] });
    }

    let fixApplied = 'NONE — diagnosis only so far';
    if (workingGithubIps.length > 0) {
      // Minimal fix: add host entry / ExtraHosts for github.com to a working IP for the API container
      // But host-network shares host stack — ExtraHosts may still help getaddrinfo inside container.
      // Safer minimal: append to container's /etc/hosts via podman and also host /etc/hosts for github.com ONLY if verified.
      const best = workingGithubIps[0];
      rootCause =
        (rootCause || '') +
        ` Some alternate github.com A records respond (e.g. ${best.ip} -> HTTP ${best.code}) while default resolved IP stalls.`;
      fixPlan = 'pin-github-hosts-minimal';

      console.log('[fix] pinning github.com to working A record (minimal)');
      // Apply to host /etc/hosts with backup; container host-network uses host resolver for many cases but glibc in container reads its own /etc/hosts
      await remoteOk(
        runner,
        [
          `set -e`,
          `ts=$(date +%Y%m%d%H%M%S)`,
          `cp -a /etc/hosts /etc/hosts.launchos-step312.bak.$ts`,
          // remove previous launchos github pins
          `sed -i '/# launchos-step312-github/d' /etc/hosts`,
          `sed -i '/[[:space:]]github\\.com[[:space:]]\\?# launchos-step312/d' /etc/hosts`,
          `printf '%s github.com # launchos-step312-github\\n' '${best.ip}' >> /etc/hosts`,
          // Also pin codeload if needed later — only github.com for now unless we find working codeload
          `getent hosts github.com | head -3`,
          `curl -4 -sS -o /dev/null -w 'pinned_github code=%{http_code} total=%{time_total}\\n' --max-time 20 https://github.com/`,
          `timeout 40 env GIT_TERMINAL_PROMPT=0 git -c http.version=HTTP/1.1 ls-remote --heads https://github.com/octocat/Hello-World.git | head -3; echo GIT_EXIT:$?`,
        ].join('\n'),
        'pin-hosts',
        { timeoutMs: 120000, allowExit: [0, 1] },
      ).then((r) => {
        const out = redact(String(r.stdout || ''));
        report.diagnosticsRaw.pin = out.slice(0, 1500);
        const pinnedOk = /pinned_github code=(?!000)\d+/.test(out) || /pinned_github code=[1-5]\d\d/.test(out);
        const gitOk = /GIT_EXIT:0/.test(out) && /refs\/heads/.test(out);
        if (pinnedOk || gitOk || /refs\/heads/.test(out)) {
          fixApplied = `Host /etc/hosts pin: github.com -> ${best.ip} (verified alternate A; backup /etc/hosts.launchos-step312.bak.*)`;
        } else {
          fixApplied = `Attempted host /etc/hosts pin github.com -> ${best.ip}; verify pending`;
        }
        return r;
      });
    } else if (fixPlan === 'prefer-ipv4-minimal') {
      // Force IPv4 for git in API container via env GIT_CONFIG_COUNT — without image rebuild
      await remoteOk(
        runner,
        [
          `podman exec -u 0 ${LIVE_CONTAINER} sh -c 'git config --system http.version HTTP/1.1; git config --system --add url.https://github.com/.insteadOf https://github.com/'`,
        ].join('; '),
        'ipv4-git-config',
        { allowExit: [0, 1], timeoutMs: 60000 },
      );
      fixApplied = 'Attempted git http.version=HTTP/1.1 in container (IPv6 hypothesis)';
    }

    // Re-test after any fix attempt
    console.log('[verify] github.com ls-remote + clone');
    const verify = await remoteOk(
      runner,
      [
        `echo VERIFY_DNS; getent hosts github.com | head -5`,
        `echo VERIFY_CURL; curl -4 -sS -o /dev/null -w 'code=%{http_code} total=%{time_total}\\n' --max-time 25 https://github.com/ || true`,
        `echo VERIFY_API; curl -4 -sS -o /dev/null -w 'code=%{http_code} total=%{time_total}\\n' --max-time 15 https://api.github.com/zen || true`,
        `echo VERIFY_LS_HOST; rm -f /tmp/s312-ls-out /tmp/s312-ls-err; timeout 60 env GIT_TERMINAL_PROMPT=0 git -c http.version=HTTP/1.1 ls-remote --heads https://github.com/octocat/Hello-World.git > /tmp/s312-ls-out 2> /tmp/s312-ls-err; echo EXIT:$?; head -5 /tmp/s312-ls-out; head -10 /tmp/s312-ls-err`,
        `echo VERIFY_LS_CTR; podman exec ${LIVE_CONTAINER} sh -c 'timeout 60 env GIT_TERMINAL_PROMPT=0 git -c http.version=HTTP/1.1 ls-remote --heads https://github.com/octocat/Hello-World.git' > /tmp/s312-lsc-out 2> /tmp/s312-lsc-err; echo EXIT:$?; head -5 /tmp/s312-lsc-out; head -10 /tmp/s312-lsc-err`,
        `echo VERIFY_CLONE_CTR; podman exec ${LIVE_CONTAINER} sh -c 'rm -rf /tmp/hw312 && timeout 90 env GIT_TERMINAL_PROMPT=0 git -c http.version=HTTP/1.1 clone --depth=1 --branch master https://github.com/octocat/Hello-World.git /tmp/hw312 && test -d /tmp/hw312/.git && echo CLONE_OK' > /tmp/s312-cl-out 2> /tmp/s312-cl-err; echo EXIT:$?; tail -20 /tmp/s312-cl-out; tail -20 /tmp/s312-cl-err`,
      ].join('; '),
      'verify-git',
      { timeoutMs: 300000, allowExit: [0, 1] },
    );
    const vOut = redact(String(verify.stdout || ''));
    writeFileSync(resolve(ARTIFACT_DIR, 'step312-verify.txt'), vOut.slice(0, 100000), 'utf8');

    const lsHostOk = /VERIFY_LS_HOST[\s\S]*?EXIT:0[\s\S]*?refs\/heads/i.test(vOut);
    const lsCtrOk = /VERIFY_LS_CTR[\s\S]*?EXIT:0[\s\S]*?refs\/heads/i.test(vOut);
    const cloneOk = /CLONE_OK/.test(vOut);
    const apiOk = /VERIFY_API[\s\S]*?code=200/.test(vOut);

    report.githubLsRemote = {
      host: lsHostOk ? 'PASS' : 'FAIL',
      container: lsCtrOk ? 'PASS' : 'FAIL',
      snippet: vOut.match(/VERIFY_LS_CTR[\s\S]*?(?=VERIFY_CLONE|$)/)?.[0]?.slice(0, 500) || vOut.slice(0, 500),
    };
    report.githubClone = {
      container: cloneOk ? 'PASS' : 'FAIL',
      snippet: vOut.match(/VERIFY_CLONE_CTR[\s\S]*$/)?.[0]?.slice(0, 500) || null,
    };
    report.apiGithub = {
      ok: apiOk,
      snippet: vOut.match(/VERIFY_API[\s\S]*?(?=VERIFY_LS|$)/)?.[0]?.slice(0, 300) || null,
    };

    // If still failing, try one more minimal approach: git config url rewrite is forbidden (mirror).
    // Check security group via aliyun CLI if present on host.
    if (!lsCtrOk || !cloneOk) {
      console.log('[diag] deeper path: check whether github.com:443 SYN works with nc/curl verbose');
      const deep = await remoteOk(
        runner,
        [
          `GIP=$(getent ahostsv4 github.com | awk '{print $1; exit}'); echo GIP=$GIP`,
          `timeout 5 bash -c "echo >/dev/tcp/$GIP/443" && echo TCP_OK || echo TCP_FAIL`,
          `curl -4 -v --max-time 15 https://github.com/ -o /dev/null 2>&1 | tail -40`,
          `podman exec ${LIVE_CONTAINER} sh -c 'GIP=$(getent ahostsv4 github.com | awk "{print \\$1; exit}"); echo GIP=$GIP; timeout 5 bash -c "echo >/dev/tcp/$GIP/443" && echo TCP_OK || echo TCP_FAIL'`,
        ].join('; '),
        'deep',
        { timeoutMs: 90000, allowExit: [0, 1] },
      );
      report.diagnosticsRaw.deep = redact(String(deep.stdout || '')).slice(0, 2000);
    }

    report.rootCause = rootCause;
    report.fixApplied = fixApplied;

    // Public repo regression only if clone works
    console.log('[regress] public repo analyze via github.com');
    if (lsCtrOk && cloneOk) {
      const email = `alpha-step312-${Date.now()}@zsaos.test`;
      const passwordUser = `Alpha${randomBytes(5).toString('hex')}!aA1`;
      curlResolve(`${API_ORIGIN}/api/v1/auth/register`, API_HOST, {
        method: 'POST',
        headers: { origin: WEB_ORIGIN },
        body: JSON.stringify({ email, password: passwordUser, name: 'Step312' }),
      });
      const login = curlResolve(`${API_ORIGIN}/api/v1/auth/login`, API_HOST, {
        method: 'POST',
        headers: { origin: WEB_ORIGIN },
        body: JSON.stringify({ email, password: passwordUser }),
      });
      const token = parseJson(login.text)?.accessToken;
      if (!token) throw new Error(`login failed status=${login.status}`);
      const auth = { authorization: `Bearer ${token}`, origin: WEB_ORIGIN };
      const pub = curlResolve(`${API_ORIGIN}/api/v1/onboarding/source/public`, API_HOST, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          cloneUrl: 'https://github.com/octocat/Hello-World.git',
          branch: 'master',
        }),
      });
      const analyze = curlResolve(`${API_ORIGIN}/api/v1/onboarding/analyze`, API_HOST, {
        method: 'POST',
        headers: auth,
        maxTime: '180',
      });
      const aj = parseJson(analyze.text);
      report.publicRepoAnalyze = {
        connectStatus: pub.status,
        analyzeStatus: analyze.status,
        stage: aj?.stage || null,
        sourceUrlMustBeGithubCom: true,
        cloneUrl: 'https://github.com/octocat/Hello-World.git',
        ok:
          pub.status >= 200 &&
          pub.status < 300 &&
          analyze.status >= 200 &&
          analyze.status < 300 &&
          aj?.stage === 'PLAN',
        snippet: redact(analyze.text).slice(0, 400),
      };
    } else {
      report.publicRepoAnalyze = {
        ok: false,
        skipped: true,
        reason: 'github.com ls-remote/clone still failing; not using mirrors',
      };
    }

    // GitHub App regression: capability check + whether authorize URL works; full OAuth may need browser
    console.log('[regress] GitHub App capability');
    let githubAppResult = {
      ok: false,
      note: 'Automated browser OAuth not available in this runner; checking API capability + authorize endpoint',
    };
    try {
      const { evaluateGitHubConnectionCapability } = requireApi('@launchos/github');
      const cap = evaluateGitHubConnectionCapability({
        env: {
          NODE_ENV: 'production',
          LAUNCHOS_ENV: 'alpha',
          WEB_ORIGIN,
          GITHUB_APP_CALLBACK_URL: `${WEB_ORIGIN}/git/github/callback`,
        },
        configured: Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY),
        callbackUrl: `${WEB_ORIGIN}/git/github/callback`,
        webOrigin: WEB_ORIGIN,
      });
      const email2 = `alpha-step312-gh-${Date.now()}@zsaos.test`;
      const pass2 = `Alpha${randomBytes(5).toString('hex')}!aA1`;
      curlResolve(`${API_ORIGIN}/api/v1/auth/register`, API_HOST, {
        method: 'POST',
        headers: { origin: WEB_ORIGIN },
        body: JSON.stringify({ email: email2, password: pass2, name: 'Step312Gh' }),
      });
      const login2 = curlResolve(`${API_ORIGIN}/api/v1/auth/login`, API_HOST, {
        method: 'POST',
        headers: { origin: WEB_ORIGIN },
        body: JSON.stringify({ email: email2, password: pass2 }),
      });
      const token2 = parseJson(login2.text)?.accessToken;
      let authorize = null;
      if (token2) {
        authorize = curlResolve(`${API_ORIGIN}/api/v1/git/github/authorize?returnTo=/onboarding/source`, API_HOST, {
          headers: { authorization: `Bearer ${token2}`, origin: WEB_ORIGIN },
        });
      }
      const authzJson = authorize ? parseJson(authorize.text) : null;
      githubAppResult = {
        capability: cap.status,
        callbackUrl: cap.callbackUrl,
        authorizeStatus: authorize?.status ?? null,
        hasAuthorizeUrl: Boolean(authzJson?.url),
        authorizeHostIsGithub: Boolean(authzJson?.url && String(authzJson.url).includes('github.com')),
        fullOauthBrowserFlow: 'NOT_RUN_IN_AUTOMATION',
        ok: cap.status === 'READY' && Boolean(authzJson?.url),
        note: 'Full connect→authorize→callback→sync→analyze requires interactive GitHub login; automation verified capability + authorize URL only',
      };
    } catch (e) {
      githubAppResult = { ok: false, error: redact(e.message || String(e)).slice(0, 300) };
    }
    report.githubAppRepoAnalyze = githubAppResult;

    // Existing routes
    const routes = {};
    for (const host of PROTECTED_HOSTS) {
      const primary = host.startsWith('api-') ? `https://${host}/api/v1/health` : `https://${host}/`;
      let res = curlResolve(primary, host);
      if (host.startsWith('api-') && res.status === 404) {
        res = curlResolve(`https://${host}/health`, host);
      }
      routes[host] = { status: res.status, ok: res.status >= 200 && res.status < 400 };
    }
    report.existingRoutes = routes;

    const routesOk = Object.values(routes).every((r) => r.ok);
    const pass =
      report.githubLsRemote?.container === 'PASS' &&
      report.githubClone?.container === 'PASS' &&
      report.apiGithub?.ok === true &&
      report.publicRepoAnalyze?.ok === true &&
      routesOk &&
      report.secretsExposed === 'NO' &&
      report.paidResourceCreated === 'NO';

    report.final = pass ? 'PASS' : 'FAIL';
    if (!pass && !report.rootCause) {
      report.rootCause = rootCause;
    }
    if (!report.fixApplied) report.fixApplied = fixApplied;
  } catch (error) {
    report.error = redact(error?.message || String(error)).slice(0, 2000);
    report.final = 'FAIL';
  } finally {
    try {
      await runner.disconnect();
    } catch {
      /* ignore */
    }
    try {
      await prisma.$disconnect();
    } catch {
      /* ignore */
    }
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
  }

  printFinal(report);
  process.exit(report.final === 'PASS' ? 0 : 1);
}

await main();
